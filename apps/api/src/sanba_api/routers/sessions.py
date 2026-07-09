"""セッション系ルート（main.py から分割 / 挙動不変）。

作成・本人一覧・join・素材投入（context / context file / telemetry / 削除）・
ハイドレーション GET・finalize・export・過去要件閲覧（mine/{id}）を持つ。
"""

from __future__ import annotations

import contextlib
import uuid
from datetime import UTC, datetime
from typing import Any

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sanba_shared.analytics import (
    COMPONENT_SUMMARY,
    COMPONENT_TITLE,
    COMPONENT_VISION,
    UsageRecorder,
)
from sanba_shared.inquiry import InquiryTree
from sanba_shared.models import (
    DEFAULT_SESSION_TITLE,
    Audience,
    InquiryNode,
    Product,
    RequirementStatus,
    SessionMeta,
    check_items_for_audience,
)
from sanba_shared.output_formats import resolve_output_format
from sanba_shared.repository import RequirementNotFound
from sanba_shared.result_document import (
    build_materials_block,
    issue_title,
    render_result_document,
    requirements_to_issue_labels,
)

from ..analytics import billing_labels, embedding_hook, usage_recorder
from ..auth import InvalidInvite, SessionAccess, create_invite, verify_invite
from ..auth_google import AuthUser, ensure_room_creator, require_user, require_user_bound
from ..config import settings
from ..deps import (
    _GITHUB_REPO_RE,
    JoinResponse,
    _asset_store,
    _confirmed_requirements,
    _finalized_snapshot_requirements,
    _get_tracer,
    _github_app_client,
    _github_repo_allowed,
    _indexer,
    _mint_join_tokens,
    _read_repo,
    _repo,
    _require_product_access,
    export_eligibility,
    forbid_guest_writes,
    require_session_access,
)
from ..ingestion import DocumentExtractionError, chunk_text, extract_text_from_upload
from ..observability import (
    record_asset_upload,
    record_join_ui_event,
    record_material_event,
    record_my_requirements_viewed,
    record_my_sessions_listed,
    record_question_hydration,
    record_result_document_rendered,
)
from ..realtime import (
    STAGE_ANALYZING,
    STAGE_FAILED,
    STAGE_RECEIVED,
    AnalysisPublisher,
    NullSender,
    build_sender,
)
from ..storage import (
    asset_kind,
    compute_asset_id,
    is_binary_document,
    is_text_upload,
    material_record,
    resolve_content_type,
)
from ..tasks import build_payload, enqueue_video_analysis
from ..titles import generate_conversation_summary, generate_requirement_title
from ..vision import analyze_image

log = structlog.get_logger(__name__)

router = APIRouter()


