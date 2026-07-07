"""要件確定時の成果物/Issue タイトルを Vertex AI（Gemini）で生成する。

過去要件一覧の見出しと GitHub Issue の標題が共有する `SessionMeta.title` を、確定要件から
一言で表す標題に差し替えるための LLM 呼び出し。認証情報が無い / 生成に失敗した場合は None を
返し、呼び出し側（finalize）は既定タイトルを保つ（evaluation.py の LLM judge と同じ fail-open）。

プロンプト整形は `sanba_shared.result_document.build_title_prompt`（純粋関数）に一元化し、
ここは genai クライアント生成と後処理だけを担う。
"""

from __future__ import annotations

from typing import Any

import structlog
from sanba_shared.result_document import build_title_prompt

from .config import settings

log = structlog.get_logger(__name__)

# 生成タイトルの安全上限。プロンプトでは 30 文字を指示するが、モデルが超過しても
# Issue 標題として破綻しない長さで切る（説明文を返してきた場合の保険）。
_MAX_TITLE_CHARS = 60


def _clean_title(text: str) -> str:
    """モデル出力を Issue 標題に使える 1 行へ整える。"""
    line = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    line = line.strip().strip("`\"'　 ")
    return line[:_MAX_TITLE_CHARS].strip()


def generate_requirement_title(requirements: list[dict[str, Any]]) -> str | None:
    """確定要件から成果物/Issue タイトルを生成する。生成不可なら None。"""
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return None
    confirmed = [r for r in requirements if r.get("status") == "confirmed" and r.get("statement")]
    if not confirmed:
        return None
    try:  # pragma: no cover - needs network/credentials
        from google import genai

        client = genai.Client(api_key=settings.google_api_key or None)
        resp = client.models.generate_content(
            model=settings.gemini_reasoning_model,
            contents=build_title_prompt(requirements),
        )
    except Exception as exc:  # pragma: no cover
        log.warning("title_generation_failed", error=str(exc))
        return None
    return _clean_title(resp.text or "") or None
