"""FastAPI app: create sessions, issue invite-gated LiveKit tokens.

Access model (see issue #8):
  1. POST /api/sessions          -> owner creates a room, gets signed invites per role.
  2. POST /api/sessions/join     -> a guest exchanges a valid invite for a scoped,
                                    short-lived LiveKit token. Joining an arbitrary
                                    session_id without an invite is rejected.

The web client connects to LiveKit directly with the returned token; the voice
agent worker is dispatched to the same room name automatically.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import time
import uuid
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from livekit import api
from pydantic import BaseModel, Field
from sanba_shared.models import (
    GitHubIndexStatus,
    GitHubLink,
    InviteScope,
    Product,
    ProductInvite,
    Requirement,
    RequirementStatus,
    SessionMeta,
    new_invite_id,
    new_product_id,
)
from sanba_shared.repository import (
    InviteNotFound,
    InviteNotUsable,
    ProductNotFound,
    RequirementNotFound,
    SessionRepository,
)

from . import github_export
from .auth import (
    InvalidInvite,
    InvalidProductInvite,
    InvalidSessionToken,
    SessionAccess,
    create_invite,
    create_product_invite_token,
    create_session_token,
    verify_invite,
    verify_product_invite_token,
    verify_session_token,
)
from .auth_google import AuthUser, is_admin, require_admin, require_user
from .config import settings
from .github_app import (
    GitHubAppClient,
    InvalidLinkState,
    create_link_state,
    redact_secrets,
    verify_link_state,
)
from .ingestion import ContextIndexer, chunk_text, extract_text_from_upload
from .observability import (
    record_asset_upload,
    record_material_event,
    record_my_requirements_viewed,
    record_my_sessions_listed,
    record_product_event,
    record_question_hydration,
    record_rate_limited,
    setup_observability,
)
from .pii import mask_pii
from .realtime import (
    STAGE_ANALYZING,
    STAGE_FAILED,
    STAGE_RECEIVED,
    AnalysisPublisher,
    NullSender,
    build_sender,
)
from .repo_indexing import fetch_and_index_repo
from .repository import ReadRepository
from .storage import (
    AssetStore,
    asset_kind,
    is_text_upload,
    material_record,
    resolve_content_type,
)
from .vision import analyze_image

log = structlog.get_logger(__name__)


def _get_tracer() -> Any:
    """OTel トレーサ（未設定なら None で no-op）。アップロード〜解析を span 化する。"""
    try:
        from opentelemetry import trace

        return trace.get_tracer("sanba_api.assets")
    except Exception:  # pragma: no cover - otel optional
        return None


app = FastAPI(title="SANBA API", version="0.2.0")

# In-memory per-IP rate limiter for the join endpoint. Stateless workers can use
# a shared store (Redis/Firestore) later; this is enough to blunt abuse in the MVP.
_join_hits: dict[str, deque[float]] = defaultdict(deque)


def _over_rate_limit(client_ip: str) -> bool:
    """sliding-window で join が上限超過なら True（上限内なら副作用でヒットを記録）。

    判定を関数に切り出し、body 解析より前のミドルウェア層から呼ぶ（#258）。
    """
    window_start = time.time() - 60
    hits = _join_hits[client_ip]
    while hits and hits[0] < window_start:
        hits.popleft()
    if len(hits) >= settings.join_rate_per_minute:
        return True
    hits.append(time.time())
    return False


@app.middleware("http")
async def _rate_limit_join(request: Request, call_next: Any) -> Any:
    """join のレートリミットを body 解析より前（ミドルウェア層）で適用する（#258 / #80）。

    FastAPI ルートの依存性（Depends）は request body の読み取り・JSON/Pydantic 解析の後に
    解決される（routing.py: body→solve_dependencies の順）。そのため依存性版（#80）は、未認証
    スパムが壊れた/巨大 JSON を送ると解析コストだけを発生させ続けられる穴が残っていた。Starlette
    の HTTP ミドルウェアは body 読み取り前に走るので、POST /api/sessions/join のみ上限判定し、
    超過時は body に触れず 429 を返す。CORS より内側で動くよう CORS の前に登録し、429 応答にも
    CORS ヘッダが付くようにする（ミドルウェアは後から add した方が外側になる）。
    """
    # 深掘りリンク入場（/api/products/join）も同じ未認証スパム面を持つため同枠で制限する。
    if request.method == "POST" and request.url.path in (
        "/api/sessions/join",
        "/api/products/join",
    ):
        client_ip = request.client.host if request.client else "unknown"
        if _over_rate_limit(client_ip):
            # 認証より前に短絡するため auth イベントに現れない。DoS 緩和の発火をログ＋
            # メトリクスで本番検知できるようにする（#257 Codex / CLAUDE.md 原則3）。
            log.warning(
                "join_rate_limited", client_ip=client_ip, limit=settings.join_rate_per_minute
            )
            record_rate_limited()
            return JSONResponse(status_code=429, content={"detail": "rate limit exceeded"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
# OTLP エンドポイントが設定されていれば分散トレースを有効化する (未設定なら no-op)。
setup_observability(app)

# Context indexer shares the agent's Elasticsearch grounding index (issue #6).
_indexer = ContextIndexer()

# 画像/動画アセットの保存層（issue #103）。GCS 未設定なら in-memory にフォールバック。
_asset_store = AssetStore()

# Firestore SDK は OS 環境変数 FIRESTORE_EMULATOR_HOST を直接読む。config 経由で指定された
# 場合に SDK へ橋渡しする (compose では .env で渡るが、config だけ変えた場合の取りこぼしを防ぐ)。
# 未設定なら何もしない = 本番では実 Firestore に接続する。
if settings.firestore_emulator_host:
    os.environ.setdefault("FIRESTORE_EMULATOR_HOST", settings.firestore_emulator_host)

# セッション/要件の永続化境界 (ADR-0014)。agent と同じ sanba_shared を使う。
_repo = SessionRepository(
    data_retention_days=settings.data_retention_days,
    mask_pii_before_persist=settings.mask_pii_before_index,
)

# Read-side store for hydration APIs（契約 §4 / #100）。agent が書いた要件・検知を読む。
_read_repo = ReadRepository()


def require_session_access(
    session_id: str, authorization: str | None = Header(default=None)
) -> SessionAccess:
    """Hydration/export を「join 済みトークン」で保護する（契約 §4）。

    `session_id` をパスに含むだけでは参加者以外に漏洩するため、join 時に発行した
    署名付きセッショントークン（Bearer）を検証し、パスの session_id と一致させる。
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing session token")
    token = authorization[len("Bearer ") :]
    try:
        access = verify_session_token(token, settings.session_signing_secret)
    except InvalidSessionToken as exc:
        log.warning("session_token_rejected", reason=str(exc))
        raise HTTPException(status_code=403, detail=f"invalid session token: {exc}") from exc
    if access.session_id != session_id:
        raise HTTPException(status_code=403, detail="session mismatch")
    return access


