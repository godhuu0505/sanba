"""GitHub App 連携（/api/github/*）とセッション repo 選択（main.py から分割 / 挙動不変）。"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sanba_shared.models import GitHubIndexStatus, GitHubLink

from .. import github_export
from ..auth import SessionAccess
from ..auth_google import AuthUser, require_user
from ..config import settings
from ..deps import (
    SelectRepoRequest,
    SessionGitHubResponse,
    _github_app_client,
    _github_repo_allowed,
    _indexer,
    _repo,
    require_session_access,
)
from ..github_app import (
    InvalidLinkState,
    create_link_state,
    redact_secrets,
    verify_link_state,
)
from ..pii import mask_pii
from ..repo_indexing import fetch_and_index_repo

log = structlog.get_logger(__name__)

router = APIRouter()


# ---- GitHub App: per-user repo linking (ADR-0028) --------------------------


class GitHubLinkStatus(BaseModel):
    linked: bool
    github_login: str | None = None


class GitHubLinkStart(BaseModel):
    install_url: str


class GitHubRepoItem(BaseModel):
    full_name: str
    default_branch: str
    private: bool


class GitHubBranchItem(BaseModel):
    name: str
    sha: str


class GitHubBranchesResponse(BaseModel):
    items: list[GitHubBranchItem]


@router.get("/api/github/link", response_model=GitHubLinkStatus)
def github_link_status(user: AuthUser = Depends(require_user)) -> GitHubLinkStatus:
    """本人の GitHub 連携状態を返す（設定画面の表示用）。"""
    link = _repo.get_github_link(user.sub)
    return GitHubLinkStatus(
        linked=link is not None,
        github_login=link.github_login if link else None,
    )


@router.post("/api/github/link/start", response_model=GitHubLinkStart)
def github_link_start(user: AuthUser = Depends(require_user)) -> GitHubLinkStart:
    """連携開始: 署名 state 付きの GitHub App インストール URL を返す（ADR-0028）。

    state に検証済み sub を束縛し、callback で CSRF/誤紐づけを防ぐ。
    """
    # callback と同じ必須設定（app_id/private_key）も開始時に確認してフェイルクローズする
    # 。
    client = _github_app_client()
    if client is None or not settings.github_app_slug:
        raise HTTPException(status_code=503, detail="github app not configured")
    # 所有権検証に必要な OAuth が無い本番では、install させても callback で拒否されるので
    # 開始時点でも止める（dev bypass 時のみ許可）。
    if not client.oauth_configured and not settings.auth_dev_bypass:
        raise HTTPException(status_code=503, detail="ownership verification not configured")
    state = create_link_state(
        user.sub, settings.session_signing_secret, settings.github_link_state_ttl_seconds
    )
    install_url = (
        f"https://github.com/apps/{settings.github_app_slug}/installations/new?state={state}"
    )
    return GitHubLinkStart(install_url=install_url)


@router.get("/api/github/link/callback")
def github_link_callback(installation_id: int, state: str, code: str | None = None) -> JSONResponse:
    """GitHub からの install コールバック。state を検証して連携を保存する（ADR-0028）。

    認証ヘッダは無い（GitHub リダイレクト）。署名 state が sub を束縛し CSRF を防ぐが、
    state だけでは「その sub が当該 installation を保有するか」は証明できない。OAuth
    （user-to-server）を構成している場合は `code` から所有権を検証してから保存し、別人の
    installation_id 横取りを防ぐ。OAuth 未構成の dev/local では検証を省く。
    """
    client = _github_app_client()
    if client is None:
        raise HTTPException(status_code=503, detail="github app not configured")
    try:
        sub = verify_link_state(state, settings.session_signing_secret)
    except InvalidLinkState as exc:
        log.warning("github_link_state_rejected", reason=str(exc))
        raise HTTPException(status_code=403, detail=f"invalid state: {exc}") from exc

    # 所有権検証はフェイルクローズ: OAuth 未構成なら本番では拒否する。秘密鍵だけ
    # 先に入った設定漏れでも、別人が既知の他者 installation_id を横取りできないようにする。
    # ローカル/CI の開発時のみ auth_dev_bypass で検証を省ける（既存の dev bypass 方針に合わせる）。
    if client.oauth_configured:
        if not code:
            raise HTTPException(status_code=403, detail="missing oauth code")
        try:
            owns = client.user_owns_installation(code, installation_id)
        except Exception as exc:  # pragma: no cover - network
            log.warning("github_owner_verify_failed", error=str(exc))
            raise HTTPException(status_code=502, detail="github error") from exc
        if not owns:
            log.warning("github_installation_not_owned", sub=sub, installation_id=installation_id)
            raise HTTPException(status_code=403, detail="installation not owned by user")
    elif settings.auth_dev_bypass:
        log.warning("github_owner_unverified_dev_bypass", installation_id=installation_id)
    else:
        log.warning("github_owner_unverified_rejected", installation_id=installation_id)
        raise HTTPException(status_code=503, detail="ownership verification not configured")

    try:
        login = client.installation_login(installation_id)
    except Exception as exc:  # pragma: no cover - network
        log.warning("github_installation_lookup_failed", error=str(exc))
        login = ""
    _repo.set_github_link(GitHubLink(sub=sub, installation_id=installation_id, github_login=login))
    log.info("github_linked", sub=sub, installation_id=installation_id, login=login)
    # 連携保存後は web の設定画面へ戻す（api callback とは別の web URL）。
    if settings.github_app_web_return_url:
        return JSONResponse(
            status_code=302,
            content={"linked": True},
            headers={"Location": f"{settings.github_app_web_return_url}?linked=1"},
        )
    return JSONResponse(content={"linked": True, "github_login": login})


@router.delete("/api/github/link", response_model=GitHubLinkStatus)
def github_unlink(user: AuthUser = Depends(require_user)) -> GitHubLinkStatus:
    """連携解除: users/{sub} の installation 記録のみ削除する（共有索引は残す / ADR-0028）。"""
    removed = _repo.delete_github_link(user.sub)
    log.info("github_unlinked", sub=user.sub, removed=removed)
    return GitHubLinkStatus(linked=False)


class GithubReposResponse(BaseModel):
    """`GET /api/github/repos`（ADR-0027）。02 準備「連携リポジトリ」の候補一覧。"""

    # コネクタ/App 連携のいずれかが使える状態か。False のとき UI はフィールドごと隠す
    # （ADR-0007 の不干渉）。
    enabled: bool
    # 読める "owner/name" の一覧（更新が新しい順）。
    repos: list[str]
    # 環境変数の既定リポジトリ（あれば UI が初期選択に使える）。
    default: str | None = None
    # ---- 追加情報（ADR-0028 / 後方互換の additive）----
    # 本人が GitHub App 連携済みで一覧が App installation 由来か。True のとき web は
    # branch 選択と開始時の索引キック（POST /api/sessions/{id}/github）を有効化する。
    linked: bool = False
    # App 由来のときの詳細（default_branch / private）。connector 由来では空。
    items: list[GitHubRepoItem] = Field(default_factory=list)


@router.get("/api/github/repos", response_model=GithubReposResponse)
def list_github_repos(user: AuthUser = Depends(require_user)) -> GithubReposResponse:
    """セッション実施前に選べる GitHub リポジトリの候補を返す（ADR-0027 / ADR-0028）。

    1 本のエンドポイントに統一し、次の順で解決する:
      1. 本人が GitHub App 連携済み → 連携アカウントの installation が読める一覧（ADR-0028）。
      2. 未連携でデプロイ単位コネクタが有効 → 設定済みトークンで読める一覧（ADR-0027）。
      3. どちらも不可 → `enabled=False`（UI はフィールドごと隠す）。
    一覧取得の失敗は `repos=[]` のまま `enabled=True` で返し、UI は手入力（owner/name）へ
    フォールバックする（一覧の不調で開始を止めない）。
    """
    client = _github_app_client()
    link = _repo.get_github_link(user.sub)
    # 既定リポジトリも許可リストを通す（許可外の既定はリポ名の露出になり、
    # UI が候補外の既定値を選択肢として補ってしまう）。App/connector の両経路で共通。
    default = settings.github_repo if settings.github_repo else None
    if default is not None and not _github_repo_allowed(default):
        default = None
    if client is not None and link is not None:
        try:
            app_repos = client.list_repos(link.installation_id)
        except Exception as exc:  # pragma: no cover - network
            log.warning("github_list_repos_failed", error=str(exc))
            app_repos = []
        # 許可リスト（設定時）は App 由来の候補にも一貫適用する（connector
        # だけ絞って App 側に許可外リポの選択経路が残るのを防ぐ）。
        app_repos = [r for r in app_repos if _github_repo_allowed(r.full_name)]
        log.info("github_repos_listed", count=len(app_repos), sub=user.sub, source="app")
        return GithubReposResponse(
            enabled=True,
            repos=[r.full_name for r in app_repos],
            default=default,
            linked=True,
            items=[
                GitHubRepoItem(
                    full_name=r.full_name, default_branch=r.default_branch, private=r.private
                )
                for r in app_repos
            ],
        )
    if not (settings.github_connector_enabled and settings.github_token):
        return GithubReposResponse(enabled=False, repos=[])
    # 許可リスト（設定時）で候補を絞る。SANBA にログインできる ≠ 対象 GitHub 組織の
    # メンバーである環境で、共有トークンが読める private リポ名を漏らさない。
    repos = [r for r in github_export.list_repos(settings.github_token) if _github_repo_allowed(r)]
    log.info("github_repos_listed", count=len(repos), sub=user.sub, source="connector")
    return GithubReposResponse(enabled=True, repos=repos, default=default)


@router.get("/api/github/branches", response_model=GitHubBranchesResponse)
def github_list_branches(
    repo: str, user: AuthUser = Depends(require_user)
) -> GitHubBranchesResponse:
    """選択 repo の branch 一覧（準備画面の branch 選択 / ADR-0028）。"""
    client = _github_app_client()
    link = _repo.get_github_link(user.sub)
    if client is None or link is None:
        raise HTTPException(status_code=409, detail="github not linked")
    try:
        branches = client.list_branches(link.installation_id, repo)
    except Exception as exc:  # pragma: no cover - network
        log.warning("github_list_branches_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="github error") from exc
    return GitHubBranchesResponse(
        items=[GitHubBranchItem(name=b["name"], sha=b["sha"]) for b in branches]
    )


def _index_repo_task(
    *,
    session_id: str,
    installation_id: int,
    repo: str,
    branch: str,
    commit_sha: str,
) -> None:
    """背景タスク: repo を索引し SessionMeta の状態を ready/partial/failed に更新する。"""
    client = _github_app_client()
    if client is None:  # pragma: no cover - guarded by caller
        return
    try:
        # 古いジョブの巻き戻し防止: repo A の索引中に B へ選び直すと、遅れて走る A の
        # ジョブが B の chunk を消し A を書き戻し得る。開始時に現在の選択（SessionMeta）がこの
        # ジョブの (repo,branch,sha) と一致するか確認し、ズレていれば何もしない。
        if not _selection_current(session_id, repo, branch, commit_sha):
            log.info("repo_index_skipped_stale", session=session_id, repo=repo, branch=branch)
            return
        # repo 選び直し / branch 変更 / 再同期で古い github: chunk が残ると search_grounding に
        # 旧 commit の断片が混ざる。索引前に当該 session の repo chunk を一掃する。
        _indexer.delete_repo_context(session_id)
        try:
            outcome = fetch_and_index_repo(
                client,
                _indexer,
                session_id=session_id,
                installation_id=installation_id,
                repo=repo,
                branch=branch,
                commit_sha=commit_sha,
                max_files=settings.github_index_max_files,
                max_total_bytes=settings.github_index_max_total_bytes,
                max_file_bytes=settings.github_index_max_file_bytes,
            )
            # SessionMeta 保存用の要約は秘匿レダクト＋PII マスクする（Firestore at-rest / agent
            # premise に直接入るため）。要約には repo description が redact 前で混じるので、ES 経路
            # （index_context が別途マスク）とは別に保存前にも両方を通す。
            summary = redact_secrets(outcome.summary)
            if settings.mask_pii_before_index:
                summary = mask_pii(summary)
            if outcome.failed:
                status = GitHubIndexStatus.FAILED
            elif outcome.partial:
                status = GitHubIndexStatus.PARTIAL
            else:
                status = GitHubIndexStatus.READY
        except Exception as exc:  # pragma: no cover - network
            log.warning("repo_index_failed", session=session_id, repo=repo, error=str(exc))
            status = GitHubIndexStatus.FAILED
            summary = None
        # 完了時にも再確認: 索引中に B へ選び直されていたら status/選択を巻き戻さない。
        if not _selection_current(session_id, repo, branch, commit_sha):
            log.info("repo_index_writeback_skipped_stale", session=session_id, repo=repo)
            return
        _repo.set_session_github(
            session_id,
            repo=repo,
            branch=branch,
            commit_sha=commit_sha,
            index_status=status,
            summary=summary,
        )
    finally:
        # 共有 HTTP クライアントを必ず閉じる（接続リーク防止）。
        client.close()


def _selection_current(session_id: str, repo: str, branch: str, commit_sha: str) -> bool:
    """SessionMeta の現在選択がこのジョブの (repo,branch,sha) と一致するか（stale 判定）。"""
    meta = _repo.get_session(session_id)
    return bool(
        meta is not None
        and meta.github_repo == repo
        and meta.github_branch == branch
        and meta.github_commit_sha == commit_sha
    )


@router.post("/api/sessions/{session_id}/github", response_model=SessionGitHubResponse)
def select_session_repo(
    session_id: str,
    req: SelectRepoRequest,
    background: BackgroundTasks,
    access: SessionAccess = Depends(require_session_access),
) -> SessionGitHubResponse:
    """準備画面で repo+branch を選び、非同期索引をキックする（ADR-0028）。

    連携主体は owner 固定: owner の installation でのみ索引する。branch 省略時は
    デフォルトブランチを使い、選択時の HEAD sha にピン留めする。
    """
    meta = _repo.get_session(session_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="session not found")
    # owner 固定（ADR-0028）: セッション所有者のみが前提 repo を紐づけられる。
    if access.sub != meta.owner_sub:
        raise HTTPException(status_code=403, detail="owner only")
    # 許可リスト（GITHUB_REPO_ALLOWLIST）は App 経路の保存にも一貫適用する
    # （候補一覧に出ないリポを直接 POST で紐づけ・索引する抜け道を塞ぐ）。
    if not _github_repo_allowed(req.repo):
        raise HTTPException(status_code=400, detail="github_repo is not allowed")
    client = _github_app_client()
    link = _repo.get_github_link(meta.owner_sub)
    if client is None or link is None:
        raise HTTPException(status_code=409, detail="github not linked")

    try:
        branch = req.branch
        if not branch:
            branch = str(client.repo_meta(link.installation_id, req.repo)["default_branch"])
        commit_sha = client.branch_head_sha(link.installation_id, req.repo, branch)
    except Exception as exc:  # pragma: no cover - network
        log.warning("github_resolve_branch_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="github error") from exc

    _repo.set_session_github(
        session_id,
        repo=req.repo,
        branch=branch,
        commit_sha=commit_sha,
        index_status=GitHubIndexStatus.INDEXING,
    )
    background.add_task(
        _index_repo_task,
        session_id=session_id,
        installation_id=link.installation_id,
        repo=req.repo,
        branch=branch,
        commit_sha=commit_sha,
    )
    log.info("session_repo_selected", session=session_id, repo=req.repo, branch=branch)
    return SessionGitHubResponse(
        repo=req.repo,
        branch=branch,
        commit_sha=commit_sha,
        status=GitHubIndexStatus.INDEXING.value,
    )


@router.get("/api/sessions/{session_id}/github", response_model=SessionGitHubResponse)
def get_session_repo(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> SessionGitHubResponse:
    """セッションの紐づけ repo と索引状態を返す（準備画面の進捗ポーリング / ADR-0028）。"""
    meta = _repo.get_session(session_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="session not found")
    return SessionGitHubResponse(
        repo=meta.github_repo,
        branch=meta.github_branch,
        commit_sha=meta.github_commit_sha,
        status=meta.github_index_status.value,
    )
