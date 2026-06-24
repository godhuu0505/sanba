"""Gemini multimodal analysis for uploaded images (issue #103 / ADR-0004).

画像（モック・スクショ・写真）から「ビジュアルの観察」をテキストで抽出する。抽出文は
grounding（共有 Elasticsearch 索引）へ context として書き、agent が問いの根拠にできるようにする。
言葉×画の矛盾検知（08 / `analysis.visual`）の素地でもある。

creds 未設定なら静かに空配列を返す（ローカル・テストで落とさない）。実際の Gemini 呼び出しは
ネットワーク/creds 依存のため pragma で被覆対象外にし、整形ロジックは単体テストする。
"""

from __future__ import annotations

import structlog

from .config import settings

log = structlog.get_logger(__name__)

# 画像から要件のヒントになる観察を、短い箇条書きで引き出すための指示。
_PROMPT = (
    "この画像はソフトウェア要件定義の素材（UIモック・スクリーンショット・手書き・写真）です。"
    "要件の手掛かりになる観察を、日本語の短い箇条書きで最大8件、各1行で挙げてください。"
    "推測は避け、画像から読み取れる事実（画面要素・ラベル・状態・数値・矛盾の兆候）に限定します。"
    "箇条書き本文のみを返し、前置き・見出し・コードブロックは付けないでください。"
)


def parse_observations(text: str, *, limit: int = 8) -> list[str]:
    """モデル出力（箇条書き想定）を観察文の配列に整形する。

    `-`/`*`/`・`/番号などの行頭マーカを剥がし、空行を除いて最大 `limit` 件にする。
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


def analyze_image(raw: bytes, content_type: str) -> list[str]:
    """画像から観察文の配列を返す。creds 未設定や失敗時は空配列。"""
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return []
    try:  # pragma: no cover - needs creds/network
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=settings.google_api_key or None)
        resp = client.models.generate_content(
            model=settings.gemini_vision_model,
            contents=[
                types.Part.from_bytes(data=raw, mime_type=content_type),
                _PROMPT,
            ],
        )
        return parse_observations(resp.text or "")
    except Exception as exc:  # pragma: no cover
        log.warning("image_analysis_failed", error=str(exc))
        return []