# "owner/name" 形式（ADR-0027）。GitHub の実際の命名規則より緩いが、パス注入
# （`/` の追加や空文字）を弾ければ十分（トークン権限外のリポは GitHub 側が 404 を返す）。
_GITHUB_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def _github_repo_allowed(repo: str) -> bool:
    """許可リスト（GITHUB_REPO_ALLOWLIST / ADR-0027）に照らして選択可否を返す。

    エントリは "owner"（配下すべて）または "owner/name"。リスト空 = 制限なし。
    候補一覧（GET /api/github/repos）と保存（POST /api/sessions）の両方が同じ判定を使い、
    一覧に出ないリポジトリを直接 POST で保存する抜け道を塞ぐ（Codex P1）。
    """
    entries = [e.strip() for e in settings.github_repo_allowlist.split(",") if e.strip()]
    if not entries:
        return True
    owner = repo.split("/", 1)[0]
    return any(e == repo or e == owner for e in entries)


def _confirmed_requirements(session_id: str) -> list[dict[str, Any]]:
    """会話確定軸（contract: confirmed）の要件のみを返す（確定判定の単一の定義 / #213）。

    `requirement_doc_to_contract` が管理軸 rejected を draft に落とすため、却下要件はここで
    除外される。確定判定はこの 1 箇所に集約し finalize のスナップショット算出だけが使う。
    export は finalize 済みスナップショット（`finalized_requirement_ids`）を起票するため
    この関数を呼ばない＝確定判定が finalize と export で重複しない（重複定義禁止）。
    """
    return [r for r in _read_repo.list_requirements(session_id) if r["status"] == "confirmed"]


def _finalized_snapshot_requirements(session: SessionMeta) -> list[dict[str, Any]]:
    """finalize 時に凍結した要件集合を契約形で返す（#213 凍結保証の単一定義）。

    export と過去要件閲覧（GET /api/sessions/mine/{id}/requirements）が共有する。確定後に
    遅延 agent が要件を追加したり管理画面 API で却下されても、確定時集合を再計算せず固定する
    （Codex P2 / discussion_r3481706919）。未 finalize ならスナップショットは空。

    後方互換（Codex P1）: 本機能デプロイ前に finalized になった旧文書は ID スナップショットを
    持たない（既定 []）。`status==finalized` かつ確定件数 > 0 で ID 集合だけ欠落しているケースは
    旧挙動（確定要件の再計算）にフォールバックし、確定済みセッションを空にしない。
    """
    snapshot_ids = session.finalized_requirement_ids
    legacy_finalized_without_snapshot = (
        not snapshot_ids and session.status == "finalized" and (session.finalized_count or 0) > 0
    )
    if legacy_finalized_without_snapshot:
        return _confirmed_requirements(session.id)
    return _read_repo.get_requirements_by_ids(session.id, snapshot_ids)


# ---- Schemas ---------------------------------------------------------------
class CreateSessionRequest(BaseModel):
    title: str = "要件インタビュー"
    # Roles to mint invites for (owner shares these links with participants).
    roles: list[str] = ["pm", "engineer", "customer"]
    # Explicit consent to recording + AI processing (issue #10).
    consent_acknowledged: bool = False
    # セッション単位の連携リポジトリ（任意 / ADR-0027）。
    #  - 未指定（None）: 従来挙動 = 環境変数 GITHUB_REPO へフォールバック。
    #  - 空文字: 明示的な「連携しない」（既定リポジトリにも送らない / Codex P2）。
    #  - "owner/name": このセッションの起票・grounding 先。
    github_repo: str | None = None


class CreateSessionResponse(BaseModel):
    session_id: str
    invites: dict[str, str]  # role -> invite token


class ContextRequest(BaseModel):
    text: str
    source_name: str = "uploaded"


class ContextResponse(BaseModel):
    indexed_chunks: int
    # 画像/動画アップロード時のみ付与（issue #103 / 契約 §3）。web は asset_id で
    # analysis.progress / analysis.visual をファイル行へ対応付ける。
    asset_id: str | None = None
    asset_kind: str | None = None  # "image" | "video"
    # 解析が未実装（例: 動画）で保存のみ済んだ場合 true（web は「準備中」を表示）。
    analysis_pending: bool = False


class JoinRequest(BaseModel):
    invite: str
    participant_name: str


class JoinResponse(BaseModel):
    token: str
    livekit_url: str
    session_id: str
    identity: str
    # 契約 §4: ハイドレーション/起票 API を保護する「join 済みトークン」。
    session_token: str


class RequirementsResponse(BaseModel):
    items: list[dict[str, Any]]
    # 適用済み連番の境界。API は publish seq を持たないため 0 を返し、web 側の
    # (type,id) 冪等 upsert に合流を委ねる（重複・空白は出ない）。
    seq: int = 0


class DetectionsResponse(BaseModel):
    items: list[dict[str, Any]]


class CurrentQuestionResponse(BaseModel):
    # 現在の未回答質問（金枠 / 契約 §4 #212）。未提示・回答済みなら question=null。
    # question=null でも seq（=cleared_seq）を返し、web は遅延 null が新しい問いを消すのを防ぐ。
    question: dict[str, Any] | None = None
    seq: int = 0


class ContextFilesResponse(BaseModel):
    # 投入済み素材のメタ一覧（契約 §4 #184）。web は asset_id で realtime の analysis 行と
    # 突き合わせ、リロード/再接続時に実ファイル名・状態（解析中/完了）を復元する。
    items: list[dict[str, Any]]


class ExportResponse(BaseModel):
    exported: bool
    issue_url: str | None = None
    count: int | None = None
    doc_url: str | None = None
    reason: str | None = None


class FinalizeResponse(BaseModel):
    # 07 判定の「確定」結果（#186）。確定スナップショットの件数を返す。
    finalized: bool
    confirmed_count: int = 0


# web UI 由来テレメトリの許可リスト（#232/#243）。第三者分析 SDK を使わず既存 OTLP 基盤に
# 集約する（observability.py）。PII/自由記述は受けず、列挙値のみを受ける。未知 event は 422、
# 未知の属性値は other へ丸めて高カーディナリティ/PII 流入を防ぐ（観測は UX を止めない）。
# material.discard は含めない: 破棄結果はサーバ（DELETE エンドポイント）が直接 record_material_event
# で計上する内部イベントで、クライアントからの受領は想定しない（送ってきても 422 で弾く）。
_TELEMETRY_EVENTS = {"material.source_selected", "material.cancel"}
_TELEMETRY_SOURCES = {"camera", "screen", "upload", "drive"}
_TELEMETRY_STATUSES = {"uploading", "analyzing"}
_TELEMETRY_RESULTS = {"aborted", "discarded", "error"}


class TelemetryRequest(BaseModel):
    # 列挙属性のみ（PII/自由記述は受けない）。明示フィールドに固定し、任意キーを排除する。
    event: str
    source: str | None = None
    status: str | None = None
    result: str | None = None


class TelemetryResponse(BaseModel):
    recorded: bool


class DeleteContextFileResponse(BaseModel):
    # 真の破棄（#245）。deleted は常に True（冪等）、existed は実体を消したかを示す。
    deleted: bool
    existed: bool


