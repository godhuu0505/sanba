"""Agent Builder への冪等プロビジョニング（ADR-0063）。

`definitions/` の宣言的定義を Agent Builder の Kibana API へ upsert する。ADR-0061
`analytics_setup.py` と同じ「存在確認 → 作成/更新」+ fail-soft + 追加依存なし（urllib）の流儀。
プロビジョニング計画（どの URL に何メソッドを送るか）は純関数で組み立て、単体テストで固定する。
実際の送信だけをネットワーク境界に隔離する。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

import structlog

from .config import ElasticAgentSettings
from .contract import _root
from .definitions import AgentDefinition, ToolDefinition, load_definitions

log = structlog.get_logger(__name__)

TOOLS_PATH = "api/agent_builder/tools"
AGENTS_PATH = "api/agent_builder/agents"


@dataclass(frozen=True)
class ProvisionStep:
    kind: str
    entity_id: str
    collection_url: str
    item_url: str
    body: dict


def _collection_url(kibana_url: str, path: str, space: str) -> str:
    return f"{_root(kibana_url, space)}/{path}"


def plan_provision(
    kibana_url: str,
    tools: list[ToolDefinition],
    agent: AgentDefinition,
    space: str = "",
) -> list[ProvisionStep]:
    """ツール群 → エージェントの順で upsert する計画を純粋に組み立てる（順序が依存関係）。"""
    steps: list[ProvisionStep] = []
    tools_collection = _collection_url(kibana_url, TOOLS_PATH, space)
    for tool in tools:
        steps.append(
            ProvisionStep(
                kind="tool",
                entity_id=tool.id,
                collection_url=tools_collection,
                item_url=f"{tools_collection}/{tool.id}",
                body=tool.body,
            )
        )
    agents_collection = _collection_url(kibana_url, AGENTS_PATH, space)
    steps.append(
        ProvisionStep(
            kind="agent",
            entity_id=agent.id,
            collection_url=agents_collection,
            item_url=f"{agents_collection}/{agent.id}",
            body=agent.body,
        )
    )
    return steps


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "kbn-xsrf": "sanba",
        "Authorization": f"ApiKey {api_key}",
    }


def _send(
    url: str, method: str, api_key: str, payload: dict, timeout: float
) -> None:  # pragma: no cover
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method=method, headers=_headers(api_key)
    )
    with urllib.request.urlopen(request, timeout=timeout):  # noqa: S310
        return None


def _upsert(step: ProvisionStep, api_key: str, timeout: float) -> None:  # pragma: no cover
    try:
        _send(step.collection_url, "POST", api_key, step.body, timeout)
    except urllib.error.HTTPError as exc:
        if exc.code not in (409, 400):
            raise
        _send(step.item_url, "PUT", api_key, step.body, timeout)


def provision(settings: ElasticAgentSettings) -> int:  # pragma: no cover
    """定義を読み、Agent Builder へ冪等に upsert する。設定不備なら 0 を返す（fail-soft）。"""
    if not (settings.kibana_url and settings.api_key):
        log.warning("elastic_agent_provision_skipped_unconfigured")
        return 0
    tools, agent = load_definitions()
    steps = plan_provision(settings.kibana_url, tools, agent, settings.space)
    for step in steps:
        _upsert(step, settings.api_key, settings.request_timeout_seconds)
    log.info("elastic_agent_provisioned", tools=len(tools), agent=agent.id)
    return len(steps)


if __name__ == "__main__":  # pragma: no cover
    from .config import settings as _settings

    provision(_settings)
