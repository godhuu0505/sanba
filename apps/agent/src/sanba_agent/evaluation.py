"""LLMOps: LLM-as-a-judge online evaluation + offline regression.

「まわす」軸の実装 — AI を継続的に改善するサイクル。
- online: セッション終了時にインタビュー品質を採点し Langfuse に記録する。
- offline: 代表シナリオのデータセットを CI で回帰評価し、品質劣化を検出する。
  (`python -m sanba_agent.evaluation` を llm-eval ワークフローが実行)

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

# ---- end_user モード ------------------------------
# 利用者インタビューの品質観点。developer の RUBRIC と独立に採点する。
END_USER_RUBRIC = [
    ("no_jargon", "技術用語(API/DB/非機能/MoSCoW 等)を利用者への発話に出していないか"),
    ("single_question", "1ターンに問いを1つに保ち、畳みかけていないか"),
    ("glossary_usage", "アプリの画面語彙(glossary)で話しているか"),
]

# SANBA の発話に出てはいけない開発語彙（heuristic 用の代表集合。網羅ではなく回帰検出用）。
_JARGON_TERMS = (
    "MoSCoW",
    "非機能",
    "API",
    "アーキテクチャ",
    "レイテンシ",
    "スループット",
    "データベース",
    "デプロイ",
    "SLO",
    "要件定義",
)

# end_user モードの CI 最低スコア。glossary 使用まで含めた総合で判定する。
END_USER_QUALITY_THRESHOLD = 0.6


def _agent_lines(transcript: str) -> list[str]:
    """書き起こしから SANBA(agent) の発話行だけを取り出す（採点対象は agent 側のみ）。"""
    return [line for line in transcript.splitlines() if line.strip().startswith("SANBA:")]


def _heuristic_end_user_scores(transcript: str, glossary: list[str]) -> JudgeResult:
    """end_user モードの決定的採点（LLM 不要のフォールバック兼テストアンカー）。"""
    lines = _agent_lines(transcript)
    if not lines:
        return JudgeResult.from_scores(
            dict.fromkeys((k for k, _ in END_USER_RUBRIC), 0.0), "no agent lines"
        )
    agent_text = "\n".join(lines)

    jargon_hits = sum(agent_text.count(term) for term in _JARGON_TERMS)
    no_jargon = max(0.0, 1.0 - 0.25 * jargon_hits)

    single = sum(1 for line in lines if (line.count("？") + line.count("?")) <= 1)
    single_question = single / len(lines)

    terms = [t for t in glossary if t.strip()]
    if terms:
        used = sum(1 for t in terms if t in agent_text)
        glossary_usage = used / len(terms)
    else:
        glossary_usage = 1.0  # 語彙未登録の product は不問（減点しない）

    return JudgeResult.from_scores(
        {
            "no_jargon": round(no_jargon, 3),
            "single_question": round(single_question, 3),
            "glossary_usage": round(glossary_usage, 3),
        },
        rationale="heuristic fallback (no LLM judge available)",
    )


async def judge_end_user_interview(transcript: str, glossary: list[str]) -> JudgeResult:
    """Score an end_user-mode transcript, falling back to deterministic heuristics."""
    if not transcript.strip():
        return JudgeResult.from_scores(dict.fromkeys((k for k, _ in END_USER_RUBRIC), 0.0), "empty")
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return _heuristic_end_user_scores(transcript, glossary)
    try:  # pragma: no cover - needs network/credentials
        return await _llm_judge_end_user(transcript, glossary)
    except Exception as exc:  # pragma: no cover
        log.warning("llm_judge_failed_falling_back", error=str(exc))
        return _heuristic_end_user_scores(transcript, glossary)


async def _llm_judge_end_user(
    transcript: str, glossary: list[str]
) -> JudgeResult:  # pragma: no cover - needs creds
    from google import genai

    criteria = "\n".join(f"- {k}: {desc}" for k, desc in END_USER_RUBRIC)
    glossary_note = "、".join(glossary) if glossary else "(未登録)"
    prompt = (
        "あなたはアプリ利用者インタビューの審査員です。以下は開発者ではない利用者への"
        "聞き取りの書き起こしです。SANBA(聞き手)の発話を各観点 0.0〜1.0 で採点し、"
        "JSON のみを返してください。\n"
        f"このアプリの画面語彙(glossary): {glossary_note}\n"
        f"観点:\n{criteria}\n"
        'フォーマット: {"scores": {"no_jargon": 0.0, "single_question": 0.0, '
        '"glossary_usage": 0.0}, "rationale": "..."}\n'
        f"---\n{transcript}\n---"
    )
    client = genai.Client(api_key=settings.google_api_key or None)
    resp = await client.aio.models.generate_content(
        model=settings.gemini_reasoning_model, contents=prompt
    )
    text = (resp.text or "").strip().removeprefix("```json").removesuffix("```").strip()
    data = json.loads(text)
    return JudgeResult.from_scores(
        {k: float(data["scores"].get(k, 0.0)) for k, _ in END_USER_RUBRIC},
        data.get("rationale", ""),
    )


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
            "SANBA: 想定する同時利用者数は？\n参加者: 50人です。\n"
            "SANBA: レイテンシ要件は？\n参加者: 5秒以内。\n"
            "SANBA: 個人情報の扱いとセキュリティは？\n参加者: 認証必須、社内のみ。\n"
            "SANBA: 予算規模は？\n参加者: 月10万円。\n"
            "SANBA: 矛盾がないか確認します。"
        ),
    },
    {
        "name": "shallow",
        "transcript": "参加者: 要約機能がほしい。\nSANBA: わかりました、作ります。",
    },
]


# end_user モードの回帰データセット。
# 良例: 技術用語なし・一問一答・glossary の語彙で「いつ・どの画面で・何をしようとして・
# 何に困ったか」を具体化する。悪例: 開発語彙で畳みかける（developer ペルソナの漏出）。
END_USER_GLOSSARY = ["請求書一覧", "明細画面", "送信ボタン"]

END_USER_SCENARIOS: list[dict] = [
    {
        "name": "eu_grounded",
        "glossary": END_USER_GLOSSARY,
        "transcript": (
            "参加者: 請求書を送るときに手間取りました。\n"
            "SANBA: それはいつごろのことですか？"
            "たとえば「先週の月末処理のとき」のように教えてください。\n"
            "参加者: 先週です。\n"
            "SANBA: 請求書一覧の画面から始めましたか？たとえば「検索して開いた」でも大丈夫です。\n"
            "参加者: はい、請求書一覧から明細画面を開きました。\n"
            "SANBA: 明細画面では何をしようとしていましたか？"
            "たとえば「宛先を変えて送ろうとした」など。\n"
            "参加者: 送るところで止まりました。\n"
            "SANBA: 送信ボタンの場所で戸惑ったのですね。そのとき画面はどう見えていましたか？"
        ),
    },
    {
        "name": "eu_jargon_leak",
        "glossary": END_USER_GLOSSARY,
        "transcript": (
            "参加者: 請求書を送るときに手間取りました。\n"
            "SANBA: 非機能の観点を確認します。APIのレイテンシ要件は？スループットは？"
            "MoSCoWで優先度も教えてください。"
        ),
    },
]


async def run_dataset_eval() -> int:
    """Run the regression datasets and return a process exit code (0 = pass)."""
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

    exit_code = 0
    if not ordering_ok:
        print("REGRESSION: well-covered interview did not outscore shallow", file=sys.stderr)
        exit_code = 1
    if by_name.get("well_covered", 0) < QUALITY_THRESHOLD:
        print("REGRESSION: best scenario below quality threshold", file=sys.stderr)
        exit_code = 1

    # end_user モード（FR-2.8）: developer 回帰が落ちても続けて全観点を報告する。
    eu_results = []
    for sc in END_USER_SCENARIOS:
        res = await judge_end_user_interview(sc["transcript"], sc["glossary"])
        eu_results.append((sc["name"], res))
        print(f"[{sc['name']:>14}] overall={res.overall:.2f} scores={res.scores}")
    eu_by_name = {n: r.overall for n, r in eu_results}
    eu_ordering_ok = eu_by_name.get("eu_grounded", 0) > eu_by_name.get("eu_jargon_leak", 1)
    print(
        f"end_user threshold={END_USER_QUALITY_THRESHOLD} ordering_ok={eu_ordering_ok} "
        f"grounded={eu_by_name.get('eu_grounded', 0):.2f}"
    )
    if not eu_ordering_ok:
        print("REGRESSION: end_user grounded did not outscore jargon leak", file=sys.stderr)
        exit_code = 1
    if eu_by_name.get("eu_grounded", 0) < END_USER_QUALITY_THRESHOLD:
        print("REGRESSION: end_user scenario below quality threshold", file=sys.stderr)
        exit_code = 1
    return exit_code


def main() -> None:
    code = asyncio.run(run_dataset_eval())
    sys.exit(code)


if __name__ == "__main__":
    main()


__all__ = [
    "JudgeResult",
    "judge_end_user_interview",
    "judge_interview",
    "run_dataset_eval",
    "score_session",
]
