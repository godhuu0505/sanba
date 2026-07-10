"""Elastic Agent Builder への A2A クライアント（ADR-0063）。

プロバイダー非依存の A2A 部品（`..a2a_client`）と URL 契約（`..contract`）を、Elastic 固有の
設定（`ELASTIC_AGENT_*`）で束ねる。実際の送信は `settings.configured`（enabled + URL + key）が
真のときだけ行い、未設定・失敗時は fail-soft に `DelegationResult(delegated=False, ...)` を返す
（ADR-0003 縮退・ADR-0007 flag OFF と同型）。

**音声クリティカルパスから直接呼ばない**。ADK 分析層の off-loop 非同期からのみ呼ぶ
（ADR-0046/0002）。Elastic の A2A は同期・非ストリーミングで、往復を会話に載せてはならない。
"""

from __future__ import annotations

import json
import urllib.request

import structlog

from ..a2a_client import DelegationResult, build_message_send, extract_text
from ..contract import a2a_message_url, require_http_url
from .config import ElasticAgentSettings, settings

log = structlog.get_logger(__name__)


class ElasticAgentClient:
    """境界の向こうの Elastic エージェント（初弾は外部コンテキスト）への A2A クライアント。"""

    def __init__(self, config: ElasticAgentSettings | None = None) -> None:
        self._settings = config or settings

    def ask(self, question: str) -> DelegationResult:
        if not self._settings.configured:
            return DelegationResult(delegated=False, error="elastic_agent_not_configured")
        try:
            response = self._send(question)
        except Exception as exc:  # noqa: BLE001
            log.warning("elastic_a2a_delegation_failed", error=str(exc))
            return DelegationResult(delegated=False, error=str(exc))
        return DelegationResult(delegated=True, text=extract_text(response), raw=response)

    def _send(self, question: str) -> dict:  # pragma: no cover
        url = require_http_url(
            a2a_message_url(
                self._settings.kibana_url, self._settings.agent_id, self._settings.space
            )
        )
        body = json.dumps(build_message_send(question)).encode()
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "kbn-xsrf": "sanba",
                "Authorization": f"ApiKey {self._settings.api_key}",
            },
        )
        with urllib.request.urlopen(  # noqa: S310
            request, timeout=self._settings.request_timeout_seconds
        ) as response:
            payload: dict = json.loads(response.read().decode())
        return payload
