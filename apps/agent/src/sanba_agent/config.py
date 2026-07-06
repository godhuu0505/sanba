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

    # --- 音声ターン検出（Gemini Live 自動 VAD）の感度 ---
    # 参加者が話し終えたと判定するまでに要求する無音時間 (ms)。大きいほど発話途中の間で
    # エージェントが被せて話し始めにくくなる代わりに、応答開始は遅くなる。
    turn_silence_duration_ms: int = 800
    # 発話終端検出の感度。"low" = 終わったと判定されにくい（待ちが長い）/ "high" /
    # "" = サーバ既定。話し途中の割り込み対策の主レバー。
    turn_end_sensitivity: str = "low"
    # 発話開始検出の感度。"low" にすると相槌・環境音でエージェントの発話が中断されにくく
    # なるが、短い返事を取りこぼすリスクがある。既定はサーバ既定（""）。
    turn_start_sensitivity: str = ""
    # start-of-speech 確定に要する発話長 (ms)。0 以下はサーバ既定。
    turn_prefix_padding_ms: int = 0

    # --- Gemini Live セッションの安定化 ---
    # コンテキスト圧縮（sliding window）。無効だとコンテキスト上限到達でセッションが
    # 打ち切られ、長いインタビューの途中でエージェントが無反応になる。
    gemini_context_window_compression: bool = True
    gemini_context_trigger_tokens: int = 25600
    gemini_context_sliding_window_tokens: int = 12800
    # AgentSession が回復不能エラーで閉じたときの自動再起動（1 job あたりの上限と初期待ち）。
    voice_session_max_restarts: int = 3
    voice_session_restart_backoff_s: float = 2.0

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
