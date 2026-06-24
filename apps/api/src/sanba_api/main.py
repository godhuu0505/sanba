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

import json
import time
import uuid
from collections import defaultdict, deque
from datetime import timedelta

import structlog
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel
from sanba_shared.models import Requirement, RequirementStatus, SessionMeta
from sanba_shared.repository import RequirementNotFound, SessionRepository

from .auth import InvalidInvite, create_invite, verify_invite
from .auth_google import AuthUser, require_admin, require_user
from .config import settings
from .ingestion import ContextIndexer, chunk_text, extract_text_from_upload
from .observability import setup_observability

log = structlog.get_logger(__name__)

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

# セッション/要件の永続化境界 (ADR-0014)。agent と同じ sanba_shared を使う。
_repo = SessionRepository(data_retention_days=settings.data_retention_days)


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


class JoinRequest(BaseModel):
    invite: str
    participant_name: str


class JoinResponse(BaseModel):
    token: str
    livekit_url: str
    session_id: str
    identity: str


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
def add_context(session_id: str, req: ContextRequest) -> ContextResponse:
    """Register reference text for a session; chunks go to RAG grounding."""
    if len(req.text) > settings.max_context_chars:
        raise HTTPException(status_code=413, detail="context too large")
    chunks = chunk_text(req.text)
    n = _indexer.index_context(session_id, chunks, req.source_name)
    return ContextResponse(indexed_chunks=n)


@app.post("/api/sessions/{session_id}/context/file", response_model=ContextResponse)
async def add_context_file(session_id: str, file: UploadFile = File(...)) -> ContextResponse:
    """Register an uploaded document (txt/md/pdf) as session context."""
    raw = await file.read()
    if len(raw) > settings.max_context_chars * 4:  # bytes guard (~utf-8 worst case)
        raise HTTPException(status_code=413, detail="file too large")
    text = extract_text_from_upload(file.filename or "upload", raw)
    chunks = chunk_text(text)
    n = _indexer.index_context(session_id, chunks, file.filename or "upload")
    return ContextResponse(indexed_chunks=n)


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

    log.info("session_join", session=session_id, identity=identity, role=role, sub=user.sub)
    return JoinResponse(
        token=token,
        livekit_url=settings.livekit_url,
        session_id=session_id,
        identity=identity,
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
