"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Google / Gemini
    google_api_key: str = ""
    google_genai_use_vertexai: bool = False
    google_cloud_project: str = "kikitori-dev"
    google_cloud_location: str = "us-central1"
    gemini_live_model: str = "gemini-2.0-flash-live-001"
    gemini_reasoning_model: str = "gemini-2.5-flash"

    # LiveKit
    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"

    # Firestore
    firestore_emulator_host: str = ""

    # Elasticsearch (RAG grounding + past-session search)
    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    gemini_embed_model: str = "text-embedding-004"

    # Data governance (issue #10)
    mask_pii_before_index: bool = True
    data_retention_days: int = 30

    # Observability
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "kikitori-agent"
    langfuse_host: str = ""
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""


settings = Settings()
