from __future__ import annotations

import json

import httpx
import pytest
from a2a.helpers.proto_helpers import new_text_message
from a2a.types.a2a_pb2 import Role, SendMessageResponse
from google.protobuf.json_format import MessageToDict

from sanba_agent.config import Settings
from sanba_agent.holmes_delegation import (
    HolmesDelegator,
    delegation_allowed,
    is_operator,
)

ADMIN = "ops@sanba.example.com"


def _settings(**overrides) -> Settings:
    base = {
        "holmesgpt_agent_enabled": True,
        "holmesgpt_agent_base_url": "https://facade.example.com",
        "holmesgpt_agent_id": "sanba-sre-scout",
        "holmesgpt_invoker_sa": "holmes-invoker@sanba-prd.iam.gserviceaccount.com",
        "admin_emails": ADMIN,
    }
    base.update(overrides)
    return Settings(**base)


def test_is_operator_truth_table():
    admins = {ADMIN}
    assert is_operator(ADMIN, admins) is True
    assert is_operator(ADMIN.upper(), admins) is True
    assert is_operator("  " + ADMIN + " ", admins) is True
    assert is_operator("someone@else.com", admins) is False
    assert is_operator(None, admins) is False
    assert is_operator("", admins) is False


def test_delegation_allowed_requires_all_three_gates():
    cfg = _settings()
    assert delegation_allowed(cfg, owner_email=ADMIN, allow_internal=True) is True
    assert delegation_allowed(cfg, owner_email=ADMIN, allow_internal=False) is False
    assert delegation_allowed(cfg, owner_email="user@end.com", allow_internal=True) is False
    disabled = _settings(holmesgpt_agent_enabled=False)
    assert delegation_allowed(disabled, owner_email=ADMIN, allow_internal=True) is False
    unconfigured = _settings(holmesgpt_agent_base_url="")
    assert delegation_allowed(unconfigured, owner_email=ADMIN, allow_internal=True) is False


class _StubDelegator(HolmesDelegator):
    def __init__(self, config: Settings, handler) -> None:
        super().__init__(config)
        self._handler = handler
        self.seen_auth: str | None = None
        self.seen_body: dict | None = None

    def _id_token(self) -> str:
        return "test-id-token"

    def _build_httpx_client(self, token: str) -> httpx.AsyncClient:
        delegator = self

        def _capture(request: httpx.Request) -> httpx.Response:
            delegator.seen_auth = request.headers.get("Authorization")
            delegator.seen_body = json.loads(request.content)
            return delegator._handler(request)

        return httpx.AsyncClient(
            transport=httpx.MockTransport(_capture),
            headers={"Authorization": f"Bearer {token}"},
        )


def _ok_handler(answer: str):
    def handler(request: httpx.Request) -> httpx.Response:
        rpc_id = json.loads(request.content)["id"]
        response = SendMessageResponse(message=new_text_message(answer, role=Role.ROLE_AGENT))
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": rpc_id, "result": MessageToDict(response)},
        )

    return handler


@pytest.mark.asyncio
async def test_investigate_returns_backend_text_with_bearer_token():
    delegator = _StubDelegator(_settings(), _ok_handler("本番のエラーは 0 件です"))
    result = await delegator.investigate("本番のエラー状況を調べて", caller="sess-xyz")
    assert result.ok is True
    assert result.text == "本番のエラーは 0 件です"
    assert delegator.seen_auth == "Bearer test-id-token"
    assert delegator.seen_body is not None
    assert delegator.seen_body["params"]["metadata"]["caller"] == "sess-xyz"


@pytest.mark.asyncio
async def test_investigate_is_noop_when_not_configured():
    delegator = HolmesDelegator(_settings(holmesgpt_agent_enabled=False))
    result = await delegator.investigate("調べて")
    assert result.ok is False
    assert result.error == "holmesgpt_not_configured"


@pytest.mark.asyncio
async def test_investigate_fail_soft_on_backend_error():
    def error_handler(request: httpx.Request) -> httpx.Response:
        rpc_id = json.loads(request.content)["id"]
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": rpc_id,
                "error": {"code": -32603, "message": "backend investigation failed"},
            },
        )

    delegator = _StubDelegator(_settings(), error_handler)
    result = await delegator.investigate("調べて")
    assert result.ok is False
    assert result.error