def _enum_or_other(value: str | None, allowed: set[str]) -> str:
    """列挙値の検証。未指定は none、許可外は other へ丸める（PII/高カーディナリティ防止）。"""
    if value is None:
        return "none"
    return value if value in allowed else "other"


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/sessions", response_model=CreateSessionResponse)
def create_session(
    req: CreateSessionRequest, user: AuthUser = Depends(require_user)
) -> CreateSessionResponse:
    """Create an interview room and mint a signed invite per role.

    Requires a verified Google identity (ADR-0012): only a logged-in owner can
    open a room. The invite still scopes which room/role a guest may join.
    """
    if settings.require_consent and not req.consent_acknowledged:
        raise HTTPException(
            status_code=400,
            detail="consent required: recording and AI processing must be acknowledged",
        )
    # 連携リポジトリ（任意 / ADR-0027）。未指定（None）はフォールバック、空文字は明示的な
    # 「連携しない」としてそのまま保存する（Codex P2: 既定リポとオプトアウトを区別）。
    # 形式不正・許可リスト外は黙って落とさず 400 で返す（起票時の失敗より早く気づける）。
    github_repo: str | None = None
    if req.github_repo is not None:
        github_repo = req.github_repo.strip()
        if github_repo and not _GITHUB_REPO_RE.match(github_repo):
            raise HTTPException(
                status_code=400, detail="github_repo must be in 'owner/name' format"
            )
        if github_repo and not _github_repo_allowed(github_repo):
            raise HTTPException(status_code=400, detail="github_repo is not allowed")
    session_id = f"sess-{uuid.uuid4().hex[:8]}"
    invites = {
        role: create_invite(
            session_id, role, settings.session_signing_secret, settings.invite_ttl_seconds
        )
        for role in req.roles
    }
    # セッションメタを永続化する (ADR-0014 §4)。管理画面の一覧/閲覧/承認の土台になる。
    _repo.create_session_doc(
        SessionMeta(
            id=session_id,
            title=req.title,
            owner_sub=user.sub,
            owner_email=user.email,
            roles=req.roles,
            github_repo=github_repo,
        )
    )
    log.info(
        "session_created",
        session=session_id,
        roles=req.roles,
        owner=user.sub,
        github_repo=github_repo or "(none)",
    )
    return CreateSessionResponse(session_id=session_id, invites=invites)


class MySession(BaseModel):
    """`GET /api/sessions/mine` の 1 行 (#250)。本人の履歴一覧 UI (#215) に供給する。

    PII (owner_email/owner_sub) は載せない: 本人だけが見る一覧でも不要な PII は返さない
    (最小権限 / CLAUDE.md セキュリティ)。一覧に要る最小項目 (標題・作成時刻・確定状態) だけ。
    詳細ルートは別 issue のため id 以上の内訳は持たせない。
    """

    id: str
    title: str
    created_at: datetime
    status: str
    # 07 判定で確定済みか (#186)。一覧でバッジ等に使えるよう真偽で平す。
    finalized: bool


@app.get("/api/sessions/mine", response_model=list[MySession])
def list_my_sessions(user: AuthUser = Depends(require_user)) -> list[MySession]:
    """ログインユーザー本人 (owner_sub) のセッション一覧を新しい順で返す (#250)。

    `require_user` (idToken をサーバ検証 / ADR-0012) で本人確認し、owner_sub が一致する
    ものだけを返す。他人のセッションは一切返さない (認可は本人限定)。ホームの
    「過去の要件を見る」履歴リスト (#215) のデータ源。
    """
    sessions = _repo.list_sessions_by_owner(user.sub)
    record_my_sessions_listed(len(sessions))
    log.info("list_my_sessions", owner=user.sub, count=len(sessions))
    return [
        MySession(
            id=s.id,
            title=s.title,
            created_at=s.created_at,
            status=s.status,
            finalized=s.status == "finalized",
        )
        for s in sessions
    ]


# ---- GitHub App: per-user repo linking (ADR-0028) --------------------------
def _github_app_client() -> GitHubAppClient | None:
    """設定済みなら App クライアントを返す。未設定はフェイルクローズ（None）。"""
    if not (
        settings.github_app_enabled and settings.github_app_id and settings.github_app_private_key
    ):
        return None
    return GitHubAppClient(
        settings.github_app_id,
        settings.github_app_private_key,
        oauth_client_id=settings.github_app_client_id,
        oauth_client_secret=settings.github_app_client_secret,
    )


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


class SelectRepoRequest(BaseModel):
    repo: str  # "owner/name"
    # 省略時はデフォルトブランチを使う（ADR-0028: branch 既定=デフォルト）。
    branch: str | None = None


class SessionGitHubResponse(BaseModel):
    repo: str | None = None
    branch: str | None = None
    commit_sha: str | None = None
    status: str = "none"


@app.get("/api/github/link", response_model=GitHubLinkStatus)
def github_link_status(user: AuthUser = Depends(require_user)) -> GitHubLinkStatus:
    """本人の GitHub 連携状態を返す（設定画面の表示用）。"""
    link = _repo.get_github_link(user.sub)
    return GitHubLinkStatus(
        linked=link is not None,
        github_login=link.github_login if link else None,
    )


@app.post("/api/github/link/start", response_model=GitHubLinkStart)
def github_link_start(user: AuthUser = Depends(require_user)) -> GitHubLinkStart:
    """連携開始: 署名 state 付きの GitHub App インストール URL を返す（ADR-0028）。

    state に検証済み sub を束縛し、callback で CSRF/誤紐づけを防ぐ。
    """
    # callback と同じ必須設定（app_id/private_key）も開始時に確認してフェイルクローズする
    # （Codex P2: slug だけ設定で install へ送ると、戻りの callback が 503 で連携失敗するため）。
    client = _github_app_client()
    if client is None or not settings.github_app_slug:
        raise HTTPException(status_code=503, detail="github app not configured")
    # 所有権検証に必要な OAuth が無い本番では、install させても callback で拒否されるので
    # 開始時点でも止める（Codex P1。dev bypass 時のみ許可）。
    if not client.oauth_configured and not settings.auth_dev_bypass:
        raise HTTPException(status_code=503, detail="ownership verification not configured")
    state = create_link_state(
        user.sub, settings.session_signing_secret, settings.github_link_state_ttl_seconds
    )
    install_url = (
        f"https://github.com/apps/{settings.github_app_slug}/installations/new?state={state}"
    )
    return GitHubLinkStart(install_url=install_url)


@app.get("/api/github/link/callback")
def github_link_callback(installation_id: int, state: str, code: str | None = None) -> JSONResponse:
    """GitHub からの install コールバック。state を検証して連携を保存する（ADR-0028）。

    認証ヘッダは無い（GitHub リダイレクト）。署名 state が sub を束縛し CSRF を防ぐが、
    state だけでは「その sub が当該 installation を保有するか」は証明できない。OAuth
    （user-to-server）を構成している場合は `code` から所有権を検証してから保存し、別人の
    installation_id 横取りを防ぐ（Codex P1）。OAuth 未構成の dev/local では検証を省く。
    """
    client = _github_app_client()
    if client is None:
        raise HTTPException(status_code=503, detail="github app not configured")
    try:
        sub = verify_link_state(state, settings.session_signing_secret)
    except InvalidLinkState as exc:
        log.warning("github_link_state_rejected", reason=str(exc))
        raise HTTPException(status_code=403, detail=f"invalid state: {exc}") from exc

    # 所有権検証はフェイルクローズ（Codex P1）: OAuth 未構成なら本番では拒否する。秘密鍵だけ
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
    # 連携保存後は web の設定画面へ戻す（api callback とは別の web URL / Codex P2）。
    if settings.github_app_web_return_url:
        return JSONResponse(
            status_code=302,
            content={"linked": True},
            headers={"Location": f"{settings.github_app_web_return_url}?linked=1"},
        )
    return JSONResponse(content={"linked": True, "github_login": login})


@app.delete("/api/github/link", response_model=GitHubLinkStatus)
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


