"""Elastic Agent 境界の設定（env 駆動、ADR-0063）。

`elastic_agent_enabled` は既定 OFF（ADR-0007 の GitHub コネクタと同じ流儀）。`kibana_url` や
API キーが空なら seam は no-op で縮退し、クリティカルパス・テスト・デモを止めない（ADR-0003 の型）。
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class ElasticAgentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="elastic_agent_", extra="ignore")

    enabled: bool = False
    kibana_url: str = ""
    api_key: str = ""
    space: str = ""
    agent_id: str = "sanba-analytics-agent"
    analytics_index: str = "sanba-analytics-*"
    request_timeout_seconds: float = 30.0

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.kibana_url and self.api_key)


settings = ElasticAgentSettings()
