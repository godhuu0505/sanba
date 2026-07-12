"""Pure, unit-testable logic behind the voice agent's tools.

Kept free of LiveKit/ADK runtime objects so it can be tested without a live session.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import unicodedata
from collections.abc import Callable, Sequence

import structlog
from sanba_shared.analytics import (
    COMPONENT_ADK_TEAM,
    COMPONENT_ANALYSIS,
    TokenUsage,
    usage_from_genai,
)
from sanba_shared.models import AnalysisResult

from ..config import settings

log = structlog.get_logger(__name__)

UsageHook = Callable[[str, TokenUsage], None]


def make_requirement_id(statement: str) -> str:
    """Deterministic short id for a requirement statement (idempotent upserts)."""
    digest = hashlib.sha1(statement.strip().lower().encode()).hexdigest()
    return f"req_{digest[:10]}"


_JP_CHAR = r"[぀-ヿ㐀-鿿々〆ヶ]"
_JP_GAP = re.compile(rf"({_JP_CHAR})[ 　]+({_JP_CHAR})")


def normalize_query(text: str) -> str:
    """認識テキストを grounding クエリ向けに保守的に正規化する（#435 / ADR-0039 追補）。

    STT（S2S）は日本語を分かち書き（語間に空白）＋全角/半角ゆらぎで返しがちで、これがそのまま
    検索/分析クエリに載ると一致率が落ちる。ここでは意味を壊さない範囲でのみ整える:
    NFKC で全角/半角のゆらぎを畳み、連続空白を 1 つに縮め、**日本語文字どうしに挟まれた空白**
    （分かち書き由来）だけを除去する（英単語間の空白は保持）。過補正しないため誤変換辞書等は持たない。
    """
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    while True:
        collapsed = _JP_GAP.sub(r"\1\2", normalized)
        if collapsed == normalized:
            return collapsed
        normalized = collapsed


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
    LLM による精度向上（誤検出抑制・論点の言語化）は CI の回帰評価データセットに委ねる。
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


def _report_usage(usage_hook: UsageHook | None, component: str, usage: TokenUsage) -> None:
    if usage_hook is None or usage.is_empty:
        return
    try:
        usage_hook(component, usage)
    except Exception as exc:  # noqa: BLE001
        log.warning("analysis_usage_hook_failed", component=component, error=str(exc))


def _labels_config(billing_labels: dict[str, str] | None):  # type: ignore[no-untyped-def]
    if not billing_labels:
        return None
    from google.genai import types

    return types.GenerateContentConfig(labels=billing_labels)


async def analyze_transcript(
    transcript: str,
    check_points: Sequence[str] = (),
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
    coverage_transcript: str | None = None,
) -> AnalysisResult:
    """Run the ADK interview team over the transcript and return next steps.

    Falls back to a heuristic result if the ADK runtime is not available
    (keeps local/dev and unit tests working without credentials).

    `check_points`（このセッションで確認する観点 / ADR-0057）が与えられたら、会話でまだ
    触れられていないものを LLM で判定し `coverage_open` に載せる。gap/曖昧語とは別の advisory
    シグナルで、ADK 本体と並行に走らせて遅延を足さない。

    `coverage_transcript` が与えられたらカバレッジ判定にだけそれを使う（RC4。SANBA の問いを
    含む対話 log を渡すと Q&A の対で「触れたか」の判定精度が上がる）。None なら要件分析と同じ
    `transcript` を使う。

    `usage_hook(component, usage)` には ADK チーム・観点カバレッジ LLM のトークン usage を
    渡す（ADR-0061 の `ai_usage` 排出用）。hook の失敗は分析本体へ波及させない。
    `billing_labels` は Vertex 経路の直接 `generate_content`（カバレッジ判定）にだけ付与する
    （ADK チームは共有キャッシュのためリクエスト毎ラベルを付けない既知の制約）。
    """
    ambiguous_topics = heuristic_ambiguous_topics(transcript)
    coverage_task = (
        asyncio.ensure_future(
            assess_check_point_coverage(
                coverage_transcript if coverage_transcript is not None else transcript,
                check_points,
                usage_hook=usage_hook,
                billing_labels=billing_labels,
            )
        )
        if check_points
        else None
    )
    try:
        result = await _run_adk(transcript, ambiguous_topics, usage_hook=usage_hook)
    except Exception:
        result = heuristic_result(transcript)
    coverage_open = await coverage_task if coverage_task is not None else []
    return result.model_copy(update={"coverage_open": coverage_open})


async def assess_check_point_coverage(
    transcript: str,
    check_points: Sequence[str],
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> list[str]:
    """与えた観点のうち、会話でまだ触れられていないものを LLM で返す（ADR-0057）。

    キーワード一致だと ADR-0055 で廃したハードコード論点の誤検知が再来するため LLM で判定する。
    返すのは与えた観点の部分集合のみ（未知の文言は surface しない安全側）。creds 無し・失敗・空
    入力では空を返す（advisory なので「未カバー無し」に倒す）。
    """
    points = [p.strip() for p in check_points if p.strip()]
    if not points or not transcript.strip():
        return []
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return []
    try:
        return await _llm_check_point_coverage(
            transcript, points, usage_hook=usage_hook, billing_labels=billing_labels
        )
    except Exception:
        return []


async def _llm_check_point_coverage(
    transcript: str,
    points: list[str],
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> list[str]:  # pragma: no cover - needs creds
    from google import genai

    listed = "\n".join(f"- {p}" for p in points)
    prompt = (
        "あなたは要件インタビューの進行を助ける観測者です。以下の書き起こしを読み、"
        "リストの各観点が会話で『十分に触れられたか』を判定してください。"
        "まだ触れられていない観点だけを JSON 配列で返します（触れられたものは含めない）。"
        "観点はリストの文言そのままを使い、リストに無い文言は返さないでください。\n"
        f"観点リスト:\n{listed}\n"
        'フォーマット: {"uncovered": ["観点1", "観点2"]}\n'
        f"---\n{transcript}\n---"
    )
    client = genai.Client(api_key=settings.google_api_key or None)
    resp = await client.aio.models.generate_content(
        model=settings.gemini_reasoning_model,
        contents=prompt,
        config=_labels_config(billing_labels),
    )
    _report_usage(
        usage_hook, COMPONENT_ANALYSIS, usage_from_genai(getattr(resp, "usage_metadata", None))
    )
    text = (resp.text or "").strip().removeprefix("```json").removesuffix("```").strip()
    data = json.loads(text)
    returned = {str(r) for r in data.get("uncovered", [])} if isinstance(data, dict) else set()
    return [p for p in points if p in returned]


def heuristic_result(transcript: str) -> AnalysisResult:
    """ADK 無し/タイムアウト時のヒューリスティック分析結果（LLM 往復なし・即時）。

    曖昧語（heuristic_ambiguous_topics）から最低限の「次の一問」を組み立てる。ローカル/dev、
    認証なしのユニットテスト、および分析が上限内に完了しないとき（ADR-0046 段階1 の ride-along
    タイムアウト）のフォールバックで使う。gap（open_topics）はハードコード NFR 廃止で空
    （ADR-0055。カバーすべき観点は check-points で instruction 側にシードする）。
    """
    ambiguous_topics = heuristic_ambiguous_topics(transcript)
    return AnalysisResult(
        summary=_naive_summary(transcript),
        open_topics=[],
        ambiguous_topics=ambiguous_topics,
        next_question="他に考慮すべき制約や要件はありますか？",
        suggested_answer="（例）まだ決めていません。一般的な水準で構いません。",
    )


def _naive_summary(transcript: str) -> str:
    sentences = re.split(r"[。\n]", transcript)
    kept = [s.strip() for s in sentences if s.strip()][-3:]
    return " / ".join(kept) if kept else "まだ要件は確定していません。"


async def _run_adk(
    transcript: str,
    ambiguous_topics: list[str],
    *,
    usage_hook: UsageHook | None = None,
) -> AnalysisResult:
    """Invoke the ADK agent team. Imported lazily to avoid hard runtime deps in tests.

    ADK イベントが運ぶ `usage_metadata`（サブエージェント LLM ターン毎）を合算し、
    `usage_hook` へ 1 回で渡す（ADR-0061 の adk_team コスト集計）。
    """
    from google.adk.runners import InMemoryRunner
    from google.genai import types

    from ..agent_team import build_interview_team

    team = build_interview_team()
    runner = InMemoryRunner(agent=team, app_name="sanba")
    session = await runner.session_service.create_session(app_name="sanba", user_id="voice-agent")
    prompt = (
        "以下はこれまでの要件インタビューの書き起こしです。\n"
        f"---\n{transcript}\n---\n"
        "確定要件の要約・抜け漏れ・次に聞くべき1問とその推奨回答例を返してください。"
    )
    content = types.Content(role="user", parts=[types.Part(text=prompt)])
    final_text = ""
    adk_usage = TokenUsage()
    async for event in runner.run_async(
        user_id="voice-agent", session_id=session.id, new_message=content
    ):
        adk_usage = adk_usage.add(usage_from_genai(getattr(event, "usage_metadata", None)))
        if event.is_final_response() and event.content and event.content.parts:
            final_text = event.content.parts[0].text or ""
    _report_usage(usage_hook, COMPONENT_ADK_TEAM, adk_usage)

    next_q = _extract_question(final_text)
    return AnalysisResult(
        summary=final_text or _naive_summary(transcript),
        open_topics=[],
        ambiguous_topics=ambiguous_topics,
        next_question=next_q,
        suggested_answer="（例）一般的な水準で構いません。",
    )


def _extract_question(text: str) -> str:
    for line in text.splitlines():
        if "？" in line or "?" in line:
            return line.strip("-・ 　")
    return "他に重要な要件や制約はありますか？"