@app.get("/api/github/repos", response_model=GithubReposResponse)
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
    # 既定リポジトリも許可リストを通す（Codex P2: 許可外の既定はリポ名の露出になり、
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
        # 許可リスト（設定時）は App 由来の候補にも一貫適用する（Codex P1 と同旨。connector
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
    # メンバーである環境で、共有トークンが読める private リポ名を漏らさない（Codex P1）。
    repos = [r for r in github_export.list_repos(settings.github_token) if _github_repo_allowed(r)]
    log.info("github_repos_listed", count=len(repos), sub=user.sub, source="connector")
    return GithubReposResponse(enabled=True, repos=repos, default=default)


@app.get("/api/github/branches", response_model=GitHubBranchesResponse)
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
        # 古いジョブの巻き戻し防止（Codex P2）: repo A の索引中に B へ選び直すと、遅れて走る A の
        # ジョブが B の chunk を消し A を書き戻し得る。開始時に現在の選択（SessionMeta）がこの
        # ジョブの (repo,branch,sha) と一致するか確認し、ズレていれば何もしない。
        if not _selection_current(session_id, repo, branch, commit_sha):
            log.info("repo_index_skipped_stale", session=session_id, repo=repo, branch=branch)
            return
        # repo 選び直し / branch 変更 / 再同期で古い github: chunk が残ると search_grounding に
        # 旧 commit の断片が混ざる。索引前に当該 session の repo chunk を一掃する（Codex P2）。
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
            # （index_context が別途マスク）とは別に保存前にも両方を通す（Codex P2）。
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
        # 共有 HTTP クライアントを必ず閉じる（接続リーク防止 / Codex P2）。
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


@app.post("/api/sessions/{session_id}/github", response_model=SessionGitHubResponse)
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
    # 許可リスト（GITHUB_REPO_ALLOWLIST）は App 経路の保存にも一貫適用する（Codex P1 と
    # 同旨。候補一覧に出ないリポを直接 POST で紐づけ・索引する抜け道を塞ぐ）。
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


@app.get("/api/sessions/{session_id}/github", response_model=SessionGitHubResponse)
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


# ---- Products (ADR-0031) ----------------------------------------------------
class CreateProductRequest(BaseModel):
    """`POST /api/products`（FR-1.1）。name はハンドラ側で strip + 空を 400 にする。"""

    name: str = Field(max_length=200)
    description: str = Field(default="", max_length=2000)
    # 利用者向け語彙（ADR-0032 でプロンプトにシード）。件数はここで、各語の長さは
    # `_clean_glossary` で制限する（Firestore 文書とプロンプトの肥大防止）。
    glossary: list[str] = Field(default_factory=list, max_length=100)


class UpdateProductRequest(BaseModel):
    """`PATCH /api/products/{id}`（FR-1.2）。None = 変更しない（部分更新）。"""

    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    glossary: list[str] | None = Field(default=None, max_length=100)


class ProductResponse(BaseModel):
    """product の応答形。owner_sub は載せない（本人/管理者しか読めない一覧でも
    不要な識別子は返さない。MySession の最小権限方針と同じ）。"""

    id: str
    name: str
    description: str
    glossary: list[str]
    created_at: datetime
    github_repo: str | None = None
    github_branch: str | None = None
    github_commit_sha: str | None = None
    github_index_status: str = "none"


class DeleteProductResponse(BaseModel):
    deleted: bool


def _product_response(product: Product) -> ProductResponse:
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
    )


def _clean_glossary(glossary: list[str]) -> list[str]:
    """利用者向け語彙を正規化する: 前後空白を除き、空要素を捨て、過長は 400。"""
    cleaned = [g.strip() for g in glossary]
    cleaned = [g for g in cleaned if g]
    if any(len(g) > 100 for g in cleaned):
        raise HTTPException(status_code=400, detail="glossary term too long (max 100 chars)")
    return cleaned


def _require_product_access(product_id: str, user: AuthUser) -> Product:
    """product 認可の一点集約（ADR-0031 決定5 / 要件 NFR-6）: owner または admin のみ。

    非所有・不存在はどちらも 404 に平す（`/api/sessions/mine/{id}` と同じ:
    応答差で他人の product ID の存在を漏らさない）。org / テナントを将来導入する
    ときは、この関数の判定を sub → org → product に差し替える（他の場所に判定を
    増やさない）。web 側の判定は表示制御のみで、認可の源泉は常にここ。
    """
    product = _repo.get_product(product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="product not found")
    if product.owner_sub != user.sub and not is_admin(user):
        raise HTTPException(status_code=404, detail="product not found")
    return product


@app.post("/api/products", response_model=ProductResponse)
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
@app.get("/api/products/mine", response_model=list[ProductResponse])
def list_my_products(user: AuthUser = Depends(require_user)) -> list[ProductResponse]:
    """本人 (owner_sub) の product 一覧を新しい順で返す（FR-1.1）。他人のは返さない。"""
    products = _repo.list_products_by_owner(user.sub)
    log.info("my_products_listed", owner=user.sub, count=len(products))
    return [_product_response(p) for p in products]


@app.get("/api/products/{product_id}", response_model=ProductResponse)
def get_product(product_id: str, user: AuthUser = Depends(require_user)) -> ProductResponse:
    """product 詳細（owner / admin。FR-1.2）。"""
    return _product_response(_require_product_access(product_id, user))


@app.patch("/api/products/{product_id}", response_model=ProductResponse)
def update_product(
    product_id: str, req: UpdateProductRequest, user: AuthUser = Depends(require_user)
) -> ProductResponse:
    """name / description / glossary のみ更新する（FR-1.2）。所有・出所は不変。"""
    _require_product_access(product_id, user)
    name = req.name.strip() if req.name is not None else None
    if name == "":
        raise HTTPException(status_code=400, detail="name must not be empty")
    glossary = _clean_glossary(req.glossary) if req.glossary is not None else None
    description = req.description.strip() if req.description is not None else None
    try:
        updated = _repo.update_product(
            product_id, name=name, description=description, glossary=glossary
        )
    except ProductNotFound as exc:
        # 認可チェック後に消えた競合。存在秘匿の方針に合わせ 404 のまま返す。
        raise HTTPException(status_code=404, detail="product not found") from exc
    record_product_event("updated")
    log.info("product_updated", product=product_id, owner=user.sub)
    return _product_response(updated)


@app.delete("/api/products/{product_id}", response_model=DeleteProductResponse)
def delete_product(
    product_id: str, user: AuthUser = Depends(require_user)
) -> DeleteProductResponse:
    """product を配下の深掘りリンクごと削除する（FR-1.2）。

    grounding 索引に入れた repo chunk も一緒に掃除する（消し漏れると
    search_grounding に親なし product の断片が残る）。
    """
    _require_product_access(product_id, user)
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


@app.post("/api/products/{product_id}/github", response_model=SessionGitHubResponse)
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
    product = _require_product_access(product_id, user)
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
    """深掘りリンク入場の結果（FR-1.6）。

    LiveKit トークンはここでは発行しない: 返した `invite`（create_session が返すものと
    同じ署名付き役割 invite）を既存 `POST /api/sessions/join` に渡して交換する。
    トークン発行・identity 束縛・レート制限のロジックを join 1 箇所に保つための分割。
    """

    session_id: str
    invite: str
    product_id: str
    product_name: str
    interview_mode: str


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


