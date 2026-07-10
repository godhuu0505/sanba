"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_LIVEKIT_KEY_DEFAULT = "devkey"
INSECURE_LIVEKIT_SECRET_DEFAULT = "secret"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"

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
    session_close_analytics_timeout_seconds: float = 4.0

    voice_completion_shutdown_delay_s: float = 6.0

    noise_cancellation_enabled: bool = True

    firestore_emulator_host: str = ""

    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    require_elasticsearch: bool = False
    gemini_embed_model: str = "gemini-embedding-001"

    usd_jpy_rate: float = 150.0
    livekit_connection_usd_per_min: float = 0.0005
    livekit_agent_session_usd_per_min: float = 0.01
    livekit_noise_cancellation_usd_per_min: float = 0.005

    mask_pii_before_index: bool = True
    data_retention_days: int = 30

    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "sanba-agent"
    otel_exporter_insecure: bool = False
    otel_traces_to_cloud_trace: bool = True

    github_connector_enabled: bool = False
    github_token: str = ""
    github_repo: str = ""

    @property
    def is_production(self) -> bool:
        """`ENVIRONMENT` が production/prod のとき真（fail-closed 検証の発火条件）。"""
        return self.environment.strip().lower() in {"production", "prod"}

    @model_validator(mode="after")
    def _reject_insecure_production_config(self) -> Settings:
        """本番環境では LiveKit の既知デフォルト鍵での起動を拒否する（フェイルクローズ）。"""
        if not self.is_production:
            return self
        insecure: list[str] = []
        if self.livekit_api_key == INSECURE_LIVEKIT_KEY_DEFAULT:
            insecure.append("LIVEKIT_API_KEY")
        if self.livekit_api_secret == INSECURE_LIVEKIT_SECRET_DEFAULT:
            insecure.append("LIVEKIT_API_SECRET")
        if insecure:
            raise ValueError(
                "insecure configuration rejected for production ENVIRONMENT: "
                + ", ".join(insecure)
                + " must be overridden with secure values"
            )
        return self


settings = Settings()
