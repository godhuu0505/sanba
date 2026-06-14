"""API configuration."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"

    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "kikitori-api"

    # CORS allowlist for the web client
    allowed_origins: str = "http://localhost:3000"

    # ---- Access control ----
    # Secret used to sign session invites. MUST be overridden in prod (Secret Manager).
    session_signing_secret: str = "dev-only-insecure-secret-change-me"
    invite_ttl_seconds: int = 3600
    # LiveKit join token lifetime.
    livekit_token_ttl_minutes: int = 60
    # Local-dev escape hatch: allow joining without an invite. Never enable in prod.
    auth_dev_bypass: bool = False
    # Simple per-IP rate limit on join (requests per minute).
    join_rate_per_minute: int = 30

    # ---- Context ingestion -> RAG grounding (issue #6) ----
    # Shared with the agent's grounding store (same Elasticsearch index).
    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    google_api_key: str = ""
    google_genai_use_vertexai: bool = False
    gemini_embed_model: str = "text-embedding-004"
    # Max characters accepted per context upload (guards memory/cost).
    max_context_chars: int = 200_000


settings = Settings()