@app.post("/api/products/{product_id}/invites", response_model=ProductInviteResponse)
def create_product_invite(
    product_id: str, req: CreateProductInviteRequest, user: AuthUser = Depends(require_user)
) -> ProductInviteResponse:
    """深掘りリンクを発行する（FR-1.5）。

    発行は owner のみ（admin 不可）: リンクは owner が準備した product への入場券であり、
    repo 紐づけ（owner の installation）と同じく所有者の意思で発行する。
    """
    product = _require_product_access(product_id, user)
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


@app.get("/api/products/{product_id}/invites", response_model=list[ProductInviteResponse])
def list_product_invites(
    product_id: str, user: AuthUser = Depends(require_user)
) -> list[ProductInviteResponse]:
    """発行済み深掘りリンクの一覧（owner / admin。FR-1.5 の管理 UI 用）。"""
    _require_product_access(product_id, user)
    return [_invite_response(i) for i in _repo.list_invites(product_id)]


@app.post(
    "/api/products/{product_id}/invites/{invite_id}/revoke",
    response_model=ProductInviteResponse,
)
def revoke_product_invite(
    product_id: str, invite_id: str, user: AuthUser = Depends(require_user)
) -> ProductInviteResponse:
    """深掘りリンクを失効させる（owner / admin。FR-1.5）。冪等（既失効でも 200）。"""
    _require_product_access(product_id, user)
    if not _repo.revoke_invite(product_id, invite_id):
        raise HTTPException(status_code=404, detail="invite not found")
    invite = _repo.get_invite(product_id, invite_id)
    if invite is None:  # revoke 直後の削除と競合した稀ケース
        raise HTTPException(status_code=404, detail="invite not found")
    record_product_event("invite_revoked")
    log.info("invite_revoked", product=product_id, invite=invite_id, by=user.sub)
    return _invite_response(invite)


@app.post("/api/products/join", response_model=ProductJoinResponse)
def join_product(
    req: ProductJoinRequest, user: AuthUser = Depends(require_user)
) -> ProductJoinResponse:
    """深掘りリンクからセッションを自動作成する（FR-1.6 / ADR-0031 決定3）。

    Stage 1 はログイン必須（ゲスト入場は ADR-0032 の guest_join_enabled 待ち）。
    検証は二段: 署名（owner が発行した本物のリンクか）→ invite 文書
    （失効・期限・回数をトランザクションで消費。文書側が正）。02 準備は出さず、
    ゴール（title）と repo 設定は product から継承する（FR-1.4）。
    レート制限はミドルウェア `_rate_limit_join` が body 解析前に掛ける。
    """
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
    # 消費（use_count++）は最後の関門: consent・署名を先に検証し、失敗する要求で
    # 使用回数を減らさない。文書照合と消費は原子的（ADR-0031 / consume_invite）。
    try:
        invite = _repo.consume_invite(claim.product_id, claim.invite_id)
    except InviteNotFound as exc:
        raise HTTPException(status_code=404, detail="invite not found") from exc
    except InviteNotUsable as exc:
        log.warning(
            "product_invite_not_usable",
            product=claim.product_id,
            invite=claim.invite_id,
            reason=exc.reason,
        )
        raise HTTPException(status_code=403, detail=f"invite not usable: {exc.reason}") from exc
    product = _repo.get_product(claim.product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="product not found")

    role = _INVITE_ROLE[invite.scope]
    session_id = f"sess-{uuid.uuid4().hex[:8]}"
    _repo.create_session_doc(
        SessionMeta(
            id=session_id,
            title=product.name,
            owner_sub=user.sub,
            owner_email=user.email,
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
        )
    )
    session_invite = create_invite(
        session_id, role, settings.session_signing_secret, settings.invite_ttl_seconds
    )
    record_product_event("invite_redeemed")
    log.info(
        "session_created",
        session=session_id,
        roles=[role],
        owner=user.sub,
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
    )
    return ProductJoinResponse(
        session_id=session_id,
        invite=session_invite,
        product_id=product.id,
        product_name=product.name,
        interview_mode=invite.scope.value,
    )


class MySessionRequirementsResponse(BaseModel):
    """`GET /api/sessions/mine/{id}/requirements` の応答。

    過去セッションの要件絵巻閲覧画面 (web /sessions/{id}) に、見出し用の最小メタ
    (標題・作成時刻・確定状態) と要件スナップショットをまとめて供給する。
    items は契約 §3 の requirement 形 (get_requirements と同じ contract 形) で、
    PII (owner_email/owner_sub) は MySession と同じく載せない (最小権限)。
    """

    id: str
    title: str
    created_at: datetime
    finalized: bool
    items: list[dict[str, Any]]


@app.get(
    "/api/sessions/mine/{session_id}/requirements",
    response_model=MySessionRequirementsResponse,
)
def get_my_session_requirements(
    session_id: str, user: AuthUser = Depends(require_user)
) -> MySessionRequirementsResponse:
    """本人 (owner_sub) の過去セッションの要件絵巻を返す。

    ホーム「過去の要件を見る」(#215/#250) からの詳細閲覧。join 済みトークンは会話終了後には
    残らないため、`require_session_access` ではなく idToken (ADR-0012) で本人確認し、
    owner_sub 一致で認可する。非所有・不存在はどちらも 404 に平す (他人のセッション ID の
    存在を応答差で漏らさない)。
    """
    session = _repo.get_session(session_id)
    if session is None or session.owner_sub != user.sub:
        raise HTTPException(status_code=404, detail="session not found")
    # 確定済みは finalize 時の凍結スナップショットだけを見せる（Codex P1）。確定後に遅延 agent
    # が追加した要件や管理画面 API での却下を混ぜず、export と同じ成果物を表示する。
    # 未確定（進行中）は現在の全要件を出す（会話中の絵巻タブと同じ見え方）。
    if session.status == "finalized":
        items = _finalized_snapshot_requirements(session)
    else:
        items = _read_repo.list_requirements(session_id)
    record_my_requirements_viewed(len(items))
    log.info("my_requirements_viewed", session=session_id, owner=user.sub, count=len(items))
    return MySessionRequirementsResponse(
        id=session.id,
        title=session.title,
        created_at=session.created_at,
        finalized=session.status == "finalized",
        items=items,
    )


@app.post("/api/sessions/{session_id}/context", response_model=ContextResponse)
def add_context(
    session_id: str,
    req: ContextRequest,
    access: SessionAccess = Depends(require_session_access),
) -> ContextResponse:
    """Register reference text for a session; chunks go to RAG grounding.

    認可（契約 §4）: join 済みセッショントークン必須。これが無いと匿名で任意
    session_id の RAG グラウンディングを汚染できてしまう（参加者以外の書き込み禁止）。
    """
    if len(req.text) > settings.max_context_chars:
        raise HTTPException(status_code=413, detail="context too large")
    chunks = chunk_text(req.text)
    n = _indexer.index_context(session_id, chunks, req.source_name)
    log.info("context_indexed", session=session_id, chunks=n, sub=access.sub)
    return ContextResponse(indexed_chunks=n)


