"""汎用 A2A ファサードの FastAPI アプリ（ADR-0069）。

公開するのは A2A 標準の 3 点のみ: agent card（GET）・`message/send`（POST・同期）・
healthz。書き込み系メソッドは存在しない（read-only 方針のプロトコル面の担保）。
認証は Cloud Run の IAM（ingress で ID トークン検証）に委ね、アプリ層では扱わない。
Cloud Trace span とメトリクスの計装は flag ON にする Phase 1' で入れる（ADR-0069 影響）。

JSON-RPC over HTTP の流儀に従い、プロトコルエラーも HTTP 200 + JSON-RPC error で返す
（HTTP 層のエラーはルーティング不一致など transport 起因のものに限る）。
"""

from __future__ import annotations

import structlog
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .backends.base import AgentBackend
from .backends.holmesgpt import HolmesBackend
from .card import build_agent_card
from .config import FacadeSettings, settings
from .jsonrpc import (
    INTERNAL_ERROR,
    PARSE_ERROR,
    JsonRpcError,
    build_error,
    build_text_result,
    parse_message_send,
)

log = structlog.get_logger(__name__)


def build_backend(config: FacadeSettings) -> AgentBackend:
    if config.backend == "holmesgpt":
        return HolmesBackend(
            config.holmes_url,
            name=config.agent_name,
            description=config.agent_description,
            instructions=config.agent_instructions,
        )
    raise ValueError(f"unknown backend: {config.backend!r}")


def create_app(
    backend: AgentBackend | None = None, config: FacadeSettings | None = None
) -> FastAPI:
    cfg = config or settings
    agent = backend or build_backend(cfg)
    app = FastAPI(title="sanba-a2a-facade", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/.well-known/agent-card.json")
    def agent_card() -> dict:
        return build_agent_card(agent, cfg.agent_id, cfg.public_url)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok", "backend": cfg.backend}

    @app.post("/a2a/{agent_id}")
    async def a2a_endpoint(agent_id: str, request: Request) -> JSONResponse:
        if agent_id != cfg.agent_id:
            return JSONResponse(status_code=404, content={"detail": "unknown agent"})
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return JSONResponse(content=build_error(None, PARSE_ERROR, "invalid JSON body"))
        try:
            request_id, text = parse_message_send(payload)
        except JsonRpcError as exc:
            return JSONResponse(content=build_error(exc.request_id, exc.code, exc.message))
        try:
            answer = await run_in_threadpool(agent.ask, text, timeout=cfg.holmes_timeout_seconds)
        except Exception as exc:  # noqa: BLE001
            log.warning("a2a_backend_ask_failed", backend=cfg.backend, error=str(exc))
            return JSONResponse(
                content=build_error(request_id, INTERNAL_ERROR, "backend investigation failed")
            )
        log.info("a2a_message_send_completed", backend=cfg.backend, chars=len(answer))
        return JSONResponse(content=build_text_result(request_id, answer))

    return app
