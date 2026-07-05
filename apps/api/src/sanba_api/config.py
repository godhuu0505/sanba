"""API configuration."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"
    # server-side publish（analysis.progress/visual を RoomService.send_data で送る / ADR-0023）
    # 用の LiveKit URL。通常は livekit_url と同一だが、docker-compose ローカルでは食い違う:
    # ブラウザへ返す join URL は host から見た localhost、api コンテナからの publish 先は
    # compose のサービス名（ws://livekit:7880）である必要がある（agent の AGENT_LIVEKIT_URL と
    # 同じ発想）。未設定なら livekit_url にフォールバックする（LiveKit Cloud 等、両者が同じ
    # 公開 wss URL で足りる本番では設定不要）。
    livekit_server_url: str = ""

    @property
    def livekit_publish_url(self) -> str:
        """server-side publish に使う URL（未設定ならブラウザ向けと同じ livekit_url）。"""
        return self.livekit_server_url or self.livekit_url

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

    # ---- ゲスト入場 (ADR-0032) ----
    # scope=end_user の深掘りリンクを Google ログインなしで受けるか。既定 off（フェイル
    # クローズ）。段階リリース用のフラグで、on でも他 API の認可は変わらない（決定1）。
    guest_join_enabled: bool = False
    # 深掘りリンク（invite）単位のセッション作成レート制限（毎分・ADR-0032 決定5 / FR-2.6）。
    # IP 単位の join_rate_per_minute と重ねて掛かる。多インスタンスでも Firestore の
    # invite 文書カウンタで整合する（in-memory fallback あり）。超過は 429。
    invite_join_rate_per_minute: int = 10

    # ---- メンバー招待 (ADR-0036) ----
    # メンバー招待の有効期限（秒）。深掘りリンクと違い永続権限の付与なので必ず期限を切る。
    member_invite_ttl_seconds: int = 14 * 24 * 3600
    # product あたりの保留中招待の上限。任意メール宛の送信エンドポイントを bulk メール送信に
    # 乱用されないための総量ガード（超過は 429）。1 チームのメンバー数として十分大きい値。
    member_invite_max_pending_per_product: int = 50
    # 招待メール・招待 URL に載せる web のベース URL（例: https://sanba.example.com）。
    web_base_url: str = "http://localhost:3000"
    # 招待メールの SMTP 送信設定。smtp_host 未設定なら送信をスキップする（フェイルオープン:
    # アプリ内通知が常に届くため招待自体は成立する。skipped はメトリクスで観測できる）。
    # 認証情報は Secret Manager 経由で注入する（生のまま env に置かない）。
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "SANBA <no-reply@sanba.local>"
    # STARTTLS で暗号化する（既定 on。平文 SMTP はローカルの mailpit 等の検証用途のみ）。
    smtp_starttls: bool = True

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
    # 既定 ON（#287 で実ルームへの publish 到達・LiveKit 断時の fail-open をスモークテスト済み）。
    # ローカル/CI では LiveKit へ未接続だと送信が失敗し警告ログになるだけで本処理は止まらない
    # （web は未接続でも GET context/files のハイドレーションで状態を復元できる）。
    enable_realtime_publish: bool = True

    # ---- Requirement export -> GitHub Issue (契約 §4 POST /export, #39) ----
    # OFF by default. Enable + provide a token/repo to let 09 要件絵巻 起票する。
    github_connector_enabled: bool = False
    github_token: str = ""
    github_repo: str = ""  # "owner/name"
    # セッション単位で選択・保存できるリポジトリの許可リスト（ADR-0027 / Codex P1）。
    # "owner"（配下すべて）または "owner/name" のカンマ区切り。空 = 制限なし
    # （単一チームでの利用前提。SANBA にログインできる全員が候補一覧を見られる点に注意）。
    github_repo_allowlist: str = ""

    # ---- GitHub App: per-user repo linking (ADR-0028) ----
    # 連携機能のフラグ。未設定（app id/秘密鍵なし）の構成では連携経路をフェイルクローズする。
    github_app_enabled: bool = False
    # GitHub App の数値 ID（App 認証 JWT の iss）。秘匿物ではない。
    github_app_id: str = ""
    # GitHub App の秘密鍵（PEM）。Secret Manager 経由で注入する。生のまま env に置かない。
    github_app_private_key: str = ""
    # install フローで使う App slug（https://github.com/apps/<slug>/installations/new）。
    github_app_slug: str = ""
    # GitHub App の OAuth client（user-to-server）。install 時にユーザー認可も取り、callback で
    # 「そのユーザーが当該 installation を実際に保有するか」を検証して別人の installation_id
    # 横取りを防ぐ（ADR-0028 / Codex P1）。両方設定されているときに検証を有効化する。
    # App 設定で "Request user authorization (OAuth) during installation" を ON にすること。
    github_app_client_id: str = ""
    github_app_client_secret: str = ""
    # install 完了後に GitHub から戻すコールバック先（api の絶対 URL。App 登録側の Setup URL）。
    github_app_callback_url: str = ""
    # 連携保存後にユーザーを戻す web 設定画面の URL（api callback とは別物。ここへ 302 する）。
    github_app_web_return_url: str = ""
    # 連携開始時に発行する state 署名の有効期限（CSRF/誤紐づけ対策・ADR-0028）。
    github_link_state_ttl_seconds: int = 600
    # ---- repo 索引の総量キャップ（関連度優先 + 上限・ADR-0028）----
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
