"""音声セッションからの HolmesGPT 委譲（A2A・off-loop、issue #547 / ADR-0069）。

operator が「本番を調べて」と言うと、エージェントがこの経路で ops の A2A ファサードへ
委譲する。A2A のプロトコル実装は公式 `a2a-sdk` の client を使う（自作の JSON-RPC は持たない）。
ファサードへの認証は dedicated 最小 SA（`holmesgpt_invoker_sa`）の impersonation で発行した
ID トークンを httpx の Authorization ヘッダに載せる。呼び出しは同期的に見えるが（~数十秒）、
**必ず音声ループ外のバックグラウンドタスクから**呼ぶこと（ADR-0069 決定6）。

ゲート判定はネットワーク非依存の純関数として切り出し単体テストで固定する。A2A 往復は
`_build_httpx_client` / `_id_token` を差し替え点にし、ファサード app への in-process 結合テストで
検証する。
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from dataclasses import dataclass

import httpx
import structlog
from a2a.client import ClientConfig, create_client
from a2a.helpers.proto_helpers import get_stream_response_text, new_text_message
from a2a.types.a2a_pb2 import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    Role,
    SendMessageRequest,
)
from a2a.utils.constants import TransportProtocol

from .config import Settings, settings

log = structlog.get_logger(__name__)


def is_operator(owner_email: str | None, admin_emails: Iterable[str]) -> bool:
    """セッション所有者が operator（admin）かを判定する。"""
    if not owner_email:
        return False
    return owner_email.strip().lower() in set(admin_emails)


def delegation_allowed(config: Settings, *, owner_email: str | None, allow_internal: bool) -> bool:
    """委譲を許可してよいか（flag × admin × 非 end_user の三重ゲート）。"""
    return (
        config.holmesgpt_configured
        and allow_internal
        and is_operator(owner_email, config.admin_email_set)
    )


@dataclass(frozen=True)
class InvestigationResult:
    ok: bool
    text: str = ""
    error: str | None = None


class HolmesDelegator:
    """ops A2A ファサードへの委譲クライアント（impersonation + a2a-sdk client）。"""

    def __init__(self, config: Settings | None = None) -> None:
        self._settings = config or settings

    async def investigate(self, question: str) -> InvestigationResult:
        if not self._settings.holmesgpt_configured:
            return InvestigationResult(ok=False, error="holmesgpt_not_configured")
        try:
            token = await asyncio.to_thread(self._id_token)
            text = await self._ask_via_a2a(question, token)
        except Exception as exc:  # noqa: BLE001
            log.warning("holmes_delegation_failed", error=str(exc))
            return InvestigationResult(ok=False, error=str(exc))
        return InvestigationResult(ok=True, text=text)

    def _agent_url(self) -> str:
        base = self._settings.holmesgpt_agent_base_url.rstrip("/")
        return f"{base}/a2a/{self._settings.holmesgpt_agent_id}"

    def _build_card(self) -> AgentCard:
        return AgentCard(
            name=self._settings.holmesgpt_agent_id,
            supported_interfaces=[
                AgentInterface(url=self._agent_url(), protocol_binding=TransportProtocol.JSONRPC)
            ],
            capabilities=AgentCapabilities(streaming=False),
            default_input_modes=["text/plain"],
            default_output_modes=["text/plain"],
        )

    def _build_httpx_client(self, token: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers={"Authorization": f"Bearer {token}"},
            timeout=self._settings.holmesgpt_timeout_seconds,
        )

    async def _ask_via_a2a(self, question: str, token: str) -> str:
        httpx_client = self._build_httpx_client(token)
        config = ClientConfig(streaming=False, httpx_client=httpx_client)
        client = await create_client(self._build_card(), client_config=config)
        request = SendMessageRequest(message=new_text_message(question, role=Role.ROLE_USER))
        text = ""
        try:
            async for response in client.send_message(request):
                chunk = get_stream_response_text(response)
                if chunk:
                    text = chunk
        finally:
            await client.close()
            await httpx_client.aclose()
        return text.strip()

    def _audience(self) -> str:
        return self._settings.holmesgpt_audience or self._settings.holmesgpt_agent_base_url

    def _id_token(self) -> str:  # pragma: no cover
        from google.auth import default
        from google.auth.impersonated_credentials import Credentials, IDTokenCredentials
        from google.auth.transport.requests import Request

        source, _ = default()
        target = Credentials(
            source_credentials=source,
            target_principal=self._settings.holmesgpt_invoker_sa,
            target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        id_creds = IDTokenCredentials(target, target_audience=self._audience(), include_email=True)
        id_creds.refresh(Request())
        return id_creds.token
