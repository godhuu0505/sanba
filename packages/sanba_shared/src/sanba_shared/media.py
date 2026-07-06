"""Gemini multimodal analysis for uploaded images and videos.

要件の素材（UIモック・スクショ・操作録画）から「観察」をテキストで抽出する。抽出文は
grounding（共有 Elasticsearch 索引）へ context として書き、agent が問いの根拠にできるようにする。

画像解析は以前 `apps/api/src/sanba_api/vision.py` にあったが、worker の動画解析（ADR-0040）と
同じ整形ロジック・同じ config 注入形にそろえるため domain 層へ移設した。creds 未設定なら
静かに空結果を返す（ローカル・テストで落とさない）。実 Gemini 呼び出しは creds/network 依存の
ため pragma で被覆対象外にし、整形ロジック（parse_observations）を単体テストする。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import structlog

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class MediaConfig:
    """Gemini マルチモーダル呼び出しの設定（アプリ settings 非依存）。"""

    vision_model: str = "gemini-2.5-flash"
    use_vertexai: bool = False
    google_api_key: str = ""


# 画像から要件のヒントになる観察を、短い箇条書きで引き出すための指示。
_IMAGE_PROMPT = (
    "この画像はソフトウェア要件定義の素材（UIモック・スクリーンショット・手書き・写真）です。"
    "要件の手掛かりになる観察を、日本語の短い箇条書きで最大8件、各1行で挙げてください。"
    "推測は避け、画像から読み取れる事実（画面要素・ラベル・状態・数値・矛盾の兆候）に限定します。"
    "箇条書き本文のみを返し、前置き・見出し・コードブロックは付けないでください。"
)

# 動画から要件のヒントを引き出す指示。各行にタイムスタンプ [MM:SS] を付け、映像と音声の
# 両方（画面操作・発話）から観察する。転写そのものではなく「要件に効く観察」に寄せる。
_VIDEO_PROMPT = (
    "この動画はソフトウェア要件定義の素材（画面操作の録画・デモ・バグ再現・モック説明）です。"
    "要件の手掛かりになる観察を、日本語の短い箇条書きで最大20件、各1行で挙げてください。"
    "各行の先頭に映像内のタイムスタンプを [MM:SS] 形式で付けます。"
    "映像（画面要素・遷移・操作）と音声（発話・意図）の両方を対象にし、"
    "画面名・UI要素・操作フロー・ドメイン用語・要件候補・矛盾の兆候に限定します。"
    "推測は避け、動画から読み取れる事実のみ。箇条書き本文のみを返し、"
    "前置き・見出し・コードブロックは付けないでください。"
)


@dataclass
class VideoAnalysis:
    """動画解析の結果。`chunks` を grounding へ投入し、`extracted` を素材メタに残す。"""

    observations: list[str] = field(default_factory=list)

    @property
    def extracted(self) -> int:
        return len(self.observations)


def parse_observations(text: str, *, limit: int = 8) -> list[str]:
    """モデル出力（箇条書き想定）を観察文の配列に整形する。

    `-`/`*`/`・`/番号などの行頭マーカを剥がし、空行を除いて最大 `limit` 件にする。
    タイムスタンプ `[MM:SS]` は観察の一部として残す（剥がさない）。
    """
    observations: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # 行頭の箇条書きマーカ・番号を剥がす。
        line = line.lstrip("-*・•").strip()
        while line[:1].isdigit():
            line = line[1:]
            if line[:1] in ".)、.":
                line = line[1:].strip()
                break
        line = line.strip()
        if line:
            observations.append(line)
        if len(observations) >= limit:
            break
    return observations


def _client(config: MediaConfig):  # type: ignore[no-untyped-def]
    from google import genai

    return genai.Client(api_key=config.google_api_key or None)


def analyze_image(raw: bytes, content_type: str, config: MediaConfig) -> list[str]:
    """画像から観察文の配列を返す。creds 未設定や失敗時は空配列。"""
    if not (config.google_api_key or config.use_vertexai):
        return []
    try:  # pragma: no cover - needs creds/network
        from google.genai import types

        resp = _client(config).models.generate_content(
            model=config.vision_model,
            contents=[
                types.Part.from_bytes(data=raw, mime_type=content_type),
                _IMAGE_PROMPT,
            ],
        )
        return parse_observations(resp.text or "")
    except Exception as exc:  # pragma: no cover
        log.warning("image_analysis_failed", error=str(exc))
        return []


def analyze_video(
    config: MediaConfig,
    *,
    gcs_uri: str | None = None,
    raw: bytes | None = None,
    content_type: str = "video/mp4",
) -> VideoAnalysis:
    """動画から観察（タイムスタンプ付き）を抽出する。creds 未設定や失敗時は空。

    Vertex AI 経路（本番）は `gcs_uri`（gs://…）を `Part.from_uri` で直接渡す（bytes を
    プロセスに載せない）。GenAI API 経路（ローカル）は `raw` を inline で渡す（Files API を
    使うほど大きい動画はローカルで想定しないため、20MB 目安を超えるものは呼び出し側で弾く）。
    """
    if not (config.google_api_key or config.use_vertexai):
        return VideoAnalysis()
    if gcs_uri is None and raw is None:
        raise ValueError("analyze_video requires gcs_uri or raw bytes")
    try:  # pragma: no cover - needs creds/network
        from google.genai import types

        if gcs_uri is not None:
            part = types.Part.from_uri(file_uri=gcs_uri, mime_type=content_type)
        else:
            assert raw is not None  # 上の分岐で保証（gcs_uri/raw いずれかは必須）
            part = types.Part.from_bytes(data=raw, mime_type=content_type)
        resp = _client(config).models.generate_content(
            model=config.vision_model,
            contents=[part, _VIDEO_PROMPT],
        )
        return VideoAnalysis(observations=parse_observations(resp.text or "", limit=20))
    except Exception as exc:  # pragma: no cover
        log.warning("video_analysis_failed", error=str(exc))
        return VideoAnalysis()
