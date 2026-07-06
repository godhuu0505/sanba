"""Products CRUD・product repo 選択・深掘りリンク・/api/products/join（main.py から分割）。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sanba_shared.models import (
    MAX_CHECK_ITEMS,
    Audience,
    CheckItem,
    GitHubIndexStatus,
    InviteScope,
    Product,
    ProductInvite,
    SessionMeta,
    new_invite_id,
    new_product_id,
)
from sanba_shared.output_formats import DEFAULT_OUTPUT_FORMATS
from sanba_shared.repository import (
    InviteNotFound,
    InviteNotUsable,
    InviteRateLimited,
    ProductNotFound,
)

from ..auth import (
    InvalidProductInvite,
    create_invite,
    create_product_invite_token,
    verify_product_invite_token,
)
from ..auth_google import AuthUser, is_admin, maybe_user, require_user
from ..config import settings
from ..deps import (
    _GITHUB_REPO_RE,
    JoinResponse,
    SelectRepoRequest,
    SessionGitHubResponse,
    _github_app_client,
    _github_repo_allowed,
    _indexer,
    _mint_join_tokens,
    _repo,
    _require_product_access,
)
from ..github_app import redact_secrets
from ..observability import record_guest_join, record_product_event, record_rate_limited
from ..pii import mask_pii
from ..repo_indexing import fetch_and_index_repo

log = structlog.get_logger(__name__)

router = APIRouter()


# ---- Products (ADR-0031) ----------------------------------------------------
class CreateProductRequest(BaseModel):
    """`POST /api/products`（FR-1.1）。name はハンドラ側で strip + 空を 400 にする。"""

    name: str = Field(max_length=200)
    description: str = Field(default="", max_length=2000)
    # 利用者向け語彙（ADR-0032 でプロンプトにシード）。件数はここで、各語の長さは
    # `_clean_glossary` で制限する（Firestore 文書とプロンプトの肥大防止）。
    glossary: list[str] = Field(default_factory=list, max_length=100)


class CheckItemRequest(BaseModel):
    """確認項目 1 件の入力形。target は対象ペルソナ（省略 = 全員）。

    target の値検証（Audience か）は `_clean_check_items` が 400 で行う（output_formats の
    audience キー検証と同じ倒し方。Pydantic の enum 422 より理由が伝わるエラーにする）。
    """

    text: str = Field(max_length=500)
    target: str | None = None


class UpdateProductRequest(BaseModel):
    """`PATCH /api/products/{id}`（FR-1.2）。None = 変更しない（部分更新）。

    output_formats / check_items はフィールド単位の全量置換（audience キーの削除＝
    既定へ戻す、を部分 merge では表現できないため）。件数上限は Pydantic で、
    各要素の正規化・長さは `_clean_*` で検証する。
    """

    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    glossary: list[str] | None = Field(default=None, max_length=100)
    # audience（end_user/planner/developer）→ 出力フォーマット（Markdown テンプレート）。
    output_formats: dict[str, str] | None = None
    # 要件サンバ中に必ず確認する項目（最大 MAX_CHECK_ITEMS 件・対象タグ付き / ADR-0043）。
    check_items: list[CheckItemRequest] | None = Field(default=None, max_length=MAX_CHECK_ITEMS)


class CheckItemResponse(BaseModel):
    """確認項目 1 件の応答形（CheckItem の API 表現。target は Audience 値 or None）。"""

    text: str
    target: str | None = None


class ProductResponse(BaseModel):
    """product の応答形。owner_sub は載せない（本人/管理者しか読めない一覧でも
    不要な識別子は返さない。MySession の最小権限方針と同じ）。
    `role` は呼び出しユーザーから見た役割（owner / member。admin は owner に平す /
    ADR-0036）。web は管理 UI（編集・招待・削除）の出し分けに使う。認可の源泉は
    常に API 側（_require_product_access）。"""

    id: str
    name: str
    description: str
    glossary: list[str]
    created_at: datetime
    github_repo: str | None = None
    github_branch: str | None = None
    github_commit_sha: str | None = None
    github_index_status: str = "none"
    role: str = "owner"
    # 登録済みの出力フォーマット（audience → テンプレート。未登録キーは載せない）と
    # 既定テンプレート（web が「未登録＝この既定が使われる」を表示するための参照値。
    # 正はサーバ側 DEFAULT_OUTPUT_FORMATS で、web に定数を複製させない）。
    output_formats: dict[str, str] = Field(default_factory=dict)
    output_format_defaults: dict[str, str] = Field(default_factory=dict)
    # 確認項目（{text, target}）と登録上限。上限も応答で渡し web に定数を複製させない。
    check_items: list[CheckItemResponse] = Field(default_factory=list)
    check_items_limit: int = MAX_CHECK_ITEMS


class DeleteProductResponse(BaseModel):
    deleted: bool


def _product_response(product: Product, *, role: str = "owner") -> ProductResponse:
    return ProductResponse(
        id=product.id,
        name=product.name,
        description=product.description,
        glossary=product.glossary,
        created_at=product.created_at,
        github_repo=product.github_repo,
        github_branch=product.github_branch,
        github_commit_sha=product.github_commit_sha,
        github_index_status=product.github_index_status.value,
        role=role,
        output_formats={a.value: t for a, t in product.output_formats.items()},
        output_format_defaults={a.value: t for a, t in DEFAULT_OUTPUT_FORMATS.items()},
        check_items=[
            CheckItemResponse(text=c.text, target=c.target.value if c.target else None)
            for c in product.check_items
        ],
    )


def _clean_glossary(glossary: list[str]) -> list[str]:
    """利用者向け語彙を正規化する: 前後空白を除き、空要素を捨て、過長は 400。"""
    cleaned = [g.strip() for g in glossary]
    cleaned = [g for g in cleaned if g]
    if any(len(g) > 100 for g in cleaned):
        raise HTTPException(status_code=400, detail="glossary term too long (max 100 chars)")
    return cleaned


# 出力フォーマット（Markdown テンプレート）1 件の長さ上限。Firestore 文書 1MB と
# 閲覧ドキュメントとしての実用性から十分に余裕のある値に倒す。
MAX_OUTPUT_FORMAT_CHARS = 8000
# 確認項目 1 件の長さ上限（プロンプトへシードするため glossary より長めの一文まで）。
MAX_CHECK_ITEM_CHARS = 200


def _clean_output_formats(output_formats: dict[str, str]) -> dict[str, str]:
    """出力フォーマットを正規化する: audience キーを検証し、空値は「未登録＝既定へ戻す」
    としてキーごと落とす。過長は 400。"""
    cleaned: dict[str, str] = {}
    for key, template in output_formats.items():
        try:
            audience = Audience(key)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"unknown audience: {key} (expected end_user/planner/developer)",
            ) from exc
        stripped = template.strip()
        if not stripped:
            continue
        if len(stripped) > MAX_OUTPUT_FORMAT_CHARS:
            raise HTTPException(
                status_code=400,
                detail=f"output format too long (max {MAX_OUTPUT_FORMAT_CHARS} chars)",
            )
        cleaned[audience.value] = stripped
    return cleaned


def _clean_check_items(check_items: list[CheckItemRequest]) -> list[CheckItem]:
    """確認項目を正規化する: 前後空白を除き、空要素を捨て、順序を保って重複を除く。

    重複は (text, target) の組で判定する（同じ文言でも対象が違えば別項目）。target の
    不正値・text の過長は 400。件数上限（MAX_CHECK_ITEMS）は Pydantic
    （UpdateProductRequest）が先に 422 で弾くため、ここでは正規化のみ行う
    （重複除去で件数は増えない）。
    """
    seen: set[tuple[str, str | None]] = set()
    cleaned: list[CheckItem] = []
    for item in check_items:
        stripped = item.text.strip()
        if not stripped:
            continue
        if len(stripped) > MAX_CHECK_ITEM_CHARS:
            raise HTTPException(
                status_code=400,
                detail=f"check item too long (max {MAX_CHECK_ITEM_CHARS} chars)",
            )
        target: Audience | None = None
        if item.target is not None and item.target != "":
            try:
                target = Audience(item.target)
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"unknown check item target: {item.target} "
                        "(expected end_user/planner/developer or null)"
                    ),
                ) from exc
        key = (stripped, target.value if target else None)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(CheckItem(text=stripped, target=target))
    return cleaned


def _viewer_role(product: Product, user: AuthUser) -> str:
    """呼び出しユーザーから見た product 上の役割（web の管理 UI 出し分け用）。

    認可の判定そのものは `_require_product_access` が正で、これは表示用の派生値。
    admin は owner 同等の管理操作ができるため "owner" に平す。
    """
    return "owner" if (product.owner_sub == user.sub or is_admin(user)) else "member"


@router.post("/api/products", response_model=ProductResponse)
def create_product(
    req: CreateProductRequest, user: AuthUser = Depends(require_user)
) -> ProductResponse:
    """アプリを登録する（FR-1.1 / ADR-0031）。owner は呼び出しユーザー。"""
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name must not be empty")
    product = Product(
        id=new_product_id(),
        name=name,
        description=req.description.strip(),
        owner_sub=user.sub,
        glossary=_clean_glossary(req.glossary),
    )
    _repo.create_product(product)
    record_product_event("created")
    log.info("product_created", product=product.id, owner=user.sub)
    return _product_response(product)


# 注意: "/api/products/mine" は "/api/products/{product_id}" より先に登録する
# （FastAPI は登録順にマッチするため、逆だと "mine" が product_id として解釈される）。
@router.get("/api/products/mine", response_model=list[ProductResponse])
def list_my_products(user: AuthUser = Depends(require_user)) -> list[ProductResponse]:
    """本人の product 一覧を新しい順で返す（FR-1.1 / ADR-0036）。

    owner のもの（role=owner）とメンバーとして招待されたもの（role=member）を
    合流させる。無関係の product は返さない。
    """
    owned = _repo.list_products_by_owner(user.sub)
    owned_ids = {p.id for p in owned}
    # owner が自分の product のメンバーに紛れても二重に出さない（招待側で防いでいるが防御的に）。
    membered = [p for p in _repo.list_products_by_member(user.sub) if p.id not in owned_ids]
    rows = [(p, "owner") for p in owned] + [(p, "member") for p in membered]
    rows.sort(key=lambda r: r[0].created_at, reverse=True)
    log.info("my_products_listed", owner=user.sub, count=len(rows))
    return [_product_response(p, role=role) for p, role in rows]


@router.get("/api/products/{product_id}", response_model=ProductResponse)
def get_product(product_id: str, user: AuthUser = Depends(require_user)) -> ProductResponse:
    """product 詳細（owner / admin / メンバー。FR-1.2 / ADR-0036）。"""
    product = _require_product_access(product_id, user)
    return _product_response(product, role=_viewer_role(product, user))


@router.patch("/api/products/{product_id}", response_model=ProductResponse)
def update_product(
    product_id: str, req: UpdateProductRequest, user: AuthUser = Depends(require_user)
) -> ProductResponse:
    """name / description / glossary / output_formats / check_items のみ更新する（FR-1.2）。
    所有・出所は不変。

    管理操作なので owner / admin のみ（メンバーは 403 / ADR-0036）。
    """
    _require_product_access(product_id, user, manage=True)
    name = req.name.strip() if req.name is not None else None
    if name == "":
        raise HTTPException(status_code=400, detail="name must not be empty")
    glossary = _clean_glossary(req.glossary) if req.glossary is not None else None
    description = req.description.strip() if req.description is not None else None
    output_formats = (
        _clean_output_formats(req.output_formats) if req.output_formats is not None else None
    )
    check_items = _clean_check_items(req.check_items) if req.check_items is not None else None
    try:
        updated = _repo.update_product(
            product_id,
            name=name,
            description=description,
            glossary=glossary,
            output_formats=output_formats,
            check_items=check_items,
        )
    except ProductNotFound as exc:
        # 認可チェック後に消えた競合。存在秘匿の方針に合わせ 404 のまま返す。
        raise HTTPException(status_code=404, detail="product not found") from exc
    record_product_event("updated")
    log.info("product_updated", product=product_id, owner=user.sub)
    return _product_response(updated)


@router.delete("/api/products/{product_id}", response_model=DeleteProductResponse)
def delete_product(
    product_id: str, user: AuthUser = Depends(require_user)
) -> DeleteProductResponse:
    """product を配下の深掘りリンクごと削除する（FR-1.2）。

    grounding 索引に入れた repo chunk も一緒に掃除する（消し漏れると
    search_grounding に親なし product の断片が残る）。管理操作なので owner / admin のみ。
    """
    _require_product_access(product_id, user, manage=True)
    deleted = _repo.delete_product(product_id)
    if deleted:
        try:
            _indexer.delete_repo_context(product_id)
        except Exception as exc:  # pragma: no cover - ES 不調でも削除自体は成立させる
            log.warning("product_context_cleanup_failed", product=product_id, error=str(exc))
    record_product_event("deleted")
    log.info("product_deleted", product=product_id, owner=user.sub, deleted=deleted)
    return DeleteProductResponse(deleted=deleted)


def _index_product_repo_task(
    *,
    product_id: str,
    installation_id: int,
    repo: str,
    branch: str,
    commit_sha: str,
) -> None:
    """背景タスク: product の前提 repo を索引し状態を ready/partial/failed に更新する。

    `_index_repo_task`（セッション版）と同じ流れの product 版。索引スコープは
    product_id（配下セッションが共有する前提情報 / FR-1.3）。stale 判定も
    SessionMeta ではなく product 文書に対して行う。
    """
    client = _github_app_client()
    if client is None:  # pragma: no cover - guarded by caller
        return
    try:
        if not _product_selection_current(product_id, repo, branch, commit_sha):
            log.info("product_repo_index_skipped_stale", product=product_id, repo=repo)
            return
        _indexer.delete_repo_context(product_id)
        try:
            outcome = fetch_and_index_repo(
                client,
                _indexer,
                session_id=product_id,
                installation_id=installation_id,
                repo=repo,
                branch=branch,
                commit_sha=commit_sha,
                max_files=settings.github_index_max_files,
                max_total_bytes=settings.github_index_max_total_bytes,
                max_file_bytes=settings.github_index_max_file_bytes,
            )
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
            log.warning("product_repo_index_failed", product=product_id, repo=repo, error=str(exc))
            status = GitHubIndexStatus.FAILED
            summary = None
        if not _product_selection_current(product_id, repo, branch, commit_sha):
            log.info("product_repo_index_writeback_skipped_stale", product=product_id, repo=repo)
            return
        _repo.set_product_github(
            product_id,
            repo=repo,
            branch=branch,
            commit_sha=commit_sha,
            index_status=status,
            summary=summary,
        )
    finally:
        client.close()


def _product_selection_current(product_id: str, repo: str, branch: str, commit_sha: str) -> bool:
    """product の現在選択がこのジョブの (repo,branch,sha) と一致するか（stale 判定）。"""
    product = _repo.get_product(product_id)
    return bool(
        product is not None
        and product.github_repo == repo
        and product.github_branch == branch
        and product.github_commit_sha == commit_sha
    )


@router.post("/api/products/{product_id}/github", response_model=SessionGitHubResponse)
def select_product_repo(
    product_id: str,
    req: SelectRepoRequest,
    background: BackgroundTasks,
    user: AuthUser = Depends(require_user),
) -> SessionGitHubResponse:
    """product に前提 repo を紐づけ、非同期索引をキックする（FR-1.3 / ADR-0031）。

    連携主体は product owner 固定（ADR-0028 の「セッション owner 固定」と同方針:
    owner の GitHub App installation でのみ索引するため、admin でも他人の product には
    紐づけできない）。同一 (repo, branch, sha) が索引済み/索引中なら再索引しない。
    """
    product = _require_product_access(product_id, user, manage=True)
    if user.sub != product.owner_sub:
        raise HTTPException(status_code=403, detail="owner only")
    if not _GITHUB_REPO_RE.match(req.repo):
        raise HTTPException(status_code=400, detail="github_repo must be in 'owner/name' format")
    # 許可リスト（GITHUB_REPO_ALLOWLIST / ADR-0027）は product の紐づけにも一貫適用する
    # （NFR-2。セッション経路だけ絞って product 側に抜け道が残るのを防ぐ）。
    if not _github_repo_allowed(req.repo):
        raise HTTPException(status_code=400, detail="github_repo is not allowed")
    client = _github_app_client()
    link = _repo.get_github_link(product.owner_sub)
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

    # 同一 (repo, branch, sha) が索引中/索引済みなら再索引しない（FR-1.3 AC）。
    # failed のときだけ同一 sha でも再試行を許す。
    if (
        product.github_repo == req.repo
        and product.github_branch == branch
        and product.github_commit_sha == commit_sha
        and product.github_index_status
        in (GitHubIndexStatus.INDEXING, GitHubIndexStatus.READY, GitHubIndexStatus.PARTIAL)
    ):
        log.info(
            "product_repo_index_reused",
            product=product_id,
            repo=req.repo,
            sha=commit_sha,
            status=product.github_index_status.value,
        )
        return SessionGitHubResponse(
            repo=req.repo,
            branch=branch,
            commit_sha=commit_sha,
            status=product.github_index_status.value,
        )

    _repo.set_product_github(
        product_id,
        repo=req.repo,
        branch=branch,
        commit_sha=commit_sha,
        index_status=GitHubIndexStatus.INDEXING,
    )
    background.add_task(
        _index_product_repo_task,
        product_id=product_id,
        installation_id=link.installation_id,
        repo=req.repo,
        branch=branch,
        commit_sha=commit_sha,
    )
    record_product_event("github_set")
    log.info("product_repo_selected", product=product_id, repo=req.repo, branch=branch)
    return SessionGitHubResponse(
        repo=req.repo,
        branch=branch,
        commit_sha=commit_sha,
        status=GitHubIndexStatus.INDEXING.value,
    )


# ---- Product invites: 深掘りリンク (ADR-0031 決定3 / FR-1.5, FR-1.6) ----------
class CreateProductInviteRequest(BaseModel):
    """`POST /api/products/{id}/invites`。期限は ttl_seconds で受け expires_at に変換する。

    ttl_seconds / max_uses の None は「その制限を掛けない」（ProductInvite と同じ意味論。
    失効ボタンともう一方の制限で止める運用を許す）。
    """

    scope: InviteScope = InviteScope.DEVELOPER
    ttl_seconds: int | None = Field(default=None, ge=60)
    max_uses: int | None = Field(default=None, ge=1)


class ProductInviteResponse(BaseModel):
    """発行済み深掘りリンク 1 件。web は token から /join/{token} の URL を組む。"""

    id: str
    scope: str
    expires_at: datetime | None
    max_uses: int | None
    use_count: int
    revoked: bool
    created_at: datetime
    token: str


class ProductJoinRequest(BaseModel):
    token: str
    # 録音・AI 処理への同意（issue #10）。セッション作成を伴うため create_session と同じゲート。
    consent_acknowledged: bool = False


class ProductJoinResponse(BaseModel):
    """深掘りリンク入場の結果（FR-1.6 / FR-2.1）。

    ログイン済み: LiveKit トークンはここでは発行しない。返した `invite`（create_session が
    返すものと同じ署名付き役割 invite）を既存 `POST /api/sessions/join` に渡して交換する
    （トークン発行・identity 束縛のロジックを join 側に保つための分割）。
    ゲスト（ADR-0032 決定1）: sessions/join は require_user のまま変えないため、
    `join`（LiveKit トークン + session_token）をここで直接返す。`invite` は null。
    発行ロジック自体は `_mint_join_tokens` で両経路共通。
    """

    session_id: str
    invite: str | None
    product_id: str
    product_name: str
    interview_mode: str
    # ゲスト入場のときのみ非 null（ログイン済みは従来どおり invite 経由）。
    join: JoinResponse | None = None


def _invite_response(invite: ProductInvite) -> ProductInviteResponse:
    token = create_product_invite_token(
        invite.product_id,
        invite.id,
        settings.session_signing_secret,
        int(invite.expires_at.timestamp()) if invite.expires_at else None,
    )
    return ProductInviteResponse(
        id=invite.id,
        scope=invite.scope.value,
        expires_at=invite.expires_at,
        max_uses=invite.max_uses,
        use_count=invite.use_count,
        revoked=invite.revoked,
        created_at=invite.created_at,
        token=token,
    )


# invite の scope → 既存セッションの役割語彙（ubiquitous-language §2: 企画/エンジニア/顧客）。
# developer リンクは PdM 壁打ち、end_user リンクは「顧客」役として入場する。
_INVITE_ROLE = {InviteScope.DEVELOPER: "pm", InviteScope.END_USER: "customer"}


@router.post("/api/products/{product_id}/invites", response_model=ProductInviteResponse)
def create_product_invite(
    product_id: str, req: CreateProductInviteRequest, user: AuthUser = Depends(require_user)
) -> ProductInviteResponse:
    """深掘りリンクを発行する（FR-1.5）。

    発行は owner のみ（admin 不可）: リンクは owner が準備した product への入場券であり、
    repo 紐づけ（owner の installation）と同じく所有者の意思で発行する。
    """
    product = _require_product_access(product_id, user, manage=True)
    if user.sub != product.owner_sub:
        raise HTTPException(status_code=403, detail="owner only")
    expires_at = datetime.now(UTC) + timedelta(seconds=req.ttl_seconds) if req.ttl_seconds else None
    invite = ProductInvite(
        id=new_invite_id(),
        product_id=product_id,
        scope=req.scope,
        expires_at=expires_at,
        max_uses=req.max_uses,
    )
    try:
        _repo.create_invite(invite)
    except ProductNotFound as exc:
        raise HTTPException(status_code=404, detail="product not found") from exc
    record_product_event("invite_created")
    log.info(
        "invite_created",
        product=product_id,
        invite=invite.id,
        scope=invite.scope.value,
        ttl_seconds=req.ttl_seconds,
        max_uses=req.max_uses,
        owner=user.sub,
    )
    return _invite_response(invite)


@router.get("/api/products/{product_id}/invites", response_model=list[ProductInviteResponse])
def list_product_invites(
    product_id: str, user: AuthUser = Depends(require_user)
) -> list[ProductInviteResponse]:
    """発行済み深掘りリンクの一覧（owner / admin。FR-1.5 の管理 UI 用）。"""
    _require_product_access(product_id, user, manage=True)
    return [_invite_response(i) for i in _repo.list_invites(product_id)]


@router.post(
    "/api/products/{product_id}/invites/{invite_id}/revoke",
    response_model=ProductInviteResponse,
)
def revoke_product_invite(
    product_id: str, invite_id: str, user: AuthUser = Depends(require_user)
) -> ProductInviteResponse:
    """深掘りリンクを失効させる（owner / admin。FR-1.5）。冪等（既失効でも 200）。"""
    _require_product_access(product_id, user, manage=True)
    if not _repo.revoke_invite(product_id, invite_id):
        raise HTTPException(status_code=404, detail="invite not found")
    invite = _repo.get_invite(product_id, invite_id)
    if invite is None:  # revoke 直後の削除と競合した稀ケース
        raise HTTPException(status_code=404, detail="invite not found")
    record_product_event("invite_revoked")
    log.info("invite_revoked", product=product_id, invite=invite_id, by=user.sub)
    return _invite_response(invite)


@router.post("/api/products/join", response_model=ProductJoinResponse)
def join_product(
    req: ProductJoinRequest, user: AuthUser | None = Depends(maybe_user)
) -> ProductJoinResponse:
    """深掘りリンクからセッションを自動作成する（FR-1.6 / FR-2.1 / ADR-0031 決定3）。

    認証は原則ログイン必須。唯一の例外（ADR-0032 決定1）: `guest_join_enabled` かつ
    invite の `scope=end_user` のとき、未認証（Authorization ヘッダ無し）を受ける。
    同意ゲート（FR-2.2）はゲストでも省略しない。検証は二段: 署名（owner が発行した
    本物のリンクか）→ invite 文書（失効・期限・回数・リンク単位レートをトランザクション
    で消費。文書側が正）。02 準備は出さず、ゴール（title）と repo 設定は product から
    継承する（FR-1.4）。IP 単位レート制限はミドルウェア `_rate_limit_join` が
    body 解析前に掛け、リンク単位（FR-2.6）は consume_invite が原子的に判定する。
    """
    guest = user is None
    if settings.require_consent and not req.consent_acknowledged:
        raise HTTPException(
            status_code=400,
            detail="consent required: recording and AI processing must be acknowledged",
        )
    try:
        claim = verify_product_invite_token(req.token, settings.session_signing_secret)
    except InvalidProductInvite as exc:
        log.warning("product_invite_rejected", reason=str(exc))
        raise HTTPException(status_code=403, detail=f"invalid invite link: {exc}") from exc
    if guest:
        # フェイルクローズ: フラグ off は即 401（invite を消費しない）。scope の判定は
        # 文書側が正（署名トークンは scope を持たない）。scope は発行後に変わらないため
        # 消費前の read で判定してよい（消費と可否検証の原子性は consume_invite が担う）。
        if not settings.guest_join_enabled:
            record_guest_join("flag_off")
            log.warning(
                "guest_join_rejected",
                reason="flag_off",
                product=claim.product_id,
                invite=claim.invite_id,
            )
            raise HTTPException(status_code=401, detail="authentication required")
        invite_doc = _repo.get_invite(claim.product_id, claim.invite_id)
        if invite_doc is None:
            raise HTTPException(status_code=404, detail="invite not found")
        if invite_doc.scope is not InviteScope.END_USER:
            record_guest_join("scope_mismatch")
            log.warning(
                "guest_join_rejected",
                reason="scope_mismatch",
                product=claim.product_id,
                invite=claim.invite_id,
                scope=invite_doc.scope.value,
            )
            raise HTTPException(status_code=401, detail="authentication required")
    # 消費（use_count++）は最後の関門: consent・署名・ゲスト可否を先に検証し、失敗する
    # 要求で使用回数を減らさない。文書照合・リンク単位レート判定（FR-2.6）と消費は
    # 原子的（ADR-0031 / ADR-0032 決定5 / consume_invite）。
    try:
        invite = _repo.consume_invite(
            claim.product_id,
            claim.invite_id,
            rate_limit_per_minute=settings.invite_join_rate_per_minute,
        )
    except (InviteNotFound, ProductNotFound) as exc:
        # Firestore 経路は join と product 削除の競合で ProductNotFound を投げ得る
        # （トランザクション内の親存在チェック）。invite 不在と同じ 404 に平す。
        raise HTTPException(status_code=404, detail="invite not found") from exc
    except InviteNotUsable as exc:
        log.warning(
            "product_invite_not_usable",
            product=claim.product_id,
            invite=claim.invite_id,
            reason=exc.reason,
        )
        raise HTTPException(status_code=403, detail=f"invite not usable: {exc.reason}") from exc
    except InviteRateLimited as exc:
        if guest:
            record_guest_join("rate_limited")
        record_rate_limited(limiter="invite")
        log.warning(
            "product_join_rate_limited",
            product=claim.product_id,
            invite=claim.invite_id,
            guest=guest,
            limit=settings.invite_join_rate_per_minute,
        )
        raise HTTPException(status_code=429, detail="rate limit exceeded") from exc
    product = _repo.get_product(claim.product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="product not found")

    role = _INVITE_ROLE[invite.scope]
    session_id = f"sess-{uuid.uuid4().hex[:8]}"
    # ゲスト identity（ADR-0032 決定2）: users/{sub} は作らず、発話・要件の出所メタは
    # この匿名 identity に束ねる。owner はセッションの管理・履歴閲覧の権限元（決定3）。
    guest_identity = f"guest:{uuid.uuid4().hex[:12]}" if guest else None
    owner_sub = product.owner_sub if guest else user.sub  # type: ignore[union-attr]
    # PII 最小化: ゲストセッションに owner の email は写さない（権限判定は owner_sub が
    # 単一の正で、email を使う経路が無い。product 文書も email を持たない）。
    owner_email = "" if guest else user.email  # type: ignore[union-attr]
    _repo.create_session_doc(
        SessionMeta(
            id=session_id,
            title=product.name,
            owner_sub=owner_sub,
            owner_email=owner_email,
            roles=[role],
            product_id=product.id,
            interview_mode=invite.scope,
            # repo 設定の継承（FR-1.4）: 「セッション明示 > product > 環境変数」の
            # product 段。索引済み要約ごと写すので agent のシードもそのまま効く。
            github_repo=product.github_repo,
            github_branch=product.github_branch,
            github_commit_sha=product.github_commit_sha,
            github_index_status=product.github_index_status,
            github_summary=product.github_summary,
        ),
        # ゲスト作成分はセッション文書にも 30 日 TTL を張る（FR-2.7。同意文言の
        # 保持期間の約束をメタ文書にも効かせる）。ログイン済みは従来どおり張らない。
        apply_ttl=guest,
    )
    record_product_event("invite_redeemed")
    log.info(
        "session_created",
        session=session_id,
        roles=[role],
        owner=owner_sub,
        guest=guest,
        github_repo=product.github_repo or "(none)",
        product_id=product.id,
        interview_mode=invite.scope.value,
        source="product_invite",
    )
    log.info(
        "invite_redeemed",
        product=product.id,
        invite=invite.id,
        use_count=invite.use_count,
        max_uses=invite.max_uses,
        session=session_id,
        guest=guest,
    )
    if guest:
        assert guest_identity is not None
        joined = _mint_join_tokens(session_id, role, guest_identity, "利用者", guest_identity, "")
        record_guest_join("granted")
        log.info(
            "guest_join_granted",
            session=session_id,
            identity=guest_identity,
            product=product.id,
            invite=invite.id,
        )
        return ProductJoinResponse(
            session_id=session_id,
            invite=None,
            product_id=product.id,
            product_name=product.name,
            interview_mode=invite.scope.value,
            join=joined,
        )
    session_invite = create_invite(
        session_id, role, settings.session_signing_secret, settings.invite_ttl_seconds
    )
    return ProductJoinResponse(
        session_id=session_id,
        invite=session_invite,
        product_id=product.id,
        product_name=product.name,
        interview_mode=invite.scope.value,
    )
