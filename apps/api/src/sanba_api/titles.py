"""要件確定時の成果物/Issue タイトルを Vertex AI（Gemini）で生成する。

過去要件一覧の見出しと GitHub Issue の標題が共有する `SessionMeta.title` を、確定要件から
一言で表す標題に差し替えるための LLM 呼び出し。認証情報が無い / 生成に失敗した場合は None を
返し、呼び出し側（finalize）は既定タイトルを保つ（evaluation.py の LLM judge と同じ fail-open）。

プロンプト整形は `sanba_shared.result_document.build_title_prompt`（純粋関数）に一元化し、
ここは genai クライアント生成と後処理だけを担う。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import structlog
from sanba_shared.analytics import TokenUsage, usage_from_genai
from sanba_shared.result_document import build_summary_prompt, build_title_prompt

from .config import settings

log = structlog.get_logger(__name__)

_MAX_TITLE_CHARS = 60
_MAX_SUMMARY_CHARS = 1200

UsageHook = Callable[[TokenUsage], None]


def _report_usage(usage_hook: UsageHook | None, resp: object) -> None:
    if usage_hook is None:
        return
    try:
        usage_hook(usage_from_genai(getattr(resp, "usage_metadata", None)))
    except Exception as exc:  # noqa: BLE001
        log.warning("title_usage_hook_failed", error=str(exc))


def _labels_config(billing_labels: dict[str, str] | None):  # type: ignore[no-untyped-def]
    if not billing_labels:
        return None
    from google.genai import types

    return types.GenerateContentConfig(labels=billing_labels)


def _clean_title(text: str) -> str:
    """モデル出力を Issue 標題に使える 1 行へ整える。"""
    line = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    line = line.strip().strip("`\"'　 ")
    return line[:_MAX_TITLE_CHARS].strip()


def generate_requirement_title(
    requirements: list[dict[str, Any]],
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> str | None:
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
            config=_labels_config(billing_labels),
        )
        _report_usage(usage_hook, resp)
    except Exception as exc:  # pragma: no cover
        log.warning("title_generation_failed", error=str(exc))
        return None
    return _clean_title(resp.text or "") or None


def generate_conversation_summary(
    utterances: list[dict[str, Any]],
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> str | None:
    """会話ログから Issue 用の要約を生成する（P3・Q2 ハイブリッド）。生成不可なら None。

    確定時に 1 回だけ生成して保存し、起票時は保存値を使う（起票のたびに LLM を呼ばない）。
    認証情報なし / 発話なし / 失敗時は None を返し、呼び出し側は要約なしで続行する
    （fail-open。タイトル生成と同じ倒し方）。
    """
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return None
    if not any(str(u.get("text", "")).strip() for u in utterances):
        return None
    try:  # pragma: no cover - needs network/credentials
        from google import genai

        client = genai.Client(api_key=settings.google_api_key or None)
        resp = client.models.generate_content(
            model=settings.gemini_reasoning_model,
            contents=build_summary_prompt(utterances),
            config=_labels_config(billing_labels),
        )
        _report_usage(usage_hook, resp)
    except Exception as exc:  # pragma: no cover
        log.warning("summary_generation_failed", error=str(exc))
        return None
    text = (resp.text or "").strip()
    return text[:_MAX_SUMMARY_CHARS] or None
