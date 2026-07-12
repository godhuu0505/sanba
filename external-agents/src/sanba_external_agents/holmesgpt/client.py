"""HolmesGPT（A2A ファサード越し）への A2A クライアント（ADR-0069）。

プロバイダー非依存の A2A 部品（`..a2a_client`）とファサードの URL 契約（`.contract`）を
HolmesGPT 固有の設定（`HOLMESGPT_AGENT_*`）で束ねる。実際の送信は `settings.configured`
（enabled + base_url）が真のときだけ行い、未設定・失敗時は fail-soft に
`DelegationResult(delegated=False, ...)` を返す（`elastic/client.py` と同型）。

認証は Cloud Run の IAM（ID トークン）。`id_token` が設定されていれば
`Authorization: Bearer` を付与する（開発者は `gcloud auth print-identity-token` の値を
環境変数で渡す。Cloud Run 上の呼び出し元は metadata server から取得した値を渡す）。

**音声クリティカルパスから直接呼ばない**。HolmesGPT の調査は数十秒〜数分かかるため、
呼ぶ場合は ADK 分析層の off-loop 非同期からのみ（ADR-0069 決定6 / ADR-0046）。
"""

from __future__ import annotations

import json
import urllib.request

import structlog

from ..a2a_client import DelegationResult, build_message_send, extract_text
from .config import HolmesgptAgentSettings, settings
from .contract import a2a_message_url, require_http_url

log = structlog.get_logger(__name__)


class HolmesAgentClient:
    """境界の向こうの HolmesGPT（SRE 調査エージェント）への A2A クライアント。"""

    def __init__(self, config: HolmesgptAgentSettings | None = None) -> None:
        self._settings = config or settings

    def ask(self, question: str) -> DelegationResult:
        if not self._settings.configured:
            return DelegationResult(delegated=False, error="holmesgpt_agent_not_configured")
        try:
            response = self._send(question)
        except Exception as exc:  # noqa: BLE001
            log.warning("holmesgpt_a2a_delegation_failed", error=str(exc))
            return DelegationResult(delegated=False, error=str(exc))
        return DelegationResult(delegated=True, text=extract_text(response), raw=response)

    def _send(self, question: str) -> dict:  # pragma: no cover
        url = require_http_url(a2a_message_url(self._settings.base_url, self._settings.agent_id))
        body = json.dumps(build_message_send(question)).encode()
        headers = {"Content-Type": "application/json"}
        if self._settings.id_token:
            headers["Authorization"] = f"Bearer {self._settings.id_token}"
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
        with urllib.request.urlopen(  # noqa: S310
            request, timeout=self._settings.request_timeout_seconds
        ) as response:
            payload: dict = json.loads(response.read().decode())
        return payload
