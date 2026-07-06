"""Worker settings (env-driven, mirrors the api's config shape for shared pieces)."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict
from sanba_shared.grounding import GroundingConfig
from sanba_shared.media import MediaConfig


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # GCP / Gemini
    google_cloud_project: str = "sanba-dev"
    google_cloud_location: str = "us-central1"
    google_genai_use_vertexai: bool = False
    google_api_key: str = ""
    gemini_vision_model: str = "gemini-2.5-flash"
    gemini_embed_model: str = "gemini-embedding-001"

    # Storage / grounding
    gcs_bucket: str = ""
    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    mask_pii_before_index: bool = True

    # Video guardrails (ADR-0040: 短尺前提)
    max_video_duration_seconds: int = 600
    # GenAI API（ローカル）で inline 送信できる上限の目安。超過はローカルでは弾く
    # （本番 Vertex は gs:// URI 直渡しのため無関係）。
    max_inline_video_bytes: int = 20_000_000

    data_retention_days: int = 30

    def grounding_config(self) -> GroundingConfig:
        return GroundingConfig(
            elasticsearch_url=self.elasticsearch_url,
            elasticsearch_api_key=self.elasticsearch_api_key,
            embed_model=self.gemini_embed_model,
            use_vertexai=self.google_genai_use_vertexai,
            google_api_key=self.google_api_key,
            mask_pii=self.mask_pii_before_index,
        )

    def media_config(self) -> MediaConfig:
        return MediaConfig(
            vision_model=self.gemini_vision_model,
            use_vertexai=self.google_genai_use_vertexai,
            google_api_key=self.google_api_key,
        )


settings = WorkerSettings()
