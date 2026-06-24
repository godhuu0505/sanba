"""API configuration."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"

    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "sanba-api"

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

    # ---- Identity: Google ログイン (ADR-0012) ----
    # OAuth 2.0 Web クライアント ID。ID トークン検証の `aud` に使う (秘匿物ではない)。
    # 未設定かつ auth_dev_bypass=false の本番構成では認証経路をフェイルクローズする。
    google_oauth_client_id: str = ""

    # ---- 管理者 (ADR-0014 §2) ----
    # 管理画面を使える Google アカウントの email 許可リスト (カンマ区切り)。
    # 検証済み identity の email をサーバ側で照合する。dev bypass でも照合する (§13)。
    admin_emails: str = ""

    # ---- Firestore (ADR-0014 §15) ----
    # api はセッション/要件のリーダー兼ライターになった。emulator 利用時は接続先を
    # FIRESTORE_EMULATOR_HOST で指定する (compose ではローカルの firestore:8200)。
    firestore_emulator_host: str = ""
    google_cloud_project: str = "sanba-dev"

    @property
    def admin_email_set(self) -> frozenset[str]:
        """正規化済みの管理者 email 集合 (小文字・前後空白除去)。"""
        return frozenset(e.strip().lower() for e in self.admin_emails.split(",") if e.strip())

    # ---- Context ingestion -> RAG grounding (issue #6) ----
    # Shared with the agent's grounding store (same Elasticsearch index).
    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    google_api_key: str = ""
    google_genai_use_vertexai: bool = False
    gemini_embed_model: str = "text-embedding-004"
    # Max characters accepted per context upload (guards memory/cost).
    max_context_chars: int = 200_000

    # ---- Data governance (issue #10) ----
    # Mask PII before context is written to the shared grounding index.
    mask_pii_before_index: bool = True
    # Require explicit consent (recording + AI processing) to create a session.
    require_consent: bool = True
    # Retention for session data (utterances/requirements). 0 = keep indefinitely.
    data_retention_days: int = 30


settings = Settings()
