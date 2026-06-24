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
from typing import Any

import structlog
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

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
from .auth_google import AuthUser, require_user
from .config import settings
from .ingestion import ContextIndexer, chunk_text, extract_text_from_upload
from .observability import setup_observability
from .repository import ReadRepository

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
    # 契約 §4: ハイドレーション/起票 API を保護する「join 済みトークン」。
    session_token: str


class RequirementsResponse(BaseModel):
    items: list[dict[str, Any]]
    # 適用済み連番の境界。API は publish seq を持たないため 0 を返し、web 側の
    # (type,id) 冪等 upsert に合流を委ねる（重複・空白は出ない）。
    seq: int = 0


class DetectionsResponse(BaseModel):
    items: list[dict[str, Any]]


class ExportResponse(BaseModel):
    exported: bool
    issue_url: str | None = None
    count: int | None = None
    doc_url: str | None = None
    reason: str | None = None


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


# ── ハイドレーション & 起票 API（契約 §4 / Issue #100）─────────────────────────


@app.get("/api/sessions/{session_id}/requirements", response_model=RequirementsResponse)
def get_requirements(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> RequirementsResponse:
    """確定/下書き要件のスナップショット（契約 §4 P0）。08/09 のハイドレーション前提。"""
    items = _read_repo.list_requirements(session_id)
    log.info("requirements_hydrated", session=session_id, count=len(items), sub=access.sub)
    return RequirementsResponse(items=items, seq=0)


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


@app.post("/api/sessions/{session_id}/export", response_model=ExportResponse)
def export_requirements(
    session_id: str, access: SessionAccess = Depends(require_session_access)
) -> ExportResponse:
    """確定要件を GitHub Issue として起票する（契約 §4 P1 / #39 ループ）。"""
    if not _github_ready():
        return ExportResponse(exported=False, reason="github connector disabled")
    requirements = _read_repo.list_requirements(session_id)
    title, body = github_export.requirements_to_issue_body(requirements, session_id)
    url = github_export.create_issue(settings.github_token, settings.github_repo, title, body)
    if url is None:
        return ExportResponse(exported=False, reason="issue creation failed")
    log.info(
        "requirements_exported",
        session=session_id,
        count=len(requirements),
        url=url,
        sub=access.sub,
    )
    return ExportResponse(exported=True, issue_url=url, count=len(requirements))
