"""Cloud Run entrypoint.

Exposes three things on one FastAPI app:
  1. The standard ADK REST + dev-web endpoints (via get_fast_api_app) for the
     text / multi-agent path, evals, and `adk web`-style debugging.
  2. A Gemini Live voice WebSocket (/ws/voice) that streams bidirectional audio
     through the interviewer using ADK's run_live.
  3. /healthz for Cloud Run health checks.
"""

from __future__ import annotations

import base64
import contextlib
import os
import uuid

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.cli.fast_api import get_fast_api_app
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from interviewer.agent import build_interviewer
from interviewer.config import get_config

# agents_dir is the directory that contains agent packages. The repo root
# contains the `interviewer/` package, so point ADK at the repo root.
AGENTS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_NAME = "interviewer"

# Base ADK app (REST + optional dev web UI).
app: FastAPI = get_fast_api_app(
    agents_dir=AGENTS_DIR,
    web=os.getenv("SERVE_WEB_INTERFACE", "true").lower() == "true",
)


@app.get("/healthz")
def healthz() -> dict[str, object]:
    cfg = get_config()
    return {
        "status": "ok",
        "model": cfg.model,
        "live_model": cfg.live_model,
        "vertexai": cfg.use_vertexai,
        "elasticsearch": cfg.elasticsearch_enabled,
    }


# --- Gemini Live voice path -------------------------------------------------

_voice_session_service = InMemorySessionService()


@app.websocket("/ws/voice")
async def voice(websocket: WebSocket) -> None:
    """Bidirectional audio with the interviewer over Gemini Live.

    Wire protocol (JSON text frames):
      client -> server: {"type":"audio","data":"<base64 pcm16 @16kHz>"}
                        {"type":"text","data":"..."}  (optional typed input)
      server -> client: raw ADK event JSON (audio arrives as inline_data parts;
                        transcripts arrive as text). The browser plays the audio
                        and renders transcripts.
    """
    await websocket.accept()
    cfg = get_config()

    # Use the live-capable model for the voice path.
    live_agent = build_interviewer(cfg.live_model)
    user_id = f"voice-{uuid.uuid4()}"
    session = await _voice_session_service.create_session(
        app_name=APP_NAME, user_id=user_id
    )
    runner = Runner(
        app_name=APP_NAME, agent=live_agent, session_service=_voice_session_service
    )

    live_request_queue = LiveRequestQueue()
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )

    async def pump_agent_to_client() -> None:
        async for event in runner.run_live(
            user_id=user_id,
            session_id=session.id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        ):
            await websocket.send_text(
                event.model_dump_json(exclude_none=True, by_alias=True)
            )

    import asyncio

    agent_task = asyncio.create_task(pump_agent_to_client())
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "audio":
                pcm = base64.b64decode(message["data"])
                live_request_queue.send_realtime(
                    types.Blob(mime_type="audio/pcm;rate=16000", data=pcm)
                )
            elif message.get("type") == "text":
                live_request_queue.send_content(
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=message["data"])],
                    )
                )
    except WebSocketDisconnect:
        pass
    finally:
        live_request_queue.close()
        agent_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await agent_task
