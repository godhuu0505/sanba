"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Google / Gemini
    google_api_key: str = ""
    google_genai_use_vertexai: bool = False
    google_cloud_project: str = "sanba-dev"
    google_cloud_location: str = "us-central1"
    gemini_live_model: str = "gemini-live-2.5-flash-native-audio"
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
    gemini_embed_model: str = "gemini-embedding-001"

    # Data governance (issue #10)
    mask_pii_before_index: bool = True
    data_retention_days: int = 30

    # Observability
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "sanba-agent"
    # OTLP 転送の TLS。localhost collector sidecar 構成では true（平文 gRPC）、
    # TLS 終端された外部 OTLP（Cloud Trace / Grafana Cloud 直送）では false（既定）。
    otel_exporter_insecure: bool = False
    langfuse_host: str = ""
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""

    # External connectors (issue #7). OFF by default — never affects the demo path.
    github_connector_enabled: bool = False
    github_token: str = ""
    github_repo: str = ""  # "owner/name"


settings = Settings()
