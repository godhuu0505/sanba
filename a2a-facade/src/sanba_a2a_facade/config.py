"""A2A ファサードの設定（env 駆動、ADR-0069）。

`agent_instructions` は Phase 0.5 で実証した偽陰性対策のノブ: エージェント定義（索引スキーマと
クエリ実例）をバックエンドの per-request システムプロンプトへ注入する。HolmesGPT では
`/api/chat` の `additional_system_prompt` に渡る。
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class FacadeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="a2a_facade_", extra="ignore")

    backend: str = "holmesgpt"
    agent_id: str = "sanba-sre-scout"
    agent_name: str = "SANBA SRE Scout"
    agent_description: str = (
        "SANBA 本番の分析イベント（Elasticsearch）とログを read-only で調査する SRE エージェント"
    )
    agent_instructions: str = ""
    holmes_url: str = "http://localhost:8081"
    holmes_timeout_seconds: float = 300.0
    public_url: str = ""
    audit_enabled: bool = False
    firestore_project: str = ""
    audit_collection: str = "holmes-investigations"

    @property
    def audit_configured(self) -> bool:
        return bool(self.audit_enabled and self.firestore_project)


settings = FacadeSettings()
