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
    # 音声認識/合成の言語固定。BCP-47 コード。入力文字起こしのヒント
    # （AudioTranscriptionConfig.language_codes）と出力音声の language_code に使う。
    # 未設定（""）でモデルの自動言語判定に委ねる（従来挙動）。日本語セッションで
    # 韓国語/中国語へ誤認識ドリフトするのを抑える主レバー。
    gemini_language: str = "ja-JP"

    # LiveKit
    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"

    # --- 音声ターン検出（Gemini Live 自動 VAD）の感度 ---
    # 参加者が話し終えたと判定するまでに要求する無音時間 (ms)。大きいほど発話途中の間で
    # エージェントが被せて話し始めにくくなる代わりに、応答開始は遅くなる。
    # 「考えながら長めに沈黙する」要件インタビューで発話が途中確定して吹き出しが
    # 分断されるのを抑えるため 800 から 1200 に延長。
    turn_silence_duration_ms: int = 1200
    # 発話終端検出の感度。"low" = 終わったと判定されにくい（待ちが長い）/ "high" /
    # "" = サーバ既定。話し途中の割り込み対策の主レバー。
    turn_end_sensitivity: str = "low"
    # 発話開始検出の感度。"low" にすると相槌・環境音でエージェントの発話が中断されにくく
    # なるが、短い返事を取りこぼすリスクがある。既定はサーバ既定（""）。
    turn_start_sensitivity: str = ""
    # start-of-speech 確定に要する発話長 (ms)。0 以下はサーバ既定。
    # 一瞬の環境音・相槌の漏れ込みで発話が誤って区切られる（短い相槌で切られる）のを
    # 抑えるため 100ms の連続発話を start 確定の条件にする。BVC と併せて誤検出を減らす。
    turn_prefix_padding_ms: int = 100

    # --- Gemini Live セッションの安定化 ---
    # コンテキスト圧縮（sliding window）。無効だとコンテキスト上限到達でセッションが
    # 打ち切られ、長いインタビューの途中でエージェントが無反応になる。
    gemini_context_window_compression: bool = True
    gemini_context_trigger_tokens: int = 25600
    gemini_context_sliding_window_tokens: int = 12800
    # AgentSession が回復不能エラーで閉じたときの自動再起動（1 job あたりの上限と初期待ち）。
    voice_session_max_restarts: int = 3
    voice_session_restart_backoff_s: float = 2.0

    # --- 要件分析（ADK 多段チェーン）のタイムアウト（ADR-0046 段階1）---
    # 背景分析 1 回の LLM 往復の上限。健全時は概ね 10 秒未満で完了する。超過は fail-soft で
    # 破棄し、次の発話が再評価する。音声ターン自体は下の ride-along 上限が守るため、分析が
    # 完了しきれるだけの余裕を残しつつ 30→20 秒へ短縮する。
    analysis_timeout_seconds: float = 20.0
    # analyze_requirements（ツール）が走行中の背景分析へ相乗りして待つ上限。これを超えたら
    # 音声ターンをそれ以上塞がず、直近結果（無ければヒューリスティック）を即返す。背景は走り
    # 切り、結果は次ターンに反映される。音声ターンのレイテンシ保護の主レバー（ADR-0046 段階1）。
    analysis_ride_along_timeout_seconds: float = 8.0

    # --- 入力ノイズ抑制 ---
    # LiveKit Cloud の Krisp Background Voice Cancellation（BVC）をエージェント側の音声入力に
    # 適用する。雑音・PC 内蔵マイク・別話者の被り由来の誤認識/言語ドリフトを抑える。
    # プラグイン（livekit-plugins-noise-cancellation）未導入や self-host では自動で無効化して
    # 会話は継続する（フェイルソフト）。BVC は LiveKit Cloud でのみ有効。
    noise_cancellation_enabled: bool = True

    # Firestore
    firestore_emulator_host: str = ""

    # Elasticsearch (RAG grounding + past-session search)
    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    gemini_embed_model: str = "gemini-embedding-001"

    # Data governance
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

    # External connectors. OFF by default — never affects the demo path.
    github_connector_enabled: bool = False
    github_token: str = ""
    github_repo: str = ""  # "owner/name"


settings = Settings()
