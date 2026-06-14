"""FastAPI app: issue LiveKit join tokens and expose session requirements.

The web client asks this service for a token, then connects directly to LiveKit.
The voice agent worker is dispatched to the same room name automatically.
"""

from __future__ import annotations

import uuid

import structlog
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

from .config import settings

log = structlog.get_logger(__name__)

app = FastAPI(title="Kikitori API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


class JoinRequest(BaseModel):
    session_id: str | None = None
    participant_name: str
    # role lets us label PM / engineer / customer for many-to-many traceability
    role: str = "participant"


class JoinResponse(BaseModel):
    token: str
    livekit_url: str
    session_id: str
    identity: str


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/sessions/join", response_model=JoinResponse)
def join_session(req: JoinRequest) -> JoinResponse:
    """Create (or join) an interview room and return a LiveKit access token."""
    session_id = req.session_id or f"sess-{uuid.uuid4().hex[:8]}"
    identity = f"{req.role}-{uuid.uuid4().hex[:6]}"

    try:
        token = (
            api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
            .with_identity(identity)
            .with_name(req.participant_name)
            .with_metadata(f'{{"role":"{req.role}"}}')
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=session_id,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )
    except Exception as exc:  # pragma: no cover
        log.error("token_issue_failed", error=str(exc))
        raise HTTPException(status_code=500, detail="failed to issue token") from exc

    log.info("session_join", session=session_id, identity=identity, role=req.role)
    return JoinResponse(
        token=token,
        livekit_url=settings.livekit_url,
        session_id=session_id,
        identity=identity,
    )
