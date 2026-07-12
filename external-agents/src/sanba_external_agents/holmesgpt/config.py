"""HolmesGPT 境界の設定（env 駆動、ADR-0069）。

`holmesgpt_agent_enabled` は既定 OFF（ADR-0063 決定3 の流儀）。`base_url` が空なら seam は
no-op で縮退し、クリティカルパス・テスト・デモを止めない。`timeout_seconds` の既定は 300 秒
— HolmesGPT のエージェンティック調査は数十秒〜数分かかるため、`elastic/` の 30 秒既定では
必ず不足する（ADR-0069 Phase 0.5 実測）。
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class HolmesgptAgentSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="holmesgpt_agent_", extra="ignore"
    )

    enabled: bool = False
    base_url: str = ""
    agent_id: str = "sanba-sre-scout"
    id_token: str = ""
    request_timeout_seconds: float = 300.0

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.base_url)


settings = HolmesgptAgentSettings()
