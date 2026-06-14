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

import time
import uuid
from collections import defaultdict, deque
from datetime import timedelta

import structlog
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

from .auth import InvalidInvite, create_invite, verify_invite
from .config import settings
from .ingestion import ContextIndexer, chunk_text, extract_text_from_upload

log = structlog.get_logger(__name__)

app = FastAPI(title="Kikitori API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory per-IP rate limiter for the join endpoint. Stateless workers can use
# a shared store (Redis/Firestore) later; this is enough to blunt abuse in the MVP.
_join_hits: dict[str, deque[float]] = defaultdict(deque)

# Context indexer shares the agent's Elasticsearch grounding index (issue #6).
_indexer = ContextIndexer()


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
def create_session(req: CreateSessionRequest) -> CreateSessionResponse:
    """Create an interview room and mint a signed invite per role."""
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
    log.info("session_created", session=session_id, roles=req.roles)
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
def join_session(req: JoinRequest, request: Request) -> JoinResponse:
    """Exchange a valid invite for a scoped, short-lived LiveKit token."""
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

    identity = f"{role}-{uuid.uuid4().hex[:6]}"
    try:
        token = (
            api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
            .with_identity(identity)
            .with_name(req.participant_name)
            .with_metadata(f'{{"role":"{role}"}}')
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

    log.info("session_join", session=session_id, identity=identity, role=role)
    return JoinResponse(
        token=token,
        livekit_url=settings.livekit_url,
        session_id=session_id,
        identity=identity,
    )
