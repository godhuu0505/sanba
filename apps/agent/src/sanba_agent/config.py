"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    google_api_key: str = ""
    google_genai_use_vertexai: bool = False
    google_cloud_project: str = "sanba-dev"
    google_cloud_location: str = "us-central1"
    gemini_live_model: str = "gemini-live-2.5-flash-native-audio"
    gemini_reasoning_model: str = "gemini-2.5-flash"
    gemini_language: str = "ja-JP"

    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"

    turn_silence_duration_ms: int = 1200
    turn_end_sensitivity: str = "low"
    turn_start_sensitivity: str = ""
    turn_prefix_padding_ms: int = 100

    gemini_context_window_compression: bool = True
    gemini_context_trigger_tokens: int = 25600
    gemini_context_sliding_window_tokens: int = 12800
    voice_session_max_restarts: int = 3
    voice_session_restart_backoff_s: float = 2.0

    voice_opening_reply_timeout_s: float = 8.0
    voice_opening_max_attempts: int = 3

    voice_reply_watchdog_timeout_s: float = 20.0

    analysis_timeout_seconds: float = 20.0
    analysis_ride_along_timeout_seconds: float = 10.0

    session_score_timeout_seconds: float = 4.0

    voice_completion_shutdown_delay_s: float = 6.0

    noise_cancellation_enabled: bool = True

    firestore_emulator_host: str = ""

    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    gemini_embed_model: str = "gemini-embedding-001"

    mask_pii_before_index: bool = True
    data_retention_days: int = 30

    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "sanba-agent"
    otel_exporter_insecure: bool = False
    otel_traces_to_cloud_trace: bool = True

    github_connector_enabled: bool = False
    github_token: str = ""
    github_repo: str = ""


settings = Settings()
