"""Worker settings (env-driven, mirrors the api's config shape for shared pieces)."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict
from sanba_shared.grounding import GroundingConfig
from sanba_shared.media import MediaConfig


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"

    google_cloud_project: str = "sanba-dev"
    google_cloud_location: str = "us-central1"
    google_genai_use_vertexai: bool = False
    google_api_key: str = ""
    gemini_vision_model: str = "gemini-2.5-flash"
    gemini_embed_model: str = "gemini-embedding-001"

    gcs_bucket: str = ""
    oidc_audience: str = ""
    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    require_elasticsearch: bool = False
    mask_pii_before_index: bool = True

    max_video_duration_seconds: int = 600
    max_inline_video_bytes: int = 20_000_000

    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "sanba-worker"
    otel_exporter_insecure: bool = False
    otel_traces_to_cloud_trace: bool = True

    enable_realtime_publish: bool = True
    livekit_url: str = ""
    livekit_server_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""

    @property
    def is_production(self) -> bool:
        return self.environment.strip().lower() in {"production", "prod"}

    @property
    def livekit_publish_url(self) -> str:
        return self.livekit_server_url or self.livekit_url

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
