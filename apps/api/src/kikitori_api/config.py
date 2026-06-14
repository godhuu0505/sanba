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


settings = Settings()