def _analytics_recorder(session_id: str) -> UsageRecorder:
    """セッション文脈（product_id / interview_mode）を束ねた ai_usage recorder（ADR-0061）。

    メタ読み取りの失敗でも文脈なし recorder に倒し、素材投入・確定の本処理を止めない。
    """
    meta = None
    try:
        meta = _repo.get_session(session_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("analytics_recorder_meta_failed", session=session_id, error=str(exc))
    return usage_recorder(
        session_id,
        repo=_repo,
        product_id=meta.product_id if meta is not None else None,
        interview_mode=meta.interview_mode.value if meta is not None else None,
    )


class CreateSessionRequest(BaseModel):
    title: str = DEFAULT_SESSION_TITLE
    roles: list[str] = ["pm", "engineer", "customer"]
    consent_acknowledged: bool = False
    github_repo: str | None = None
    product_id: str | None = None
    goal: str | None = Field(default=None, max_length=2000)
    goal_detail: str | None = Field(default=None, max_length=8000)


class CreateSessionResponse(BaseModel):
    session_id: str
    invites: dict[str, str]


class ContextRequest(BaseModel):
    text: str
    source_name: str = "uploaded"


class ContextResponse(BaseModel):
    indexed_chunks: int
    asset_id: str | None = None
    asset_kind: str | None = None
    analysis_pending: bool = False


class JoinRequest(BaseModel):
    invite: str
    participant_name: str


class RequirementsResponse(BaseModel):
    items: list[dict[str, Any]]
    seq: int = 0


class InquiryResponse(BaseModel):
    nodes: list[InquiryNode]
    seq: int = 0


class CurrentQuestionResponse(BaseModel):
    question: dict[str, Any] | None = None
    seq: int = 0


class ContextFilesResponse(BaseModel):
    items: list[dict[str, Any]]


class ExportResponse(BaseModel):
    exported: bool
    issue_url: str | None = None
    count: int | None = None
    doc_url: str | None = None
    reason: str | None = None


class ExportRequest(BaseModel):
    """GitHub Issue 起票の opt-in（P3・Q4）。いずれも既定 off。"""

    include_summary: bool = False
    include_materials: bool = False


class FinalizeResponse(BaseModel):
    finalized: bool
    confirmed_count: int = 0


_TELEMETRY_EVENTS = {"material.source_selected", "material.cancel", "join.abort"}
_TELEMETRY_SOURCES = {"camera", "screen", "upload", "drive"}
_TELEMETRY_STATUSES = {"uploading", "analyzing"}
_TELEMETRY_RESULTS = {"aborted", "discarded", "error"}


class TelemetryRequest(BaseModel):
    event: str
    source: str | None = None
    status: str | None = None
    result: str | None = None


class TelemetryResponse(BaseModel):
    recorded: bool


class DeleteContextFileResponse(BaseModel):
    deleted: bool
    existed: bool


def _enum_or_other(value: str | None, allowed: set[str]) -> str:
    """列挙値の検証。未指定は none、許可外は other へ丸める（PII/高カーディナリティ防止）。"""
    if value is None:
        return "none"
    return value if value in allowed else "other"


@router.post("/api/sessions", response_model=CreateSessionResponse)
def create_session(
    req: CreateSessionRequest, user: AuthUser = Depends(require_user_bound)
) -> CreateSessionResponse:
    """Create an interview room and mint a signed invite per role.

    Requires a verified Google identity (ADR-0012): only a logged-in owner can
    open a room. The invite still scopes which room/role a guest may join.
    ID トークンは nonce 束縛される（ADR-0047 §2 / require_user_bound）。
    """
    ensure_room_creator(user, operation="create_session")
    if settings.require_consent and not req.consent_acknowledged:
        raise HTTPException(
            status_code=400,
            detail="consent required: recording and AI processing must be acknowledged",
        )
    github_repo: str | None = None
    if req.github_repo is not None:
        github_repo = req.github_repo.strip()
        if github_repo and not _GITHUB_REPO_RE.match(github_repo):
            raise HTTPException(
                status_code=400, detail="github_repo must be in 'owner/name' format"
            )
        if github_repo and not _github_repo_allowed(github_repo):
            raise HTTPException(status_code=400, detail="github_repo is not allowed")
    product: Product | None = None
    if req.product_id is not None:
        product = _require_product_access(req.product_id, user)
    repo_fields: dict[str, Any] = {"github_repo": github_repo}
    if req.github_repo is None and product is not None:
        repo_fields = {
            "github_repo": product.github_repo,
            "github_branch": product.github_branch,
            "github_commit_sha": product.github_commit_sha,
            "github_index_status": product.github_index_status,
            "github_summary": product.github_summary,
        }
    session_id = f"sess-{uuid.uuid4().hex[:8]}"
    invites = {
        role: create_invite(
            session_id, role, settings.session_signing_secret, settings.invite_ttl_seconds
        )
        for role in req.roles
    }
    _repo.create_session_doc(
        SessionMeta(
            id=session_id,
            title=req.title,
            owner_sub=user.sub,
            owner_email=user.email,
            roles=req.roles,
            goal=(req.goal or "").strip() or None,
            goal_detail=(req.goal_detail or "").strip() or None,
            product_id=product.id if product is not None else None,
            **repo_fields,
        )
    )
    log.info(
        "session_created",
        session=session_id,
        roles=req.roles,
        owner=user.sub,
        github_repo=repo_fields.get("github_repo") or "(none)",
        product_id=product.id if product is not None else None,
    )
    return CreateSessionResponse(session_id=session_id, invites=invites)


class MySession(BaseModel):
    """`GET /api/sessions/mine` の 1 行。本人の履歴一覧 UI に供給する。

    PII (owner_email/owner_sub) は載せない: 本人だけが見る一覧でも不要な PII は返さない
    (最小権限 / CLAUDE.md セキュリティ)。一覧に要る最小項目 (標題・作成時刻・確定状態) だけ。
    詳細ルートは別 issue のため id 以上の内訳は持たせない。
    """

    id: str
    title: str
    created_at: datetime
    status: str
    finalized: bool
    labels: list[str] = []
    issue_url: str | None = None


@router.get("/api/sessions/mine", response_model=list[MySession])
def list_my_sessions(user: AuthUser = Depends(require_user)) -> list[MySession]:
    """ログインユーザー本人 (owner_sub) のセッション一覧を新しい順で返す。

    `require_user` (idToken をサーバ検証 / ADR-0012) で本人確認し、owner_sub が一致する
    ものだけを返す。他人のセッションは一切返さない (認可は本人限定)。ホームの
    「過去の要件を見る」履歴リストのデータ源。
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
            labels=s.labels,
            issue_url=s.exported_issue_url,
        )
        for s in sessions
    ]


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


@router.get(
    "/api/sessions/mine/{session_id}/requirements",
    response_model=MySessionRequirementsResponse,
)
def get_my_session_requirements(
    session_id: str, user: AuthUser = Depends(require_user)
) -> MySessionRequirementsResponse:
    """本人 (owner_sub) の過去セッションの要件絵巻を返す。

    ホーム「過去の要件を見る」からの詳細閲覧。join 済みトークンは会話終了後には
    残らないため、`require_session_access` ではなく idToken (ADR-0012) で本人確認し、
    owner_sub 一致で認可する。非所有・不存在はどちらも 404 に平す (他人のセッション ID の
    存在を応答差で漏らさない)。
    """
    session = _repo.get_session(session_id)
    if session is None or session.owner_sub != user.sub:
        raise HTTPException(status_code=404, detail="session not found")
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


class ResultDocumentResponse(BaseModel):
    """`GET /api/sessions/mine/{id}/result-document` の応答。

    audience（利用者/企画者/開発者）別の出力フォーマットで整形した要件結果ドキュメント。
    `is_custom_format` はアプリ管理画面で登録されたフォーマットが使われたか（false =
    既定テンプレートへフォールバック）。web が「既定フォーマット」表示に使う。
    """

    audience: str
    is_custom_format: bool
    markdown: str


@router.get(
    "/api/sessions/mine/{session_id}/result-document",
    response_model=ResultDocumentResponse,
)
def get_my_session_result_document(
    session_id: str, audience: Audience, user: AuthUser = Depends(require_user)
) -> ResultDocumentResponse:
    """本人 (owner_sub) のセッションの要件結果を audience 別フォーマットで整形して返す。

    要件の選択は `get_my_session_requirements` と同じ（確定済みは finalize 時の凍結
    スナップショット、進行中は現在の全要件）で、閲覧とドキュメントの内容がずれない。
    フォーマットはセッションが従属する product の登録値 →（未登録・単発セッションは）
    既定テンプレートの順で解決する（`resolve_output_format`）。認可も同エンドポイントと
    同じ owner_sub 一致・非所有/不存在は 404 に平す。
    """
    session = _repo.get_session(session_id)
    if session is None or session.owner_sub != user.sub:
        raise HTTPException(status_code=404, detail="session not found")
    if session.status == "finalized":
        items = _finalized_snapshot_requirements(session)
    else:
        items = _read_repo.list_requirements(session_id)
    product: Product | None = None
    if session.product_id:
        product = _repo.get_product(session.product_id)
    template, is_custom = resolve_output_format(product, audience)
    markdown = render_result_document(
        template,
        session_title=session.title,
        app_name=product.name if product is not None else None,
        goal=session.goal,
        date=datetime.now(UTC).strftime("%Y-%m-%d"),
        requirements=items,
        check_items=(
            check_items_for_audience(product.check_items, audience) if product is not None else []
        ),
        inquiry_nodes=_repo.list_inquiry_nodes(session_id),
    )
    record_result_document_rendered(audience.value, is_custom)
    log.info(
        "result_document_rendered",
        session=session_id,
        owner=user.sub,
        audience=audience.value,
        is_custom_format=is_custom,
        requirement_count=len(items),
    )
    return ResultDocumentResponse(
        audience=audience.value, is_custom_format=is_custom, markdown=markdown
    )


@router.post("/api/sessions/{session_id}/context", response_model=ContextResponse)
def add_context(
    session_id: str,
    req: ContextRequest,
    access: SessionAccess = Depends(require_session_access),
) -> ContextResponse:
    """Register reference text for a session; chunks go to RAG grounding.

    認可（契約 §4）: join 済みセッショントークン必須。これが無いと匿名で任意
    session_id の RAG グラウンディングを汚染できてしまう（参加者以外の書き込み禁止）。
    ゲスト token（ADR-0032 決定4）は読取専用のため素材投入は不可。
    """
    forbid_guest_writes(access, "context")
    if len(req.text) > settings.max_context_chars:
        raise HTTPException(status_code=413, detail="context too large")
    chunks = chunk_text(req.text)
    recorder = _analytics_recorder(session_id)
    n = _indexer.index_context(
        session_id, chunks, req.source_name, usage_hook=embedding_hook(recorder)
    )
    log.info("context_indexed", session=session_id, chunks=n, sub=access.sub)
    return ContextResponse(indexed_chunks=n)


@router.post("/api/sessions/{session_id}/context/file", response_model=ContextResponse)
async def add_context_file(
    session_id: str,
    file: UploadFile = File(...),
    access: SessionAccess = Depends(require_session_access),
) -> ContextResponse:
    """Register an uploaded file as session context.

    認可（契約 §4）: join 済みセッショントークン必須（text 版と同じく参加者限定）。これが
    無いと匿名で任意 session_id の grounding を汚染できてしまう。

    資料（txt/md/html/csv/json/pdf/docx/xlsx/pptx）はテキスト抽出して grounding 索引へ入れ、
    画像/動画と同じく安定 `asset_id`（content hash）と素材メタを残す（リロード後の素材一覧・
    DELETE での破棄に対応 / ADR-0044）。画像/動画は Cloud Storage に保存し、安定 `asset_id` を
    返す（ADR-0004）。画像は Gemini で観察を抽出して grounding に流し、agent が
    問いの根拠にできるようにする。非対応形式は 415 で弾く。

    観測性: アップロード〜解析を span/log で追い、素材数を kind/result で計測する（契約 §5）。
    ゲスト token（ADR-0032 決定4）は読取専用のため素材投入は不可。
    """
    forbid_guest_writes(access, "context_file")
    filename = file.filename or "upload"
    raw = await file.read()

    if is_text_upload(filename, file.content_type):
        byte_limit = (
            settings.max_asset_bytes
            if is_binary_document(filename, file.content_type)
            else settings.max_context_chars * 4
        )
        if len(raw) > byte_limit:
            record_asset_upload("doc", "rejected")
            raise HTTPException(status_code=413, detail="file too large")
        tracer = _get_tracer()
        span_cm = (
            tracer.start_as_current_span("context.file.doc") if tracer else contextlib.nullcontext()
        )
        with span_cm as span:
            if span is not None:
                span.set_attribute("sanba.asset.kind", "doc")
                span.set_attribute("sanba.asset.size", len(raw))
            extract_failed = False
            try:
                text = extract_text_from_upload(filename, raw, file.content_type)
            except DocumentExtractionError:
                text = ""
                extract_failed = True
            if len(text) > settings.max_context_chars:
                record_asset_upload("doc", "rejected")
                raise HTTPException(status_code=413, detail="extracted text too large")
            chunks = chunk_text(text)
            doc_asset_id = compute_asset_id(raw)
            if span is not None:
                span.set_attribute("sanba.asset.id", doc_asset_id)
            _indexer.delete_context(session_id, f"asset:{doc_asset_id}")
            recorder = _analytics_recorder(session_id)
            n = _indexer.index_context(
                session_id,
                chunks,
                f"asset:{doc_asset_id}",
                usage_hook=embedding_hook(recorder),
            )
            record_asset_upload("doc", "extract_failed" if extract_failed else "indexed")
            _repo.save_material(
                session_id,
                material_record(doc_asset_id, filename, "doc", status="done", extracted=n),
            )
            log.info(
                "doc_indexed",
                session=session_id,
                asset_id=doc_asset_id,
                chunks=n,
                extract_failed=extract_failed,
                sub=access.sub,
            )
            return ContextResponse(indexed_chunks=n, asset_id=doc_asset_id, asset_kind="doc")

    kind = asset_kind(filename, file.content_type)
    if kind is None:
        record_asset_upload("unknown", "rejected")
        raise HTTPException(
            status_code=415,
            detail=(
                "unsupported file type (allowed: png/jpg/mp4/mov, "
                "txt/md/html/csv/json/pdf/docx/xlsx/pptx)"
            ),
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

        sender = (
            build_sender(
                settings.livekit_publish_url,
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

        if kind == "video":
            if not settings.enable_video_analysis:
                record_asset_upload("video", "pending")
                _repo.save_material(
                    session_id, material_record(asset.asset_id, filename, kind, status="analyzing")
                )
                log.info("asset_pending", session=session_id, asset_id=asset.asset_id, kind=kind)
                return ContextResponse(
                    indexed_chunks=0,
                    asset_id=asset.asset_id,
                    asset_kind=kind,
                    analysis_pending=True,
                )
            _mark_analyzing(session_id, asset.asset_id, filename)
            with contextlib.suppress(Exception):
                await publisher.progress(asset.asset_id, STAGE_ANALYZING)
            enqueue_video_analysis(
                build_payload(session_id, asset.asset_id, asset.uri, content_type, filename, None)
            )
            record_asset_upload("video", "enqueued")
            log.info("video_enqueued_multipart", session=session_id, asset_id=asset.asset_id)
            return ContextResponse(
                indexed_chunks=0,
                asset_id=asset.asset_id,
                asset_kind=kind,
                analysis_pending=True,
            )

        with contextlib.suppress(Exception):
            await publisher.progress(asset.asset_id, STAGE_ANALYZING)
        recorder = _analytics_recorder(session_id)
        try:
            observations = analyze_image(
                raw,
                content_type,
                on_usage=lambda usage: recorder.record(
                    COMPONENT_VISION, settings.gemini_vision_model, usage
                ),
                billing_labels=billing_labels(session_id, recorder.product_id),
            )
        except Exception:
            with contextlib.suppress(Exception):
                await publisher.progress(asset.asset_id, STAGE_FAILED)
            record_asset_upload(kind, "rejected")
            raise
        indexed = 0
        if observations:
            indexed = _indexer.index_context(
                session_id,
                observations,
                f"asset:{asset.asset_id}",
                usage_hook=embedding_hook(recorder),
            )
        record_asset_upload(kind, "analyzed")
        analyzed = material_record(
            asset.asset_id, filename, kind, status="done", extracted=len(observations)
        )
        if observations:
            analyzed["extracted_texts"] = observations
        _repo.save_material(session_id, analyzed)
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


class UploadInitRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=512)
    content_type: str = ""
    size: int = Field(ge=1)


class UploadInitResponse(BaseModel):
    asset_id: str
    upload_url: str
    method: str = "PUT"
    headers: dict[str, str]


class UploadCompleteRequest(BaseModel):
    asset_id: str
    content_type: str = ""
    filename: str = Field(default="", max_length=512)
    duration_seconds: float | None = Field(default=None, ge=0)


def _analysis_publisher(session_id: str) -> AnalysisPublisher:
    sender = (
        build_sender(
            settings.livekit_publish_url,
            settings.livekit_api_key,
            settings.livekit_api_secret,
            session_id,
        )
        if settings.enable_realtime_publish
        else NullSender()
    )
    return AnalysisPublisher(session_id, sender, _repo)


def _mark_analyzing(session_id: str, asset_id: str, filename: str) -> None:
    """素材を analyzing にし、reconcile 用の開始時刻（epoch）を残す（ADR-0040 §3）。"""
    rec = material_record(asset_id, filename, "video", status="analyzing")
    rec["analyzing_since"] = datetime.now(UTC).timestamp()
    _repo.save_material(session_id, rec)


@router.post(
    "/api/sessions/{session_id}/context/file/upload-init", response_model=UploadInitResponse
)
def context_file_upload_init(
    session_id: str,
    body: UploadInitRequest,
    access: SessionAccess = Depends(require_session_access),
) -> UploadInitResponse:
    """動画の直送用に署名付き PUT URL を発行し、素材を uploading で仮登録する（ADR-0040 §2）。

    認可: join 済みトークン必須（add_context_file と同じ）。ゲストは読取専用のため不可。
    動画のみ受け付ける（画像は multipart のまま）。上限は max_video_asset_bytes（200MB）。
    """
    forbid_guest_writes(access, "context_file")
    if not settings.enable_video_analysis:
        raise HTTPException(status_code=409, detail="video analysis is disabled")
    kind = asset_kind(body.filename, body.content_type)
    if kind != "video":
        raise HTTPException(status_code=415, detail="direct upload is for video only")
    if body.size > settings.max_video_asset_bytes:
        record_asset_upload("video", "rejected")
        raise HTTPException(
            status_code=413,
            detail=f"video too large (max {settings.max_video_asset_bytes} bytes)",
        )
    content_type = resolve_content_type(body.filename, body.content_type, kind)
    asset_id = f"asset-{uuid.uuid4().hex[:16]}"
    upload_url = _asset_store.generate_upload_url(
        session_id,
        asset_id,
        content_type,
        ttl_seconds=settings.signed_url_ttl_seconds,
        max_bytes=settings.max_video_asset_bytes,
    )
    _repo.save_material(
        session_id, material_record(asset_id, body.filename, "video", status="uploading")
    )
    record_asset_upload("video", "upload_init")
    log.info("video_upload_init", session=session_id, asset_id=asset_id, size=body.size)
    return UploadInitResponse(
        asset_id=asset_id,
        upload_url=upload_url,
        headers={
            "Content-Type": content_type,
            "x-goog-content-length-range": f"0,{settings.max_video_asset_bytes}",
        },
    )


@router.post(
    "/api/sessions/{session_id}/context/file/upload-complete", response_model=ContextResponse
)
async def context_file_upload_complete(
    session_id: str,
    body: UploadCompleteRequest,
    access: SessionAccess = Depends(require_session_access),
) -> ContextResponse:
    """直送完了を受け、オブジェクトを検証して解析を enqueue する（ADR-0040 §2）。"""
    forbid_guest_writes(access, "context_file")
    if not settings.enable_video_analysis:
        raise HTTPException(status_code=409, detail="video analysis is disabled")
    content_type = resolve_content_type(body.filename, body.content_type, "video")
    size = _asset_store.object_size(session_id, body.asset_id, content_type)
    if size is None:
        _repo.delete_material(session_id, body.asset_id)
        raise HTTPException(status_code=409, detail="uploaded object not found")
    if size > settings.max_video_asset_bytes:
        _asset_store.delete(session_id, body.asset_id)
        _repo.delete_material(session_id, body.asset_id)
        record_asset_upload("video", "rejected")
        raise HTTPException(status_code=413, detail="uploaded video too large")

    _mark_analyzing(session_id, body.asset_id, body.filename)
    publisher = _analysis_publisher(session_id)
    with contextlib.suppress(Exception):
        await publisher.progress(body.asset_id, STAGE_RECEIVED)
        await publisher.progress(body.asset_id, STAGE_ANALYZING)
    gcs_uri = _asset_store.gcs_uri(session_id, body.asset_id, content_type)
    enqueue_video_analysis(
        build_payload(
            session_id,
            body.asset_id,
            gcs_uri,
            content_type,
            body.filename,
            body.duration_seconds,
        )
    )
    record_asset_upload("video", "enqueued")
    log.info("video_upload_complete", session=session_id, asset_id=body.asset_id, size=size)
    return ContextResponse(
        indexed_chunks=0, asset_id=body.asset_id, asset_kind="video", analysis_pending=True
    )


@router.post("/api/sessions/{session_id}/telemetry", response_model=TelemetryResponse)
def post_telemetry(
    session_id: str,
    body: TelemetryRequest,
    access: SessionAccess = Depends(require_session_access),
) -> TelemetryResponse:
    """web UI 由来の素材イベント（投入種別・中断）を OTLP カウンタへ集約する。

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
    if body.event.startswith("join."):
        record_join_ui_event(body.event, result=result)
        log.info(
            "join_ui_event",
            session=session_id,
            event_name=body.event,
            result=result,
            sub=access.sub,
        )
        return TelemetryResponse(recorded=True)
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


@router.delete(
    "/api/sessions/{session_id}/context/file/{asset_id}",
    response_model=DeleteContextFileResponse,
)
def delete_context_file(
    session_id: str,
    asset_id: str,
    access: SessionAccess = Depends(require_session_access),
) -> DeleteContextFileResponse:
    """投入済み素材の「真の破棄」。binary・material メタ・grounding 索引をまとめて消す。

    認可（契約 §4）: join 済みセッショントークン必須（参加者以外の削除を塞ぐ）。
    クライアント破棄だけでは、画像はレスポンス前に grounding 索引と material(done)
    まで完了するため素材由来の観察が会話に残り、リロードで GET context/files から復活する。
    本 API で (1) 保存 binary、(2) material メタ、(3) 出所 `asset:{asset_id}` の grounding chunk
    をまとめて取り消し、以後の会話・ハイドレーションから外す。冪等: 存在しない asset でも 200 を
    一貫して返す（existed=false）。in-memory/ES/GCS 未接続のフォールバックでも安全に動く。
    ゲスト token（ADR-0032 決定4）は読取専用のため削除も不可。
    """
    forbid_guest_writes(access, "context_file_delete")
    tracer = _get_tracer()
    span_cm = (
        tracer.start_as_current_span("context.file.delete") if tracer else contextlib.nullcontext()
    )
    with span_cm as span:
        if span is not None:
            span.set_attribute("sanba.asset.id", asset_id)
        removed_index = _indexer.delete_context(session_id, f"asset:{asset_id}")
        removed_blob = _asset_store.delete(session_id, asset_id)
        removed_meta = _repo.delete_material(session_id, asset_id)
        existed = removed_blob or removed_meta or removed_index > 0
        if span is not None:
            span.set_attribute("sanba.asset.existed", existed)
            span.set_attribute("sanba.asset.index_removed", removed_index)
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


@router.post("/api/sessions/join", response_model=JoinResponse)
def join_session(
    req: JoinRequest,
    user: AuthUser = Depends(require_user_bound),
) -> JoinResponse:
    """Exchange a valid invite for a scoped, short-lived LiveKit token.

    Two complementary checks (ADR-0012): the invite proves *which room/role*,
    the verified Google identity proves *who*. Both must hold. The LiveKit
    participant identity is derived from the verified `sub` (not a self-reported
    name) so the provenance metadata on captured requirements is trustworthy.
    ID トークンは nonce 束縛される（ADR-0047 §2 / require_user_bound）。
    """
    if settings.auth_dev_bypass and req.invite.startswith("dev:"):
        _, session_id, role = req.invite.split(":", 2)
    else:
        try:
            invite = verify_invite(req.invite, settings.session_signing_secret)
        except InvalidInvite as exc:
            log.warning("invite_rejected", reason=str(exc))
            raise HTTPException(status_code=403, detail=f"invalid invite: {exc}") from exc
        session_id, role = invite.session_id, invite.role

    identity = f"{role}-{user.sub[:8]}-{uuid.uuid4().hex[:4]}"
    display_name = req.participant_name or user.name
    joined = _mint_join_tokens(session_id, role, identity, display_name, user.sub, user.email)
    log.info("session_join", session=session_id, identity=identity, role=role, sub=user.sub)
    return joined


@router.get("/api/sessions/{session_id}/requirements", response_model=RequirementsResponse)
def get_requirements(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> RequirementsResponse:
    """確定/下書き要件のスナップショット（契約 §4 P0）。08/09 のハイドレーション前提。"""
    items = _read_repo.list_requirements(session_id)
    seq = _read_repo.get_session_seq(session_id)
    log.info("requirements_hydrated", session=session_id, count=len(items), seq=seq, sub=access.sub)
    return RequirementsResponse(items=items, seq=seq)


@router.get("/api/sessions/{session_id}/inquiry", response_model=InquiryResponse)
def get_inquiry(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> InquiryResponse:
    """確認事項ロジックツリー全体のスナップショット（ADR-0059 決定④）。

    再接続/途中参加で木ごと復元するためのハイドレーション（旧 `GET /detections` の置換）。
    正本は `sessions/{id}/inquiry_nodes`（agent が単一書き手）で、`seq` は ADR-0021 の
    seq gap 埋めに使う適用済み最大 seq。認可は他のハイドレーション GET と同じ join 済みトークン。
    """
    nodes = _repo.list_inquiry_nodes(session_id)
    seq = _repo.get_session_seq(session_id)
    log.info("inquiry_hydrated", session=session_id, count=len(nodes), seq=seq, sub=access.sub)
    return InquiryResponse(nodes=nodes, seq=seq)


@router.get(
    "/api/sessions/{session_id}/questions/current",
    response_model=CurrentQuestionResponse,
)
def get_current_question(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> CurrentQuestionResponse:
    """現在の未回答質問（金枠ピン）のスナップショット（契約 §4 / ADR-0020）。

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


@router.get("/api/sessions/{session_id}/context/files", response_model=ContextFilesResponse)
def get_context_files(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> ContextFilesResponse:
    """投入済み素材のメタ一覧（契約 §4）。05 参考資料のハイドレーション。

    リロード/再接続でローカル行（uploading/failed）が消えても、サーバ保持の実ファイル名と
    解析状態を復元する。realtime の analysis.progress/visual はライブ差分で重ねる。
    """
    items = _repo.list_materials(session_id)
    items = _reconcile_stuck_materials(session_id, items)
    log.info("context_files_hydrated", session=session_id, count=len(items), sub=access.sub)
    return ContextFilesResponse(items=items)


def _reconcile_stuck_materials(
    session_id: str, items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """analyzing のまま閾値を超えて滞留した動画素材を failed 化する（ADR-0040 §3 の保険）。

    worker のリトライ枯渇時 failed 化が主経路だが、enqueue 自体の取りこぼしや worker 全滅に
    備えた reaper。`analyzing_since`（upload/enqueue 時に記録）から閾値超過を判定する。
    タイムスタンプが無い素材（旧 pending 動画など）は対象外（掃除しすぎない）。
    """
    threshold = settings.analysis_stuck_after_seconds
    if threshold <= 0:
        return items
    now = datetime.now(UTC).timestamp()
    reconciled: list[dict[str, Any]] = []
    for item in items:
        since = item.get("analyzing_since")
        if (
            item.get("status") == "analyzing"
            and isinstance(since, int | float)
            and (now - since > threshold)
        ):
            _repo.save_material(session_id, {"id": item["id"], "status": "failed"})
            log.info("material_reconciled_failed", session=session_id, asset_id=item["id"])
            item = {**item, "status": "failed"}
        reconciled.append(item)
    return reconciled


@router.post("/api/sessions/{session_id}/finalize", response_model=FinalizeResponse)
def finalize_session_requirements(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> FinalizeResponse:
    """07 判定の「確定」を永続化する。

    会話を締めて要件を確定したとき、確定した要件件数のスナップショットを刻み、セッションを
    finalized にする（不可逆マーカ）。確定後の export（GitHub Issue）はこの件数と一致する。

    確定時集合は approved にして TTL（expireAt）を解除する: 管理画面の承認 UI
    廃止に伴い、draft のまま 30 日 TTL で消えると過去要件閲覧（/sessions/{id}）と export が
    欠落するため、参加者の「確定」を成果物保全の起点にする。TTL 解除は既存の
    set_requirement_status（approved で expireAt 削除）に集約済みのものを再利用する。

    ガード:
      - 既に finalized なら未解消ノードに関係なく保存済みスナップショット件数を返す（冪等）。
        確定後に遅延 agent が open ノードを足しても、再送/リロードの再 POST は 409 にならない。
      - 未確定セッションは、終了ゲート対象の未解消ノード（open かつ
        kind∈{contradiction,gap,check}）が 1 件でも残るなら 409 で拒否する（HP8 判定の
        「未解消 0 件で確定可」をサーバ側でも担保。ADR-0059 の agent ゲートと同義。
        直接 POST や古いクライアント状態を防ぐ）。

    ゲスト token（ADR-0032 決定4）は確定不可: ゲストセッションの要件の承認・保全は
    owner が管理画面で行う（承認 = TTL 解除は owner の意思に限る）。
    """
    forbid_guest_writes(access, "finalize")
    existing = _repo.get_session(session_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="session not found")
    if existing.status == "finalized":
        return FinalizeResponse(finalized=True, confirmed_count=existing.finalized_count or 0)
    open_inquiries = InquiryTree.from_nodes(_repo.list_inquiry_nodes(session_id))
    if open_inquiries.gating_open_count() > 0:
        raise HTTPException(status_code=409, detail="unresolved inquiries remain")
    confirmed = _confirmed_requirements(session_id)
    confirmed_ids = [r["id"] for r in confirmed]
    labels = requirements_to_issue_labels(confirmed)
    meta = _repo.finalize_session(
        session_id,
        confirmed_count=len(confirmed),
        finalized_requirement_ids=confirmed_ids,
        labels=labels,
    )
    if meta is None:
        raise HTTPException(status_code=404, detail="session not found")
    recorder = _analytics_recorder(session_id)
    finalize_labels = billing_labels(session_id, recorder.product_id)
    generated_title = generate_requirement_title(
        confirmed,
        usage_hook=lambda usage: recorder.record(
            COMPONENT_TITLE, settings.gemini_reasoning_model, usage
        ),
        billing_labels=finalize_labels,
    )
    if generated_title:
        _repo.set_session_title(session_id, generated_title)
        log.info("session_title_generated", session=session_id, title=generated_title)
    utterances = [u.model_dump(mode="json") for u in _repo.list_utterances(session_id)]
    generated_summary = generate_conversation_summary(
        utterances,
        usage_hook=lambda usage: recorder.record(
            COMPONENT_SUMMARY, settings.gemini_reasoning_model, usage
        ),
        billing_labels=finalize_labels,
    )
    if generated_summary:
        _repo.set_session_summary(session_id, generated_summary)
        log.info("session_summary_generated", session=session_id, chars=len(generated_summary))
    is_guest_session = existing.owner_email == ""
    for rid in confirmed_ids:
        try:
            _repo.set_requirement_status(
                session_id,
                rid,
                RequirementStatus.APPROVED,
                approved_by=access.sub,
                keep_expiry=is_guest_session,
            )
        except RequirementNotFound:
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


def _export_appendix(session: SessionMeta, opts: ExportRequest) -> str:
    """起票本文末尾に付ける opt-in セクション（会話要約・参考資料 / P3・Q4）を組み立てる。

    要約は確定時に生成・保存済みの `conversation_summary` を使う（起票のたびに LLM を
    呼ばない）。参考資料は解析済み素材のファイル名＋観察サマリ＋結果画面リンク。
    どちらも該当データが無ければその節を出さない。
    """
    sections: list[str] = []
    if opts.include_summary and session.conversation_summary:
        sections.append(f"## 会話の要約\n\n{session.conversation_summary.strip()}")
    if opts.include_materials:
        results_url = f"{settings.web_base_url.rstrip('/')}/results/{session.id}"
        block = build_materials_block(_repo.list_materials(session.id), results_url)
        if block:
            sections.append(f"## 参考資料\n\n{block}")
    return ("\n\n" + "\n\n".join(sections)) if sections else ""


@router.post("/api/sessions/{session_id}/export", response_model=ExportResponse)
def export_requirements(
    session_id: str,
    req: ExportRequest | None = None,
    access: SessionAccess = Depends(require_session_access),
) -> ExportResponse:
    """確定要件を GitHub Issue として起票する（契約 §4 P1 / ADR-0053）。ライブ結果画面用。

    起票は**操作者本人の GitHub App installation token（Issues: write）**で行う（ADR-0053）。
    共有 PAT は使わない。ゲスト token（ADR-0032 決定4）は起票不可: 匿名の URL 保持者が owner の
    リポジトリへ Issue を作れてしまうため、資格判定より前に拒む。起票の実処理は
    `_perform_export` に集約し、ログイン資格の結果レビュー経路（`/mine/...`）と共有する。

    リクエストボディの opt-in（既定 off / P3・Q4）で、本文末尾に会話の要約
    （確定時に生成・保存済み）と参考資料のサマリ（ファイル名＋解析観察＋結果画面リンク）を
    付す。既定 off なのは会話ログ由来の PII を無断で Issue に載せないため。
    """
    opts = req or ExportRequest()
    forbid_guest_writes(access, "export")
    session = _repo.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return _perform_export(session, access.sub, opts)


class ExportEligibilityResponse(BaseModel):
    can_export: bool
    reason: str | None = None
    repo: str | None = None


def _perform_export(
    session: SessionMeta, actor_sub: str, opts: ExportRequest | None = None
) -> ExportResponse:
    """起票の実処理（資格判定 → 本文整形 → 操作者 installation で Issue 起票）。

    finalize 時に凍結した要件 ID スナップショット（`finalized_requirement_ids`）の集合だけを
    起票する。可否は `export_eligibility` に一元化し、eligibility エンドポイント（ボタン活性
    判定）と同じ判定を共有する。起票アイデンティティは常に操作者本人の installation。

    `opts`（P3・Q4）の opt-in で本文末尾に会話要約・参考資料サマリを付す。省略時は両方 off
    （結果レビュー経路 `/mine/...` は素の本文で起票する）。
    """
    opts = opts or ExportRequest()
    elig = export_eligibility(actor_sub, session)
    if not elig.can_export or elig.repo is None:
        log.info("export_not_eligible", session=session.id, reason=elig.reason, sub=actor_sub)
        return ExportResponse(exported=False, reason=elig.reason)
    export_repo = elig.repo
    client = _github_app_client()
    link = _repo.get_github_link(actor_sub)
    if client is None or link is None:
        log.warning("export_link_missing", session=session.id, repo=export_repo, sub=actor_sub)
        return ExportResponse(exported=False, reason="github not linked")
    confirmed = _finalized_snapshot_requirements(session)
    product = _repo.get_product(session.product_id) if session.product_id else None
    template, _ = resolve_output_format(product, Audience.DEVELOPER)
    body = render_result_document(
        template,
        session_title=session.title,
        app_name=product.name if product is not None else None,
        goal=session.goal,
        date=datetime.now(UTC).strftime("%Y-%m-%d"),
        requirements=confirmed,
        check_items=(
            check_items_for_audience(product.check_items, Audience.DEVELOPER)
            if product is not None
            else []
        ),
        inquiry_nodes=_repo.list_inquiry_nodes(session.id),
    )
    body += _export_appendix(session, opts)
    body = f"{body}\n\n---\nSANBA session {session.id} / export by {link.github_login}"
    try:
        url = client.create_issue(
            link.installation_id,
            export_repo,
            issue_title(session.title, session.id),
            body,
            labels=requirements_to_issue_labels(confirmed),
        )
    finally:
        with contextlib.suppress(Exception):
            client.close()
    if url is None:
        log.warning(
            "export_issue_create_failed",
            session=session.id,
            repo=export_repo,
            exporter=link.github_login,
            count=len(confirmed),
            sub=actor_sub,
        )
        return ExportResponse(exported=False, reason="issue creation failed")
    _repo.set_exported_issue_url(session.id, url)
    log.info(
        "requirements_exported",
        session=session.id,
        count=len(confirmed),
        id_count=len(session.finalized_requirement_ids),
        repo=export_repo,
        session_selected=session.github_repo is not None,
        installation_source="acting-user",
        exporter=link.github_login,
        url=url,
        sub=actor_sub,
    )
    return ExportResponse(exported=True, issue_url=url, count=len(confirmed))


@router.get(
    "/api/sessions/{session_id}/export/eligibility",
    response_model=ExportEligibilityResponse,
)
def export_eligibility_status(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> ExportEligibilityResponse:
    """起票ボタンの活性/理由判定に使う（ADR-0053 決定4）。認可はセッショントークン。

    ゲストは起票不可（`can_export=False, reason="guest"`）。それ以外は `export_eligibility` で
    「連携済み ∧ 対象 repo 権限あり」を判定する（POST /export と同じ判定を共有）。
    """
    session = _repo.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    if access.sub.startswith("guest:"):
        return ExportEligibilityResponse(can_export=False, reason="guest", repo=None)
    elig = export_eligibility(access.sub, session)
    return ExportEligibilityResponse(can_export=elig.can_export, reason=elig.reason, repo=elig.repo)


@router.get(
    "/api/sessions/mine/{session_id}/export/eligibility",
    response_model=ExportEligibilityResponse,
)
def my_export_eligibility_status(
    session_id: str, user: AuthUser = Depends(require_user)
) -> ExportEligibilityResponse:
    """結果レビュー画面（`/results/{id}`）の起票ボタン活性判定（ADR-0053 決定5）。

    認可は `/mine/` 系と同じ owner_sub 一致（ゲストセッションの owner は product owner なので
    開発者が後からレビューして判定できる）。非所有・不存在は 404 に平す。
    """
    session = _repo.get_session(session_id)
    if session is None or session.owner_sub != user.sub:
        raise HTTPException(status_code=404, detail="session not found")
    elig = export_eligibility(user.sub, session)
    return ExportEligibilityResponse(can_export=elig.can_export, reason=elig.reason, repo=elig.repo)


@router.post("/api/sessions/mine/{session_id}/export", response_model=ExportResponse)
def my_export_requirements(
    session_id: str, user: AuthUser = Depends(require_user)
) -> ExportResponse:
    """結果レビュー画面から確定要件を Issue 起票する（ADR-0053 決定5）。

    ログイン資格（idToken）で本人確認し、owner_sub 一致で認可する（`/mine/` 系と同一）。
    起票は操作者本人の installation token で行い、権限が無ければ理由つきで拒む
    （web はボタンを disable、手動起票用に Markdown コピーを併置する）。
    """
    session = _repo.get_session(session_id)
    if session is None or session.owner_sub != user.sub:
        raise HTTPException(status_code=404, detail="session not found")
    return _perform_export(session, user.sub)
