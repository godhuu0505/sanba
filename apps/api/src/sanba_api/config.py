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
    # OTLP 転送の TLS。localhost collector sidecar では true（平文 gRPC）、
    # TLS 終端された外部 OTLP 直送では false（既定）。
    otel_exporter_insecure: bool = False

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
    gemini_embed_model: str = "gemini-embedding-001"
    # Max characters accepted per context upload (guards memory/cost).
    max_context_chars: int = 200_000

    # ---- Multimodal assets: 画像/動画アップロード (issue #103 / ADR-0004) ----
    # Cloud Storage バケット名。未設定なら in-memory にフォールバック（ローカル/テスト）。
    gcs_bucket: str = ""
    # 画像/動画 1 件あたりのバイト上限（メモリ/コスト/帯域のガード）。既定 25MB。
    max_asset_bytes: int = 25_000_000
    # 画像解析に使う Gemini マルチモーダルモデル。
    gemini_vision_model: str = "gemini-2.5-flash"
    # 動画解析は未実装（web では「準備中」でグレーアウト）。有効化は別 PR。
    enable_video_analysis: bool = False
    # アップロード解析の進捗を LiveKit データチャネルへ live publish するか（#145 / ADR-0023）。
    # 既定 OFF: ローカル/CI/未接続では no-op にし、LiveKit へ実接続できる本番でのみ有効化する
    # （web は OFF でも GET context/files のハイドレーションで状態を復元できる）。
    enable_realtime_publish: bool = False

    # ---- Requirement export -> GitHub Issue (契約 §4 POST /export, #39) ----
    # OFF by default. Enable + provide a token/repo to let 09 要件絵巻 起票する。
    github_connector_enabled: bool = False
    github_token: str = ""
    github_repo: str = ""  # "owner/name"

    # ---- GitHub App: per-user repo linking (ADR-0025) ----
    # 連携機能のフラグ。未設定（app id/秘密鍵なし）の構成では連携経路をフェイルクローズする。
    github_app_enabled: bool = False
    # GitHub App の数値 ID（App 認証 JWT の iss）。秘匿物ではない。
    github_app_id: str = ""
    # GitHub App の秘密鍵（PEM）。Secret Manager 経由で注入する。生のまま env に置かない。
    github_app_private_key: str = ""
    # install フローで使う App slug（https://github.com/apps/<slug>/installations/new）。
    github_app_slug: str = ""
    # install 完了後に GitHub から戻すコールバック先（api の絶対 URL）。
    github_app_callback_url: str = ""
    # 連携開始時に発行する state 署名の有効期限（CSRF/誤紐づけ対策・ADR-0025）。
    github_link_state_ttl_seconds: int = 600
    # ---- repo 索引の総量キャップ（関連度優先 + 上限・ADR-0025）----
    # 索引対象の最大ファイル数と総バイト。超過分はスキップして log + UI に出す。
    github_index_max_files: int = 1500
    github_index_max_total_bytes: int = 20_000_000
    # 単一ファイルのバイト上限（巨大ファイル/生成物の混入ガード）。
    github_index_max_file_bytes: int = 200_000

    # ---- Data governance (issue #10) ----
    # Mask PII before context is written to the shared grounding index.
    mask_pii_before_index: bool = True
    # Require explicit consent (recording + AI processing) to create a session.
    require_consent: bool = True
    # Retention for session data (utterances/requirements). 0 = keep indefinitely.
    data_retention_days: int = 30


settings = Settings()
