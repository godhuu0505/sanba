"""汎用 A2A ファサードの FastAPI アプリ（a2a-sdk、ADR-0069）。

a2a-sdk の proto/JSON-RPC 実装をそのまま使う。公開するのは A2A 標準の agent card（GET
`/.well-known/agent-card.json`）と JSON-RPC エンドポイント（POST `/a2a/{agent_id}`・`message/send`
同期）と healthz のみ。認証は Cloud Run の IAM（ingress で ID トークン検証）に委ね、アプリ層では
扱わない。同期バックエンドは `HolmesAgentExecutor` が Task へ橋渡しし、DefaultRequestHandler +
InMemoryTaskStore が Task ライフサイクルを担う。委譲の監査は executor 内で行う。
"""

from __future__ import annotations

import structlog
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes.agent_card_routes import create_agent_card_routes
from a2a.server.routes.fastapi_routes import add_a2a_routes_to_fastapi
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from fastapi import FastAPI

from .audit import AuditStore, FirestoreAuditStore, NoopAuditStore
from .backends.base import AgentBackend
from .backends.holmesgpt import HolmesBackend
from .card import build_agent_card, rpc_path
from .config import FacadeSettings, settings
from .executor import HolmesAgentExecutor

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


def build_audit_store(config: FacadeSettings) -> AuditStore:
    if config.audit_configured:
        return FirestoreAuditStore(config.firestore_project, config.audit_collection)
    return NoopAuditStore()


def create_app(
    backend: AgentBackend | None = None,
    config: FacadeSettings | None = None,
    audit: AuditStore | None = None,
) -> FastAPI:
    cfg = config or settings
    agent = backend or build_backend(cfg)
    audit_store = audit or build_audit_store(cfg)

    card = build_agent_card(agent, cfg.agent_id, cfg.public_url)
    executor = HolmesAgentExecutor(
        agent, timeout_seconds=cfg.holmes_timeout_seconds, audit=audit_store
    )
    handler = DefaultRequestHandler(
        agent_executor=executor,
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )

    app = FastAPI(title="sanba-a2a-facade", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok", "backend": cfg.backend}

    add_a2a_routes_to_fastapi(
        app,
        agent_card_routes=create_agent_card_routes(card),
        jsonrpc_routes=create_jsonrpc_routes(
            handler, rpc_url=rpc_path(cfg.agent_id), enable_v0_3_compat=True
        ),
    )
    return app
