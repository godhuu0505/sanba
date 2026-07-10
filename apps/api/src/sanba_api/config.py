"""API configuration."""

from __future__ import annotations

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_SIGNING_SECRET_DEFAULT = "dev-only-insecure-secret-change-me"
INSECURE_LIVEKIT_KEY_DEFAULT = "devkey"
INSECURE_LIVEKIT_SECRET_DEFAULT = "secret"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"

    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"
    livekit_server_url: str = ""

    @property
    def livekit_publish_url(self) -> str:
        """server-side publish に使う URL（未設定ならブラウザ向けと同じ livekit_url）。"""
        return self.livekit_server_url or self.livekit_url

    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "sanba-api"
    otel_exporter_insecure: bool = False
    otel_traces_to_cloud_trace: bool = True

    allowed_origins: str = "http://localhost:3000"

    session_signing_secret: str = "dev-only-insecure-secret-change-me"
    invite_ttl_seconds: int = 3600
    livekit_token_ttl_minutes: int = 60
    auth_dev_bypass: bool = False
    join_rate_per_minute: int = 30

    guest_join_enabled: bool = False
    invite_join_rate_per_minute: int = 10

    member_invite_ttl_seconds: int = 14 * 24 * 3600
    member_invite_max_pending_per_product: int = 50
    web_base_url: str = "http://localhost:3000"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "SANBA <no-reply@sanba.local>"
    smtp_starttls: bool = True

    google_oauth_client_id: str = ""

    require_login_nonce: bool = False
    auth_nonce_ttl_seconds: int = 3900

    session_cookie_ttl_seconds: int = 8 * 3600
    session_absolute_ttl_seconds: int = 24 * 3600
    session_cookie_secure: bool = True
    session_cookie_domain: str = ""

    admin_emails: str = ""

    room_creator_allowlist: str = ""

    firestore_emulator_host: str = ""
    google_cloud_project: str = "sanba-dev"

    @property
    def admin_email_set(self) -> frozenset[str]:
        """正規化済みの管理者 email 集合 (小文字・前後空白除去)。"""
        return frozenset(e.strip().lower() for e in self.admin_emails.split(",") if e.strip())

    @property
    def room_creator_allow_set(self) -> frozenset[str]:
        """ルーム作成を許可する email/ドメインの集合 (小文字・前後空白除去)。空=無制限。"""
        return frozenset(
            e.strip().lower() for e in self.room_creator_allowlist.split(",") if e.strip()
        )

    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    require_elasticsearch: bool = False
    google_api_key: str = ""
    google_genai_use_vertexai: bool = False
    gemini_embed_model: str = "gemini-embedding-001"
    gemini_reasoning_model: str = "gemini-2.5-flash"
    max_context_chars: int = 200_000

    gcs_bucket: str = ""
    max_asset_bytes: int = 25_000_000
    max_video_asset_bytes: int = 200_000_000
    gemini_vision_model: str = "gemini-2.5-flash"
    enable_video_analysis: bool = False

    video_tasks_queue: str = ""
    video_tasks_location: str = ""
    worker_url: str = ""
    worker_invoker_sa: str = ""
    local_direct_dispatch: bool = False
    signed_url_ttl_seconds: int = 900
    analysis_stuck_after_seconds: int = 1800
    enable_realtime_publish: bool = True

    github_connector_enabled: bool = False
    github_token: str = ""
    github_repo: str = ""
    github_repo_allowlist: str = ""

    github_app_enabled: bool = False
    github_app_id: str = ""
    github_app_private_key: str = ""
    github_app_slug: str = ""
    github_app_client_id: str = ""
    github_app_client_secret: str = ""
    github_app_callback_url: str = ""
    github_app_web_return_url: str = ""
    github_link_state_ttl_seconds: int = 600
    github_index_max_files: int = 1500
    github_index_max_total_bytes: int = 20_000_000
    github_index_max_file_bytes: int = 200_000

    mask_pii_before_index: bool = True
    require_consent: bool = True
    data_retention_days: int = 30

    @property
    def is_production(self) -> bool:
        """`ENVIRONMENT` が production/prod のとき真（fail-closed 検証の発火条件）。"""
        return self.environment.strip().lower() in {"production", "prod"}

    @model_validator(mode="after")
    def _reject_insecure_production_config(self) -> Settings:
        """本番環境では既知の脆弱デフォルト値・開発用バイパスを拒否して起動を止める。

        公開ソース上の固定シークレットや認証バイパスフラグのまま本番デプロイされると
        認証・認可が事実上無効化されるため、production では即時に例外を投げてフェイルクローズ
        させる（設定漏れをフェイルオープンにしない）。
        """
        if not self.is_production:
            return self
        insecure: list[str] = []
        if (
            not self.session_signing_secret
            or self.session_signing_secret == INSECURE_SIGNING_SECRET_DEFAULT
        ):
            insecure.append("SESSION_SIGNING_SECRET")
        if self.livekit_api_key == INSECURE_LIVEKIT_KEY_DEFAULT:
            insecure.append("LIVEKIT_API_KEY")
        if self.livekit_api_secret == INSECURE_LIVEKIT_SECRET_DEFAULT:
            insecure.append("LIVEKIT_API_SECRET")
        if self.auth_dev_bypass:
            insecure.append("AUTH_DEV_BYPASS")
        if self.local_direct_dispatch:
            insecure.append("LOCAL_DIRECT_DISPATCH")
        if insecure:
            raise ValueError(
                "insecure configuration rejected for production ENVIRONMENT: "
                + ", ".join(insecure)
                + " must be overridden with secure values"
            )
        return self


settings = Settings()