@app.post("/api/sessions/{session_id}/context/file", response_model=ContextResponse)
async def add_context_file(
    session_id: str,
    file: UploadFile = File(...),
    access: SessionAccess = Depends(require_session_access),
) -> ContextResponse:
    """Register an uploaded file as session context.

    認可（契約 §4）: join 済みセッショントークン必須（text 版と同じく参加者限定）。これが
    無いと匿名で任意 session_id の grounding を汚染できてしまう。

    txt/md/pdf はテキストとして grounding 索引に入れる（既存）。画像/動画は Cloud Storage に
    保存し、安定 `asset_id` を返す（issue #103 / ADR-0004）。画像は Gemini で観察を抽出して
    grounding に流し、agent が問いの根拠にできるようにする。動画解析は未実装のため保存のみ
    （`analysis_pending=true`、web では「準備中」）。非対応形式は 415 で弾く。

    観測性: アップロード〜解析を span/log で追い、素材数を kind/result で計測する（契約 §5）。
    """
    filename = file.filename or "upload"
    raw = await file.read()

    # 既存のテキスト経路（txt/md/pdf）。
    if is_text_upload(filename, file.content_type):
        if len(raw) > settings.max_context_chars * 4:  # bytes guard (~utf-8 worst case)
            raise HTTPException(status_code=413, detail="file too large")
        text = extract_text_from_upload(filename, raw)
        chunks = chunk_text(text)
        n = _indexer.index_context(session_id, chunks, filename)
        return ContextResponse(indexed_chunks=n)

    kind = asset_kind(filename, file.content_type)
    if kind is None:
        # 非対応拡張子（web ピッカでも弾くが、API でもフェイルクローズ）。
        record_asset_upload("unknown", "rejected")
        raise HTTPException(
            status_code=415, detail="unsupported file type (allowed: png/jpg/mp4/mov, txt/md/pdf)"
        )
    if len(raw) > settings.max_asset_bytes:
        record_asset_upload(kind, "rejected")
        raise HTTPException(status_code=413, detail="file too large")

    tracer = _get_tracer()
    span_cm = (
        tracer.start_as_current_span("context.file.asset") if tracer else contextlib.nullcontext()
    )
    with span_cm as span:
        if span is not None:
            span.set_attribute("sanba.asset.kind", kind)
            span.set_attribute("sanba.asset.size", len(raw))
        content_type = resolve_content_type(filename, file.content_type, kind)
        asset = _asset_store.store(session_id, kind, content_type, raw)
        if span is not None:
            span.set_attribute("sanba.asset.id", asset.asset_id)

        # 解析の境界を web へ live 配信する（#145 / ADR-0023）。publish は付加価値なので
        # 失敗してもアップロードを止めない（GET context/files でも状態を復元できる）。
        sender = (
            build_sender(
                settings.livekit_url,
                settings.livekit_api_key,
                settings.livekit_api_secret,
                session_id,
            )
            if settings.enable_realtime_publish
            else NullSender()
        )
        publisher = AnalysisPublisher(session_id, sender, _repo)
        with contextlib.suppress(Exception):
            await publisher.progress(asset.asset_id, STAGE_RECEIVED)

        # 動画解析は未実装: 保存のみ済ませ、web には「準備中」を返す。
        if kind == "video" and not settings.enable_video_analysis:
            record_asset_upload("video", "pending")
            # 素材一覧（GET context/files / #184）へ永続化。動画は解析未実装のため analyzing。
            _repo.save_material(
                session_id, material_record(asset.asset_id, filename, kind, status="analyzing")
            )
            log.info(
                "asset_pending",
                session=session_id,
                asset_id=asset.asset_id,
                kind=kind,
                sub=access.sub,
            )
            return ContextResponse(
                indexed_chunks=0,
                asset_id=asset.asset_id,
                asset_kind=kind,
                analysis_pending=True,
            )

        # 画像: Gemini で観察を抽出し、grounding 索引へ（asset を出所に紐づける）。
        with contextlib.suppress(Exception):
            await publisher.progress(asset.asset_id, STAGE_ANALYZING)
        try:
            observations = analyze_image(raw, content_type)
        except Exception:
            # 解析失敗を web へ通知し再試行導線を出せるようにする（ADR-0023 §3）。
            with contextlib.suppress(Exception):
                await publisher.progress(asset.asset_id, STAGE_FAILED)
            record_asset_upload(kind, "rejected")
            raise
        indexed = 0
        if observations:
            indexed = _indexer.index_context(session_id, observations, f"asset:{asset.asset_id}")
        record_asset_upload(kind, "analyzed")
        # 素材一覧（GET context/files / #184）へ永続化。画像は同期解析済みなので done。
        _repo.save_material(
            session_id,
            material_record(
                asset.asset_id, filename, kind, status="done", extracted=len(observations)
            ),
        )
        # 解析完了を web へ（pct=100・抽出要件）。conflicts は突合実装まで空（ADR-0023 §2）。
        with contextlib.suppress(Exception):
            await publisher.visual(asset.asset_id, observations)
        log.info(
            "asset_analyzed",
            session=session_id,
            asset_id=asset.asset_id,
            kind=kind,
            observations=len(observations),
            sub=access.sub,
        )
        return ContextResponse(
            indexed_chunks=indexed,
            asset_id=asset.asset_id,
            asset_kind=kind,
        )


@app.post("/api/sessions/{session_id}/telemetry", response_model=TelemetryResponse)
def post_telemetry(
    session_id: str,
    body: TelemetryRequest,
    access: SessionAccess = Depends(require_session_access),
) -> TelemetryResponse:
    """web UI 由来の素材イベント（投入種別 #232 / 中断 #243）を OTLP カウンタへ集約する。

    認可（契約 §4）: join 済みセッショントークン必須（匿名のメトリクス汚染を塞ぐ）。
    第三者クライアント分析 SDK は導入せず、既存 metrics 基盤（observability.py）に載せる
    （CLAUDE.md 原則3）。PII/自由記述は受けない: event は許可リスト、属性は列挙値のみ
    （未知値は other に丸めて高カーディナリティ/PII 流入を防ぐ）。送信側は失敗を握りつぶす
    （best-effort）ため、ここでの 422 は UX を止めない。
    """
    if body.event not in _TELEMETRY_EVENTS:
        raise HTTPException(status_code=422, detail="unknown telemetry event")
    source = _enum_or_other(body.source, _TELEMETRY_SOURCES)
    status = _enum_or_other(body.status, _TELEMETRY_STATUSES)
    result = _enum_or_other(body.result, _TELEMETRY_RESULTS)
    record_material_event(body.event, source=source, status=status, result=result)
    log.info(
        "material_event",
        session=session_id,
        event_name=body.event,
        source=source,
        status=status,
        result=result,
        sub=access.sub,
    )
    return TelemetryResponse(recorded=True)


