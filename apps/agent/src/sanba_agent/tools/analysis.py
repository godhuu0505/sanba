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


_AMBIGUITY_MARKERS = (
    "いい感じ",
    "良い感じ",
    "よしなに",
    "適当",
    "なるべく",
    "いろいろ",
    "色々",
    "みたいな",
    "ある程度",
    "それなり",
    "ちゃんと",
    "うまく",
    "うまいこと",
    "普通に",
    "ふつうに",
    "そこそこ",
    "とりあえず",
)


def heuristic_ambiguous_topics(transcript: str) -> list[str]:
    """曖昧な言い回しを含む発話を不明瞭な論点として抽出する（gap/矛盾ではない第三類）。

    ADK が無い環境でも最低限の不明瞭検知を保証するための、依存ゼロの pre-filter。
    LLM による精度向上（誤検出抑制・論点の言語化）は CI の回帰評価データセットに委ねる
    （gap 検知が heuristic_open_topics を持つのと同じ構成）。
    """
    found: list[str] = []
    seen: set[str] = set()
    for raw in transcript.splitlines():
        line = raw.strip()
        if not line:
            continue
        body = line.split(":", 1)[1].strip() if ":" in line else line
        if not any(marker in body for marker in _AMBIGUITY_MARKERS):
            continue
        snippet = body if len(body) <= 40 else body[:40] + "…"
        if snippet in seen:
            continue
        seen.add(snippet)
        found.append(snippet)
    return found


async def analyze_transcript(transcript: str) -> AnalysisResult:
    """Run the ADK interview team over the transcript and return next steps.

    Falls back to a heuristic result if the ADK runtime is not available
    (keeps local/dev and unit tests working without credentials).
    """
    open_topics = heuristic_open_topics(transcript)
    ambiguous_topics = heuristic_ambiguous_topics(transcript)
    try:
        return await _run_adk(transcript, open_topics, ambiguous_topics)
    except Exception:
        return heuristic_result(transcript)


def heuristic_result(transcript: str) -> AnalysisResult:
    """ADK 無し/タイムアウト時のヒューリスティック分析結果（LLM 往復なし・即時）。

    抜け（heuristic_open_topics）と曖昧語（heuristic_ambiguous_topics）から最低限の
    「次の一問」を組み立てる。ローカル/dev、認証なしのユニットテスト、および分析が上限内に
    完了しないとき（ADR-0046 段階1 の ride-along タイムアウト）のフォールバックで使う。
    """
    open_topics = heuristic_open_topics(transcript)
    ambiguous_topics = heuristic_ambiguous_topics(transcript)
    first_gap = open_topics[0] if open_topics else "他に考慮すべき制約はありますか"
    return AnalysisResult(
        summary=_naive_summary(transcript),
        open_topics=open_topics,
        ambiguous_topics=ambiguous_topics,
        next_question=f"{first_gap}について教えてください。",
        suggested_answer="（例）まだ決めていません。一般的な水準で構いません。",
    )


def _naive_summary(transcript: str) -> str:
    sentences = re.split(r"[。\n]", transcript)
    kept = [s.strip() for s in sentences if s.strip()][-3:]
    return " / ".join(kept) if kept else "まだ要件は確定していません。"


async def _run_adk(
    transcript: str, open_topics: list[str], ambiguous_topics: list[str]
) -> AnalysisResult:
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
        ambiguous_topics=ambiguous_topics,
        next_question=next_q,
        suggested_answer="（例）一般的な水準で構いません。",
    )


def _extract_question(text: str) -> str:
    for line in text.splitlines():
        if "？" in line or "?" in line:
            return line.strip("-・ 　")
    return "他に重要な要件や制約はありますか？"
