"""LLMOps: LLM-as-a-judge online evaluation + offline regression.

「まわす」軸の実装 — AI を継続的に改善するサイクル。
- online: セッション終了時にインタビュー品質を採点し Langfuse に記録する。
- offline: 代表シナリオのデータセットを CI で回帰評価し、品質劣化を検出する。
  (`python -m kikitori_agent.evaluation` を llm-eval ワークフローが実行)

Gemini が使えない環境ではヒューリスティック採点にフォールバックするので、
鍵が無くてもパイプラインは動く(品質の絶対値ではなく回帰検出が目的)。
"""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass

import structlog

from .config import settings
from .observability import get_langfuse
from .tools.analysis import heuristic_open_topics

log = structlog.get_logger(__name__)

# 採点ルーブリック。各観点 0.0〜1.0。
RUBRIC = [
    ("nfr_coverage", "非機能要件(性能/可用性/セキュリティ/コスト/規模)を十分に確認したか"),
    ("question_specificity", "曖昧さを残さず、具体的で測定可能な問いを立てたか"),
    ("contradiction_handling", "矛盾や抜けを検知して掘り下げたか"),
]

# CI で許容する最低スコア(平均)。これを下回ると回帰とみなし fail。
QUALITY_THRESHOLD = 0.5


@dataclass
class JudgeResult:
    scores: dict[str, float]
    overall: float
    rationale: str

    @classmethod
    def from_scores(cls, scores: dict[str, float], rationale: str) -> JudgeResult:
        overall = sum(scores.values()) / len(scores) if scores else 0.0
        return cls(scores=scores, overall=round(overall, 3), rationale=rationale)


def _heuristic_scores(transcript: str) -> JudgeResult:
    """Dependency-free scoring used as a fallback and as a deterministic test anchor."""
    total_nfr = 5
    covered = total_nfr - len(heuristic_open_topics(transcript))
    nfr = covered / total_nfr
    specificity = min(1.0, (transcript.count("？") + transcript.count("?")) / 5)
    contradiction = 1.0 if ("矛盾" in transcript or "確認" in transcript) else 0.4
    return JudgeResult.from_scores(
        {
            "nfr_coverage": round(nfr, 3),
            "question_specificity": round(specificity, 3),
            "contradiction_handling": contradiction,
        },
        rationale="heuristic fallback (no LLM judge available)",
    )


async def judge_interview(transcript: str) -> JudgeResult:
    """Score an interview transcript with an LLM judge, falling back to heuristics."""
    if not transcript.strip():
        return JudgeResult.from_scores(dict.fromkeys((k for k, _ in RUBRIC), 0.0), "empty")
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return _heuristic_scores(transcript)
    try:  # pragma: no cover - needs network/credentials
        return await _llm_judge(transcript)
    except Exception as exc:  # pragma: no cover
        log.warning("llm_judge_failed_falling_back", error=str(exc))
        return _heuristic_scores(transcript)


async def _llm_judge(transcript: str) -> JudgeResult:  # pragma: no cover - needs creds
    from google import genai

    criteria = "\n".join(f"- {k}: {desc}" for k, desc in RUBRIC)
    prompt = (
        "あなたは要件定義インタビューの審査員です。以下の書き起こしを、各観点 0.0〜1.0 で採点し、"
        "JSON のみを返してください。\n"
        f"観点:\n{criteria}\n"
        'フォーマット: {"scores": {"nfr_coverage": 0.0, "question_specificity": 0.0, '
        '"contradiction_handling": 0.0}, "rationale": "..."}\n'
        f"---\n{transcript}\n---"
    )
    client = genai.Client(api_key=settings.google_api_key or None)
    resp = await client.aio.models.generate_content(
        model=settings.gemini_reasoning_model, contents=prompt
    )
    text = (resp.text or "").strip().removeprefix("```json").removesuffix("```").strip()
    data = json.loads(text)
    return JudgeResult.from_scores(
        {k: float(data["scores"].get(k, 0.0)) for k, _ in RUBRIC},
        data.get("rationale", ""),
    )


async def score_session(session_id: str, transcript: str) -> JudgeResult:
    """Online evaluation: score a finished session and log it to Langfuse."""
    result = await judge_interview(transcript)
    log.info("session_scored", session=session_id, overall=result.overall, scores=result.scores)
    lf = get_langfuse()
    if lf is not None:  # pragma: no cover - needs Langfuse
        for name, value in result.scores.items():
            lf.score(trace_id=session_id, name=name, value=value)
        lf.score(trace_id=session_id, name="overall", value=result.overall)
    return result


# ---- Offline regression dataset (CI) ---------------------------------------
DEFAULT_SCENARIOS: list[dict] = [
    {
        "name": "well_covered",
        "transcript": (
            "参加者: 社内の議事録を要約したい。\n"
            "Kikitori: 想定する同時利用者数は？\n参加者: 50人です。\n"
            "Kikitori: レイテンシ要件は？\n参加者: 5秒以内。\n"
            "Kikitori: 個人情報の扱いとセキュリティは？\n参加者: 認証必須、社内のみ。\n"
            "Kikitori: 予算規模は？\n参加者: 月10万円。\n"
            "Kikitori: 矛盾がないか確認します。"
        ),
    },
    {
        "name": "shallow",
        "transcript": "参加者: 要約機能がほしい。\nKikitori: わかりました、作ります。",
    },
]


async def run_dataset_eval() -> int:
    """Run the regression dataset and return a process exit code (0 = pass)."""
    results = []
    for sc in DEFAULT_SCENARIOS:
        res = await judge_interview(sc["transcript"])
        results.append((sc["name"], res))
        print(f"[{sc['name']:>14}] overall={res.overall:.2f} scores={res.scores}")

    mean = sum(r.overall for _, r in results) / len(results)
    # The shallow scenario *should* score lower than the well-covered one.
    by_name = {n: r.overall for n, r in results}
    ordering_ok = by_name.get("well_covered", 0) >= by_name.get("shallow", 1)
    print(f"mean_overall={mean:.3f} threshold={QUALITY_THRESHOLD} ordering_ok={ordering_ok}")

    if not ordering_ok:
        print("REGRESSION: well-covered interview did not outscore shallow", file=sys.stderr)
        return 1
    if by_name.get("well_covered", 0) < QUALITY_THRESHOLD:
        print("REGRESSION: best scenario below quality threshold", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    code = asyncio.run(run_dataset_eval())
    sys.exit(code)


if __name__ == "__main__":
    main()


__all__ = ["JudgeResult", "judge_interview", "score_session", "run_dataset_eval"]
