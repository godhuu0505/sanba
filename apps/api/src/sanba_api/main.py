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
import time
import uuid
from collections import defaultdict, deque
from datetime import timedelta
from typing import Any

import structlog
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel
from sanba_shared.models import Requirement, RequirementStatus, SessionMeta
from sanba_shared.repository import RequirementNotFound, SessionRepository

from . import github_export
from .auth import (
    InvalidInvite,
    InvalidSessionToken,
    SessionAccess,
    create_invite,
    create_session_token,
    verify_invite,
    verify_session_token,
)
from .auth_google import AuthUser, require_admin, require_user
from .config import settings
from .ingestion import ContextIndexer, chunk_text, extract_text_from_upload
from .observability import (
    record_asset_upload,
    record_material_event,
    record_question_hydration,
    setup_observability,
)
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
# OTLP エンドポイントが設定されていれば分散トレースを有効化する (未設定なら no-op)。
setup_observability(app)

# In-memory per-IP rate limiter for the join endpoint. Stateless workers can use
# a shared store (Redis/Firestore) later; this is enough to blunt abuse in the MVP.
_join_hits: dict[str, deque[float]] = defaultdict(deque)

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


def _github_ready() -> bool:
    return bool(
        settings.github_connector_enabled and settings.github_token and settings.github_repo
    )


def _confirmed_requirements(session_id: str) -> list[dict[str, Any]]:
    """会話確定軸（contract: confirmed）の要件のみを返す（確定判定の単一の定義 / #213）。

    `requirement_doc_to_contract` が管理軸 rejected を draft に落とすため、却下要件はここで
    除外される。確定判定はこの 1 箇所に集約し finalize のスナップショット算出だけが使う。
    export は finalize 済みスナップショット（`finalized_requirement_ids`）を起票するため
    この関数を呼ばない＝確定判定が finalize と export で重複しない（重複定義禁止）。
    """
    return [r for r in _read_repo.list_requirements(session_id) if r["status"] == "confirmed"]


def _rate_limit(client_ip: str) -> None:
    window_start = time.time() - 60
    hits = _join_hits[client_ip]
    while hits and hits[0] < window_start:
        hits.popleft()
    if len(hits) >= settings.join_rate_per_minute:
        raise HTTPException(status_code=429, detail="rate limit exceeded")
    hits.append(time.time())


# ---- Schemas ---------------------------------------------------------------
class CreateSessionRequest(BaseModel):
    title: str = "要件インタビュー"
    # Roles to mint invites for (owner shares these links with participants).
    roles: list[str] = ["pm", "engineer", "customer"]
    # Explicit consent to recording + AI processing (issue #10).
    consent_acknowledged: bool = False


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
        )
    )
    log.info("session_created", session=session_id, roles=req.roles, owner=user.sub)
    return CreateSessionResponse(session_id=session_id, invites=invites)


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
        observations = analyze_image(raw, content_type)
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
    req: JoinRequest, request: Request, user: AuthUser = Depends(require_user)
) -> JoinResponse:
    """Exchange a valid invite for a scoped, short-lived LiveKit token.

    Two complementary checks (ADR-0012): the invite proves *which room/role*,
    the verified Google identity proves *who*. Both must hold. The LiveKit
    participant identity is derived from the verified `sub` (not a self-reported
    name) so the provenance metadata on captured requirements is trustworthy.
    """
    _rate_limit(request.client.host if request.client else "unknown")

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
    finalized にする（不可逆マーカ）。要件カードの draft→approved 承認は管理画面の責務
    （ADR-0014）なのでここでは行わない。確定後の export（GitHub Issue）はこの件数と一致する。

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
    起票する。確定後に遅延 agent が要件を追加したり管理画面で却下されても、確定時集合を再計算
    せず固定する（Codex P2 / discussion_r3481706919）。未 finalize ならスナップショットは空。

    後方互換（Codex P1）: 本機能デプロイ前に finalized になった旧文書は ID スナップショットを
    持たない（既定 []）。`status==finalized` かつ確定件数 > 0 で ID 集合だけ欠落しているケースは
    旧挙動（確定要件の再計算）にフォールバックし、確定済みセッションを空 Issue 化しない。
    """
    if not _github_ready():
        return ExportResponse(exported=False, reason="github connector disabled")
    session = _repo.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    # 確定時の要件 ID 集合だけを取得して起票する（再計算しない / #213）。
    snapshot_ids = session.finalized_requirement_ids
    # 旧データのみ再計算へフォールバック（snapshot 欠落の finalized セッション / Codex P1）。
    # 新セッションは snapshot を正とし固定集合のまま（凍結保証を維持）。確定判定は
    # _confirmed_requirements に一元化済みのものを再利用する（重複定義しない）。
    legacy_finalized_without_snapshot = (
        not snapshot_ids and session.status == "finalized" and (session.finalized_count or 0) > 0
    )
    if legacy_finalized_without_snapshot:
        confirmed = _confirmed_requirements(session_id)
    else:
        confirmed = _read_repo.get_requirements_by_ids(session_id, snapshot_ids)
    title, body = github_export.requirements_to_issue_body(confirmed, session_id)
    url = github_export.create_issue(settings.github_token, settings.github_repo, title, body)
    if url is None:
        return ExportResponse(exported=False, reason="issue creation failed")
    log.info(
        "requirements_exported",
        session=session_id,
        count=len(confirmed),
        id_count=len(snapshot_ids),
        legacy_fallback=legacy_finalized_without_snapshot,
        url=url,
        sub=access.sub,
    )
    return ExportResponse(exported=True, issue_url=url, count=len(confirmed))
