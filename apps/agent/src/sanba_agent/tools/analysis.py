"""Pure, unit-testable logic behind the voice agent's tools.

Kept free of LiveKit/ADK runtime objects so it can be tested without a live session.
"""

from __future__ import annotations

import hashlib
import re

from sanba_shared.models import AnalysisResult


def make_requirement_id(statement: str) -> str:
    """Deterministic short id for a requirement statement (idempotent upserts)."""
    digest = hashlib.sha1(statement.strip().lower().encode()).hexdigest()
    return f"req_{digest[:10]}"


def heuristic_open_topics(transcript: str) -> list[str]:
    """Cheap, dependency-free gap detection used as a fallback / pre-filter.

    The real analysis runs through the ADK team; this guarantees we always
    surface the standard non-functional blind spots even offline.
    """
    text = transcript.lower()
    checks = {
        "性能・レイテンシの要件": ["レイテンシ", "性能", "速", "latency", "performance"],
        "可用性・SLO": ["可用性", "slo", "稼働", "ダウンタイム"],
        "セキュリティ・プライバシー": ["セキュリティ", "個人情報", "pii", "認証", "権限"],
        "コスト・予算": ["コスト", "予算", "料金", "費用"],
        "対象ユーザー・規模": ["ユーザー", "規模", "同時", "人数"],
    }
    missing: list[str] = []
    for topic, keywords in checks.items():
        if not any(kw in text for kw in keywords):
            missing.append(topic)
    return missing


async def analyze_transcript(transcript: str) -> AnalysisResult:
    """Run the ADK interview team over the transcript and return next steps.

    Falls back to a heuristic result if the ADK runtime is not available
    (keeps local/dev and unit tests working without credentials).
    """
    open_topics = heuristic_open_topics(transcript)
    try:
        return await _run_adk(transcript, open_topics)
    except Exception:
        first_gap = open_topics[0] if open_topics else "他に考慮すべき制約はありますか"
        return AnalysisResult(
            summary=_naive_summary(transcript),
            open_topics=open_topics,
            next_question=f"{first_gap}について教えてください。",
            suggested_answer="（例）まだ決めていません。一般的な水準で構いません。",
        )


def _naive_summary(transcript: str) -> str:
    sentences = re.split(r"[。\n]", transcript)
    kept = [s.strip() for s in sentences if s.strip()][-3:]
    return " / ".join(kept) if kept else "まだ要件は確定していません。"


async def _run_adk(transcript: str, open_topics: list[str]) -> AnalysisResult:
    """Invoke the ADK agent team. Imported lazily to avoid hard runtime deps in tests."""
    from google.adk.runners import InMemoryRunner
    from google.genai import types

    from ..agent_team import build_interview_team

    team = build_interview_team()
    runner = InMemoryRunner(agent=team, app_name="sanba")
    session = await runner.session_service.create_session(app_name="sanba", user_id="voice-agent")
    prompt = (
        "以下はこれまでの要件インタビューの書き起こしです。\n"
        f"---\n{transcript}\n---\n"
        f"未確認の論点候補: {', '.join(open_topics) or 'なし'}\n"
        "確定要件の要約・抜け漏れ・次に聞くべき1問とその推奨回答例を返してください。"
    )
    content = types.Content(role="user", parts=[types.Part(text=prompt)])
    final_text = ""
    async for event in runner.run_async(
        user_id="voice-agent", session_id=session.id, new_message=content
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final_text = event.content.parts[0].text or ""

    next_q = _extract_question(final_text)
    return AnalysisResult(
        summary=final_text or _naive_summary(transcript),
        open_topics=open_topics,
        next_question=next_q,
        suggested_answer="（例）一般的な水準で構いません。",
    )


def _extract_question(text: str) -> str:
    for line in text.splitlines():
        if "？" in line or "?" in line:
            return line.strip("-・ 　")
    return "他に重要な要件や制約はありますか？"