@app.delete(
    "/api/sessions/{session_id}/context/file/{asset_id}",
    response_model=DeleteContextFileResponse,
)
def delete_context_file(
    session_id: str,
    asset_id: str,
    access: SessionAccess = Depends(require_session_access),
) -> DeleteContextFileResponse:
    """投入済み素材の「真の破棄」（#245）。binary・material メタ・grounding 索引をまとめて消す。

    認可（契約 §4）: join 済みセッショントークン必須（参加者以外の削除を塞ぐ）。
    #219/#241 のクライアント破棄だけでは、画像はレスポンス前に grounding 索引と material(done)
    まで完了するため素材由来の観察が会話に残り、リロードで GET context/files から復活する。
    本 API で (1) 保存 binary、(2) material メタ、(3) 出所 `asset:{asset_id}` の grounding chunk
    をまとめて取り消し、以後の会話・ハイドレーションから外す。冪等: 存在しない asset でも 200 を
    一貫して返す（existed=false）。in-memory/ES/GCS 未接続のフォールバックでも安全に動く。
    """
    tracer = _get_tracer()
    span_cm = (
        tracer.start_as_current_span("context.file.delete") if tracer else contextlib.nullcontext()
    )
    with span_cm as span:
        if span is not None:
            span.set_attribute("sanba.asset.id", asset_id)
        # 索引→binary→メタの順で取り消す（grounding を最優先で会話から外す）。
        removed_index = _indexer.delete_context(session_id, f"asset:{asset_id}")
        removed_blob = _asset_store.delete(session_id, asset_id)
        removed_meta = _repo.delete_material(session_id, asset_id)
        existed = removed_blob or removed_meta or removed_index > 0
        if span is not None:
            span.set_attribute("sanba.asset.existed", existed)
            span.set_attribute("sanba.asset.index_removed", removed_index)
    # 破棄結果を #243 の telemetry 基盤へ計上する（中断率・破棄結果を運用で追う / 原則3）。
    record_material_event("material.discard", result="deleted" if existed else "not_found")
    log.info(
        "asset_discarded",
        session=session_id,
        asset_id=asset_id,
        existed=existed,
        index_removed=removed_index,
        blob_removed=removed_blob,
        meta_removed=removed_meta,
        sub=access.sub,
    )
    return DeleteContextFileResponse(deleted=True, existed=existed)


@app.post("/api/sessions/join", response_model=JoinResponse)
def join_session(
    req: JoinRequest,
    user: AuthUser = Depends(require_user),
) -> JoinResponse:
    """Exchange a valid invite for a scoped, short-lived LiveKit token.

    Two complementary checks (ADR-0012): the invite proves *which room/role*,
    the verified Google identity proves *who*. Both must hold. The LiveKit
    participant identity is derived from the verified `sub` (not a self-reported
    name) so the provenance metadata on captured requirements is trustworthy.
    """
    if settings.auth_dev_bypass and req.invite.startswith("dev:"):
        # Local-dev only: "dev:<session_id>:<role>" bypasses signing. Never in prod.
        _, session_id, role = req.invite.split(":", 2)
    else:
        try:
            invite = verify_invite(req.invite, settings.session_signing_secret)
        except InvalidInvite as exc:
            log.warning("invite_rejected", reason=str(exc))
            raise HTTPException(status_code=403, detail=f"invalid invite: {exc}") from exc
        session_id, role = invite.session_id, invite.role

    # 検証済み identity に束ねる: sub は metadata で追跡し、nonce で衝突を防ぐ。
    identity = f"{role}-{user.sub[:8]}-{uuid.uuid4().hex[:4]}"
    display_name = req.participant_name or user.name
    metadata = json.dumps({"role": role, "sub": user.sub, "email": user.email})
    try:
        token = (
            api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
            .with_identity(identity)
            .with_name(display_name)
            .with_metadata(metadata)
            .with_ttl(timedelta(minutes=settings.livekit_token_ttl_minutes))
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=session_id,  # scoped to exactly this room
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )
    except Exception as exc:  # pragma: no cover
        log.error("token_issue_failed", error=str(exc))
        raise HTTPException(status_code=500, detail="failed to issue token") from exc

    # ハイドレーション/起票 API を保護する署名トークン（契約 §4）。LiveKit トークンと
    # 同じ寿命にして、リロード時の GET /requirements が同じ間だけ通るようにする。
    session_token = create_session_token(
        session_id,
        user.sub,
        role,
        settings.session_signing_secret,
        ttl_seconds=settings.livekit_token_ttl_minutes * 60,
    )

    log.info("session_join", session=session_id, identity=identity, role=role, sub=user.sub)
    return JoinResponse(
        token=token,
        livekit_url=settings.livekit_url,
        session_id=session_id,
        identity=identity,
        session_token=session_token,
    )


# ---- Admin: 運用画面 (ADR-0014) -------------------------------------------
# すべて require_admin でガードする。閲覧は requirements のみ。生の発話 (utterances) は
# プライバシー方針 (issue #10 / ADR-0014 §3) のため一切返さない。
class UpdateRequirementRequest(BaseModel):
    """要件の編集/承認リクエスト。

    statement/priority/category は上書き (None は据え置き)。出所メタは変更できない (§10)。
    status を指定すると承認/却下/差し戻しを行う (§11)。両方を一度に指定してもよい。
    """

    statement: str | None = None
    priority: str | None = None
    category: str | None = None
    status: RequirementStatus | None = None


@app.get("/api/admin/sessions", response_model=list[SessionMeta])
def admin_list_sessions(admin: AuthUser = Depends(require_admin)) -> list[SessionMeta]:
    """全セッションのメタ一覧 (MVP: ページングなし / ADR-0014 保留事項)。"""
    sessions = _repo.list_sessions()
    log.info("admin_list_sessions", admin=admin.email, count=len(sessions))
    return sessions


@app.get(
    "/api/admin/sessions/{session_id}/requirements",
    response_model=list[Requirement],
)
def admin_list_requirements(
    session_id: str, admin: AuthUser = Depends(require_admin)
) -> list[Requirement]:
    """セッションの要件一覧。発話 (utterances) は返さない。"""
    if _repo.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    reqs = _repo.list_requirements(session_id)
    log.info("admin_list_requirements", admin=admin.email, session=session_id, count=len(reqs))
    return reqs


@app.patch(
    "/api/admin/sessions/{session_id}/requirements/{rid}",
    response_model=Requirement,
)
def admin_update_requirement(
    session_id: str,
    rid: str,
    req: UpdateRequirementRequest,
    admin: AuthUser = Depends(require_admin),
) -> Requirement:
    """要件を編集・承認する (ADR-0014 §10,§11)。

    編集 (statement/priority/category) を先に適用してから status 遷移を行う。
    承認時は TTL を解除し成果物として保全する。
    """
    # セッション ID 誤りと要件 ID 誤りを区別する (admin_list_requirements と対称)。
    if _repo.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    try:
        if req.statement is not None or req.priority is not None or req.category is not None:
            current = _repo.update_requirement(
                session_id,
                rid,
                statement=req.statement,
                priority=req.priority,
                category=req.category,
            )
        else:
            found = _repo.get_requirement(session_id, rid)
            if found is None:
                raise RequirementNotFound(rid)
            current = found

        if req.status is not None:
            current = _repo.set_requirement_status(
                session_id, rid, req.status, approved_by=admin.email
            )
    except RequirementNotFound as exc:
        raise HTTPException(status_code=404, detail="requirement not found") from exc
    except ValueError as exc:
        # enum 不正など (priority/category の不正値) は 422 相当。
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    log.info(
        "admin_update_requirement",
        admin=admin.email,
        session=session_id,
        rid=rid,
        status=current.status,
    )
    return current


# ── ハイドレーション & 起票 API（契約 §4 / Issue #100）─────────────────────────


