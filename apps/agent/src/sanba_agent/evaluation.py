"""LLMOps: LLM-as-a-judge online evaluation + offline regression.

「まわす」軸の実装 — AI を継続的に改善するサイクル。
- online: セッション終了時にインタビュー品質を採点し `session_scored` 構造化ログに記録する。
  ログベースメトリクス → Cloud Monitoring ダッシュボードで可視化する（ADR-0051）。
- offline: 代表シナリオのデータセットを CI で回帰評価し、品質劣化を検出する。
  (`python -m sanba_agent.evaluation` を llm-eval ワークフローが実行)

Gemini が使えない環境ではヒューリスティック採点にフォールバックするので、
鍵が無くてもパイプラインは動く(品質の絶対値ではなく回帰検出が目的)。
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

import structlog
from sanba_shared.analytics import TokenUsage, usage_from_genai
from sanba_shared.models import InviteScope

from .config import settings

log = structlog.get_logger(__name__)

UsageHook = Callable[[TokenUsage], None]


def _report_usage(usage_hook: UsageHook | None, resp: object) -> None:
    if usage_hook is None:
        return
    try:
        usage_hook(usage_from_genai(getattr(resp, "usage_metadata", None)))
    except Exception as exc:  # noqa: BLE001
        log.warning("judge_usage_hook_failed", error=str(exc))


def _labels_config(billing_labels: dict[str, str] | None):  # type: ignore[no-untyped-def]
    if not billing_labels:
        return None
    from google.genai import types

    return types.GenerateContentConfig(labels=billing_labels)


_NFR_KEYWORD_GROUPS: tuple[tuple[str, ...], ...] = (
    ("レイテンシ", "性能", "速", "latency", "performance"),
    ("可用性", "slo", "稼働", "ダウンタイム"),
    ("セキュリティ", "個人情報", "pii", "認証", "権限"),
    ("コスト", "予算", "料金", "費用"),
    ("ユーザー", "規模", "同時", "人数"),
)


def _nfr_coverage_fallback(transcript: str) -> float:
    """LLM judge が無いときの nfr_coverage 決定的スコア（会話ゲートではなく回帰採点用）。"""
    text = transcript.lower()
    covered = sum(1 for group in _NFR_KEYWORD_GROUPS if any(kw in text for kw in group))
    return covered / len(_NFR_KEYWORD_GROUPS)


RUBRIC = [
    ("nfr_coverage", "非機能要件(性能/可用性/セキュリティ/コスト/規模)を十分に確認したか"),
    ("question_specificity", "曖昧さを残さず、具体的で測定可能な問いを立てたか"),
    ("contradiction_handling", "矛盾や抜けを検知して掘り下げたか"),
]

QUALITY_THRESHOLD = 0.5

END_USER_RUBRIC = [
    ("no_jargon", "技術用語(API/DB/非機能/MoSCoW 等)を利用者への発話に出していないか"),
    ("single_question", "1ターンに問いを1つに保ち、畳みかけていないか"),
    ("glossary_usage", "アプリの画面語彙(glossary)で話しているか"),
]

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
        glossary_usage = 1.0

    return JudgeResult.from_scores(
        {
            "no_jargon": round(no_jargon, 3),
            "single_question": round(single_question, 3),
            "glossary_usage": round(glossary_usage, 3),
        },
        rationale="heuristic fallback (no LLM judge available)",
    )


async def judge_end_user_interview(
    transcript: str,
    glossary: list[str],
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> JudgeResult:
    """Score an end_user-mode transcript, falling back to deterministic heuristics."""
    if not transcript.strip():
        return JudgeResult.from_scores(dict.fromkeys((k for k, _ in END_USER_RUBRIC), 0.0), "empty")
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return _heuristic_end_user_scores(transcript, glossary)
    try:  # pragma: no cover - needs network/credentials
        return await _llm_judge_end_user(
            transcript, glossary, usage_hook=usage_hook, billing_labels=billing_labels
        )
    except Exception as exc:  # pragma: no cover
        log.warning("llm_judge_failed_falling_back", error=str(exc))
        return _heuristic_end_user_scores(transcript, glossary)


async def _llm_judge_end_user(
    transcript: str,
    glossary: list[str],
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
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
        model=settings.gemini_reasoning_model,
        contents=prompt,
        config=_labels_config(billing_labels),
    )
    _report_usage(usage_hook, resp)
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
    nfr = _nfr_coverage_fallback(transcript)
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


async def judge_interview(
    transcript: str,
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> JudgeResult:
    """Score an interview transcript with an LLM judge, falling back to heuristics."""
    if not transcript.strip():
        return JudgeResult.from_scores(dict.fromkeys((k for k, _ in RUBRIC), 0.0), "empty")
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return _heuristic_scores(transcript)
    try:  # pragma: no cover - needs network/credentials
        return await _llm_judge(transcript, usage_hook=usage_hook, billing_labels=billing_labels)
    except Exception as exc:  # pragma: no cover
        log.warning("llm_judge_failed_falling_back", error=str(exc))
        return _heuristic_scores(transcript)


async def _llm_judge(
    transcript: str,
    *,
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> JudgeResult:  # pragma: no cover - needs creds
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
        model=settings.gemini_reasoning_model,
        contents=prompt,
        config=_labels_config(billing_labels),
    )
    _report_usage(usage_hook, resp)
    text = (resp.text or "").strip().removeprefix("```json").removesuffix("```").strip()
    data = json.loads(text)
    return JudgeResult.from_scores(
        {k: float(data["scores"].get(k, 0.0)) for k, _ in RUBRIC},
        data.get("rationale", ""),
    )


async def score_session(
    session_id: str,
    transcript: str,
    *,
    mode: InviteScope = InviteScope.DEVELOPER,
    glossary: Sequence[str] = (),
    usage_hook: UsageHook | None = None,
    billing_labels: dict[str, str] | None = None,
) -> JudgeResult:
    """Online evaluation: score a finished session and emit it as a structured log.

    スコアは `session_scored` 構造化ログとして Cloud Logging に残り、ログベースメトリクス
    → Cloud Monitoring ダッシュボードで可視化する（ADR-0051）。外部 sink は持たない。

    採点ルーブリックは mode で切り替える: end_user は `judge_end_user_interview`
    （no_jargon / single_question / glossary_usage）、それ以外は `judge_interview`
    （nfr_coverage / question_specificity / contradiction_handling）。タイムアウト時の決定的
    フォールバックも対称に倒す（end_user は `_heuristic_end_user_scores`）。`interview_mode` を
    `session_scored` ログに載せてダッシュボードでモード別に分ける（ADR-0056 の既知の制約を解消）。

    シャットダウン後始末（entrypoint の close callback）から呼ぶため、LLM judge を
    `session_score_timeout_seconds` で制限する。制限超過なら即時の決定的ヒューリスティック採点へ
    フォールバックし、離脱直後の新規 genai 呼び出しがプロセス退出の猶予（LiveKit ~10s）を超えて
    SIGKILL を招くのを防ぐ（毎セッション終了時の ERROR / #435 🟡）。
    """
    end_user = mode == InviteScope.END_USER
    glossary_list = [g for g in glossary if g and g.strip()]
    try:
        if end_user:
            result = await asyncio.wait_for(
                judge_end_user_interview(
                    transcript,
                    glossary_list,
                    usage_hook=usage_hook,
                    billing_labels=billing_labels,
                ),
                timeout=settings.session_score_timeout_seconds,
            )
        else:
            result = await asyncio.wait_for(
                judge_interview(transcript, usage_hook=usage_hook, billing_labels=billing_labels),
                timeout=settings.session_score_timeout_seconds,
            )
    except TimeoutError:
        log.warning("session_score_timeout", session=session_id, interview_mode=mode.value)
        result = (
            _heuristic_end_user_scores(transcript, glossary_list)
            if end_user
            else _heuristic_scores(transcript)
        )
    log.info(
        "session_scored",
        session=session_id,
        interview_mode=mode.value,
        overall=result.overall,
        scores=result.scores,
    )
    return result


DEFAULT_SCENARIOS: list[dict] = [
    {
        "name": "well_covered",
        "expectation": "good",
        "transcript": (
            "参加者: 社内の議事録を要約したい。\n"
            "SANBA: 想定する同時利用者数は？\n参加者: 50人です。\n"
            "SANBA: レイテンシ要件は？\n参加者: 5秒以内。\n"
            "SANBA: 個人情報の扱いとセキュリティは？\n参加者: 認証必須、社内のみ。\n"
            "SANBA: 稼働時間帯と可用性の期待は？\n参加者: 平日の日中に動けば十分です。\n"
            "SANBA: 予算規模は？\n参加者: 月10万円。\n"
            "SANBA: 同時50人が5秒以内という性能目標と月10万円の予算は矛盾するおそれがあります。"
            "どちらを優先しますか？\n"
            "参加者: 応答速度を優先します。超える分の予算は増額を検討します。\n"
            "SANBA: では前提を確認します。ピーク時のアクセスはいつ、どの程度集中しますか？\n"
            "参加者: 朝会の直後30分に、最大50人が集中します。"
        ),
    },
    {
        "name": "nfr_probing",
        "expectation": "good",
        "transcript": (
            "参加者: 店舗の予約をアプリで受け付けたいです。\n"
            "SANBA: ピーク時はどのくらいの同時アクセスを見込みますか？\n"
            "参加者: 週末の朝に集中して、最大200人くらいです。\n"
            "SANBA: 予約確定までのレイテンシはどの程度まで許容できますか？\n"
            "参加者: 3秒以内が理想です。\n"
            "SANBA: 決済や個人情報を扱う場合、セキュリティの要件はありますか？\n"
            "参加者: 決済は外部サービスに任せ、会員情報は暗号化してほしいです。\n"
            "SANBA: 障害時はどのくらいのダウンタイムまで許容できますか？\n"
            "参加者: 営業時間中は30分以内に復旧してほしいです。\n"
            "SANBA: 月々のコストに上限はありますか？\n"
            "参加者: 月5万円までです。\n"
            "SANBA: 週末に最大200人という規模と月5万円の上限は矛盾するかもしれません。"
            "確認ですが、費用と待ち時間のどちらを優先しますか？\n"
            "参加者: 費用を優先し、混雑時の待ち時間は許容します。"
        ),
    },
    {
        "name": "shallow",
        "expectation": "bad",
        "transcript": "参加者: 要約機能がほしい。\nSANBA: わかりました、作ります。",
    },
    {
        "name": "contradiction_ignored",
        "expectation": "bad",
        "transcript": (
            "参加者: 全社員3000人が朝の始業時に一斉に使います。\n"
            "SANBA: サーバーは何台くらいの想定ですか？\n"
            "参加者: 無料枠の1台で足りると思っています。\n"
            "SANBA: わかりました。次に、画面は何色が好みですか？\n"
            "参加者: 青系がいいです。\n"
            "SANBA: いいですね。それでは要件をまとめます。"
        ),
    },
]


END_USER_GLOSSARY = ["請求書一覧", "明細画面", "送信ボタン"]

END_USER_SCENARIOS: list[dict] = [
    {
        "name": "eu_grounded",
        "expectation": "good",
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
        "name": "eu_concrete_recall",
        "expectation": "good",
        "glossary": END_USER_GLOSSARY,
        "transcript": (
            "参加者: 昨日、請求書を送るのを途中でやめてしまいました。\n"
            "SANBA: 請求書一覧の画面までは進めましたか？\n"
            "参加者: はい、そこから明細画面を開きました。\n"
            "SANBA: 明細画面では、どこで手が止まりましたか？\n"
            "参加者: 金額を直したかったのですが、直し方がわからなくて。\n"
            "SANBA: 直せないと分かったとき、送信ボタンは押しましたか？\n"
            "参加者: 押さずに画面を閉じました。\n"
            "SANBA: 閉じる直前、画面にはどんな表示が見えていましたか？"
        ),
    },
    {
        "name": "eu_jargon_leak",
        "expectation": "bad",
        "glossary": END_USER_GLOSSARY,
        "transcript": (
            "参加者: 請求書を送るときに手間取りました。\n"
            "SANBA: 非機能の観点を確認します。APIのレイテンシ要件は？スループットは？"
            "MoSCoWで優先度も教えてください。"
        ),
    },
    {
        "name": "eu_stacked_questions",
        "expectation": "bad",
        "glossary": END_USER_GLOSSARY,
        "transcript": (
            "参加者: 請求書を送るときに手間取りました。\n"
            "SANBA: それはいつですか？どの画面でしたか？何をしようとしていて、"
            "誰と作業していて、何分くらいかかりましたか？"
        ),
    },
]


COVERAGE_SCENARIOS: list[dict] = [
    {
        "name": "cov_partial",
        "check_points": [
            "性能・レスポンスの要件",
            "セキュリティ・権限・データ保護",
            "コスト・予算",
        ],
        "transcript": (
            "参加者: 一覧の表示は 500 ミリ秒以内に返してほしい。\n"
            "SANBA: 認証やアクセス権限はどうしますか？\n"
            "参加者: 社内のみ、ログイン必須で、閲覧権限も分けたいです。"
        ),
        "expected_uncovered": ["コスト・予算"],
        "expected_covered": ["性能・レスポンスの要件", "セキュリティ・権限・データ保護"],
    },
    {
        "name": "cov_all_open",
        "check_points": ["性能・レスポンスの要件", "コスト・予算"],
        "transcript": (
            "参加者: 議事録を要約したいです。\n"
            "SANBA: どんな場面で使いますか？\n"
            "参加者: 会議のあとです。"
        ),
        "expected_uncovered": ["性能・レスポンスの要件", "コスト・予算"],
        "expected_covered": [],
    },
    {
        "name": "cov_fully_covered",
        "check_points": ["性能・レスポンスの要件", "コスト・予算"],
        "transcript": (
            "参加者: 一覧の表示は1秒以内に返してほしいです。\n"
            "SANBA: 費用の上限はありますか？\n"
            "参加者: 月3万円までに抑えたいです。"
        ),
        "expected_uncovered": [],
        "expected_covered": ["性能・レスポンスの要件", "コスト・予算"],
    },
]


async def run_coverage_eval() -> int:
    """観点カバレッジ判定の CI 回帰評価（ADR-0057 増分2c）。

    `assess_check_point_coverage` は creds 無しで一律 `[]`（決定的 fallback を持たない advisory
    設計）のため、creds があるときだけアサートし、無ければ skip して 0 を返す（llm-eval.yml は
    WIF + Vertex AI で認証する）。検証は3点: expected_uncovered（明らかに未カバーな観点）が返りに
    含まれること、expected_covered（明らかにカバー済みの観点）が返りに含まれないこと（過検知
    ガード）、返りが check_points の部分集合であること（未知の文言を surface しない安全側）。
    """
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        print("coverage_eval: skipped (no creds)")
        return 0
    from .tools.analysis import assess_check_point_coverage

    exit_code = 0
    for sc in COVERAGE_SCENARIOS:
        returned = await assess_check_point_coverage(sc["transcript"], sc["check_points"])
        returned_set = set(returned)
        check_set = set(sc["check_points"])
        expected = set(sc["expected_uncovered"])
        covered = set(sc.get("expected_covered", []))
        print(f"[{sc['name']:>22}] uncovered={sorted(returned_set)} expected⊇={sorted(expected)}")
        if not returned_set <= check_set:
            print(
                f"REGRESSION: coverage returned unknown points {sorted(returned_set - check_set)}",
                file=sys.stderr,
            )
            exit_code = 1
        if not expected <= returned_set:
            print(
                f"REGRESSION: coverage missed uncovered points {sorted(expected - returned_set)}",
                file=sys.stderr,
            )
            exit_code = 1
        if returned_set & covered:
            print(
                f"REGRESSION: coverage flagged covered points {sorted(returned_set & covered)}",
                file=sys.stderr,
            )
            exit_code = 1
    return exit_code


async def _run_rubric_eval(
    scenarios: Sequence[dict],
    judge: Callable[[dict], Awaitable[JudgeResult]],
    threshold: float,
    label: str,
) -> int:
    """expectation 付きシナリオ群を採点し、good の絶対水準と good/bad の弁別を検証する。

    アサートは2点: すべての good が threshold 以上、かつ最低の good がすべての bad を上回る
    （弁別できない judge の劣化を検出）。ヒューリスティックフォールバックでも同じ順序に
    なるようシナリオを設計してあるため、creds の有無によらず同一のゲートが機能する。
    """
    results: list[tuple[dict, JudgeResult]] = []
    for sc in scenarios:
        res = await judge(sc)
        results.append((sc, res))
        print(
            f"[{sc['name']:>22}] {label} expectation={sc['expectation']} "
            f"overall={res.overall:.2f} scores={res.scores}"
        )

    goods = [(sc["name"], res.overall) for sc, res in results if sc["expectation"] == "good"]
    bads = [(sc["name"], res.overall) for sc, res in results if sc["expectation"] == "bad"]
    exit_code = 0
    for name, overall in goods:
        if overall < threshold:
            print(
                f"REGRESSION: {label} good scenario '{name}' scored {overall:.2f} "
                f"below threshold {threshold}",
                file=sys.stderr,
            )
            exit_code = 1
    if goods and bads:
        worst_good = min(overall for _, overall in goods)
        best_bad = max(overall for _, overall in bads)
        ordering_ok = worst_good > best_bad
        print(
            f"{label}: threshold={threshold} worst_good={worst_good:.2f} "
            f"best_bad={best_bad:.2f} ordering_ok={ordering_ok}"
        )
        if not ordering_ok:
            print(
                f"REGRESSION: {label} good scenarios did not outscore bad scenarios",
                file=sys.stderr,
            )
            exit_code = 1
    return exit_code


async def run_dataset_eval() -> int:
    """Run the regression datasets and return a process exit code (0 = pass)."""
    exit_code = 0
    if (
        await _run_rubric_eval(
            DEFAULT_SCENARIOS,
            lambda sc: judge_interview(sc["transcript"]),
            QUALITY_THRESHOLD,
            "developer",
        )
        != 0
    ):
        exit_code = 1
    if (
        await _run_rubric_eval(
            END_USER_SCENARIOS,
            lambda sc: judge_end_user_interview(sc["transcript"], sc["glossary"]),
            END_USER_QUALITY_THRESHOLD,
            "end_user",
        )
        != 0
    ):
        exit_code = 1
    if await run_coverage_eval() != 0:
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