@app.get("/api/sessions/{session_id}/requirements", response_model=RequirementsResponse)
def get_requirements(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> RequirementsResponse:
    """確定/下書き要件のスナップショット（契約 §4 P0）。08/09 のハイドレーション前提。"""
    items = _read_repo.list_requirements(session_id)
    seq = _read_repo.get_session_seq(session_id)
    log.info("requirements_hydrated", session=session_id, count=len(items), seq=seq, sub=access.sub)
    return RequirementsResponse(items=items, seq=seq)


@app.get("/api/sessions/{session_id}/detections", response_model=DetectionsResponse)
def get_detections(
    session_id: str,
    open: int = 1,
    access: SessionAccess = Depends(require_session_access),
) -> DetectionsResponse:
    """未解消の矛盾/抜け（契約 §4 P1）。05/08 の途中参加復元に使う。"""
    items = _read_repo.list_open_detections(session_id)
    log.info("detections_hydrated", session=session_id, count=len(items), open=open)
    return DetectionsResponse(items=items)


@app.get(
    "/api/sessions/{session_id}/questions/current",
    response_model=CurrentQuestionResponse,
)
def get_current_question(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> CurrentQuestionResponse:
    """現在の未回答質問（金枠ピン）のスナップショット（契約 §4 / #212 / ADR-0020）。

    リロード/途中参加で未回答の問いピンを復元する。回答済み（tombstone）/未提示なら
    `question=null` を返すが、その場合も `seq`（クリア時点の `cleared_seq`）を返すことで、
    web は「遅延 null が新しい live 質問を消す」逆転を防げる（§5-4）。既存 3 GET と完全に同じ
    認可（`require_session_access`）・形にする。
    """
    snap = _read_repo.get_current_question(session_id)
    has_question = snap["question"] is not None
    record_question_hydration(has_question)
    log.info(
        "question_hydrated",
        session=session_id,
        has_question=has_question,
        seq=snap["seq"],
        sub=access.sub,
    )
    return CurrentQuestionResponse(question=snap["question"], seq=snap["seq"])


@app.get("/api/sessions/{session_id}/context/files", response_model=ContextFilesResponse)
def get_context_files(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> ContextFilesResponse:
    """投入済み素材のメタ一覧（契約 §4 #184）。05 参考資料のハイドレーション。

    リロード/再接続でローカル行（uploading/failed）が消えても、サーバ保持の実ファイル名と
    解析状態を復元する。realtime の analysis.progress/visual はライブ差分で重ねる。
    """
    items = _repo.list_materials(session_id)
    log.info("context_files_hydrated", session=session_id, count=len(items), sub=access.sub)
    return ContextFilesResponse(items=items)


@app.post("/api/sessions/{session_id}/finalize", response_model=FinalizeResponse)
def finalize_session_requirements(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> FinalizeResponse:
    """07 判定の「確定」を永続化する（#186）。

    会話を締めて要件を確定したとき、確定した要件件数のスナップショットを刻み、セッションを
    finalized にする（不可逆マーカ）。確定後の export（GitHub Issue）はこの件数と一致する。

    確定時集合は approved にして TTL（expireAt）を解除する（Codex P1）: 管理画面の承認 UI
    廃止に伴い、draft のまま 30 日 TTL で消えると過去要件閲覧（/sessions/{id}）と export が
    欠落するため、参加者の「確定」を成果物保全の起点にする。TTL 解除は既存の
    set_requirement_status（approved で expireAt 削除）に集約済みのものを再利用する。

    ガード（Codex P2）:
      - 既に finalized なら open 検知に関係なく保存済みスナップショット件数を返す（冪等）。
        確定後に遅延 agent が open 検知を保存しても、再送/リロードの再 POST が 409 にならない。
      - 未確定セッションは、未解消検知が 1 件でも残るなら 409 で拒否する（07 判定の
        「未解消 0 件で確定可」をサーバ側でも担保。直接 POST や古いクライアント状態を防ぐ）。
    """
    existing = _repo.get_session(session_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="session not found")
    # 冪等: 既に finalized なら未解消チェックより先に保存済みスナップショットを返す。
    if existing.status == "finalized":
        return FinalizeResponse(finalized=True, confirmed_count=existing.finalized_count or 0)
    # 新規確定のみ未解消ガードを適用する。
    if _read_repo.list_open_detections(session_id):
        raise HTTPException(status_code=409, detail="unresolved detections remain")
    confirmed = _confirmed_requirements(session_id)
    confirmed_ids = [r["id"] for r in confirmed]
    meta = _repo.finalize_session(
        session_id,
        confirmed_count=len(confirmed),
        finalized_requirement_ids=confirmed_ids,
    )
    if meta is None:
        raise HTTPException(status_code=404, detail="session not found")
    # 確定時集合を成果物として保全する: approved で expireAt が外れ 30 日 TTL の対象外になる
    # （Codex P1）。approved_by は確定操作の主体（join 済みトークンの sub）。
    for rid in confirmed_ids:
        try:
            _repo.set_requirement_status(
                session_id, rid, RequirementStatus.APPROVED, approved_by=access.sub
            )
        except RequirementNotFound:
            # 確定直前に TTL 失効等で消えた要件はスキップする（finalize 自体は成立させる）。
            log.warning("finalize_preserve_missing_requirement", session=session_id, rid=rid)
    count = meta.finalized_count if meta.finalized_count is not None else len(confirmed)
    log.info(
        "session_finalized",
        session=session_id,
        confirmed=count,
        id_count=len(meta.finalized_requirement_ids),
        sub=access.sub,
    )
    return FinalizeResponse(finalized=True, confirmed_count=count)


@app.post("/api/sessions/{session_id}/export", response_model=ExportResponse)
def export_requirements(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> ExportResponse:
    """確定要件を GitHub Issue として起票する（契約 §4 P1 / #39 ループ / #213）。

    finalize 時に凍結した要件 ID スナップショット（`finalized_requirement_ids`）の集合だけを
    起票する。凍結の定義（旧データのフォールバック含む）は _finalized_snapshot_requirements
    に一元化し、過去要件閲覧と共有する。
    """
    # コネクタ無効/トークン未設定は従来どおりセッション照会前に黙って断る（既定 OFF の不干渉）。
    if not (settings.github_connector_enabled and settings.github_token):
        return ExportResponse(exported=False, reason="github connector disabled")
    session = _repo.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    # 起票先の解決（ADR-0027）: セッション値が None のときだけ環境変数へフォールバックする。
    # 空文字は明示的な「連携しない」なのでフォールバックしない（Codex P2）。
    export_repo = session.github_repo if session.github_repo is not None else settings.github_repo
    if not export_repo:
        return ExportResponse(exported=False, reason="github connector disabled")
    # 解決後の値にも許可リストを掛ける（Codex P2: 一覧・保存で絞っても、フォールバック先の
    # 既定リポや allowlist 導入前に保存された値が許可外なら起票しない = fail-closed）。
    if not _github_repo_allowed(export_repo):
        log.warning("export_repo_not_allowed", session=session_id, repo=export_repo)
        return ExportResponse(exported=False, reason="github repo not allowed")
    # 確定時の要件 ID 集合だけを取得して起票する（再計算しない / #213）。
    confirmed = _finalized_snapshot_requirements(session)
    title, body = github_export.requirements_to_issue_body(confirmed, session_id)
    url = github_export.create_issue(settings.github_token, export_repo, title, body)
    if url is None:
        return ExportResponse(exported=False, reason="issue creation failed")
    log.info(
        "requirements_exported",
        session=session_id,
        count=len(confirmed),
        id_count=len(session.finalized_requirement_ids),
        repo=export_repo,
        session_selected=session.github_repo is not None,
        url=url,
        sub=access.sub,
    )
    return ExportResponse(exported=True, issue_url=url, count=len(confirmed))
