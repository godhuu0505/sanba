"""セッション単位の AI コスト集計（ADR-0061 P0）。

Live 音声の usage は `AgentSession` の `session_usage_updated` イベント（現行推奨 API。
deprecated な `UsageCollector` + セッションレベル `metrics_collected` は使わない）を購読して
累積スナップショットを差分化し、`ai_usage` イベントとして排出する。AgentSession の usage は
`start()` ごとにリセットされ再起動で消えるため、差分の確定はプロセス側（このトラッカー）で
再起動を跨いで持つ。セッション終了時は `session.usage.model_usage` で最終突合し、
コスト合計 × KPI を結合した `session_summary` を組み立てて Firestore / 構造化ログ / ES へ流す。

全経路 fail-soft: 集計・排出の失敗が会話セッション本体（音声ループ・シャットダウン猶予
~10s）へ波及しない。
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog
from sanba_shared.analytics import (
    COMPONENT_LIVE_AUDIO,
    EVENT_SESSION_SUMMARY,
    LiveKitRates,
    TokenUsage,
    UsageRecorder,
    build_event,
    build_session_summary_payload,
    estimate_livekit_usd,
    usage_delta,
    usage_from_model_usage,
)
from sanba_shared.analytics_sink import AnalyticsSink
from sanba_shared.repository import SessionRepository

log = structlog.get_logger(__name__)


class LiveUsageTracker:
    """`session_usage_updated` の累積スナップショットを差分化して `ai_usage` に落とす。

    負の差分（AgentSession 再起動で集計がリセットされた直後）はスナップショット全量を
    新規差分として扱う。`commit()` は再起動・終了時にベースラインを畳み、次の
    AgentSession の初回スナップショットが全量差分として計上されるようにする。
    """

    def __init__(self, recorder: UsageRecorder, default_model: str) -> None:
        self._recorder = recorder
        self._default_model = default_model
        self._last: dict[tuple[str, str], TokenUsage] = {}
        self._total = TokenUsage()

    @property
    def total(self) -> TokenUsage:
        return self._total

    def record_snapshot(self, model_usage: list[Any] | None) -> None:
        for entry in model_usage or []:
            if getattr(entry, "type", "") != "llm_usage":
                continue
            key = (str(getattr(entry, "provider", "")), str(getattr(entry, "model", "")))
            current = usage_from_model_usage(entry)
            delta = usage_delta(current, self._last.get(key, TokenUsage()))
            if delta is None:
                delta = current
            self._last[key] = current
            if delta.is_empty:
                continue
            self._total = self._total.add(delta)
            self._recorder.record(COMPONENT_LIVE_AUDIO, key[1] or self._default_model, delta)

    def commit(self) -> None:
        self._last.clear()


def _components_from_totals(totals: dict[str, dict[str, float]]) -> dict[str, dict[str, Any]]:
    return {
        component: {
            "usd": values.get("usd", 0.0),
            "input_tokens": int(values.get("input_tokens", 0)),
            "output_tokens": int(values.get("output_tokens", 0)),
            "requests": int(values.get("requests", 0)),
        }
        for component, values in totals.items()
    }


async def emit_session_cost_summary(
    *,
    session_id: str,
    repo: SessionRepository,
    sink: AnalyticsSink,
    recorder: UsageRecorder,
    inquiry_counts: dict[str, int],
    judge_result: Any | None,
    session_seconds: float,
    noise_cancellation: bool,
    usd_jpy_rate: float,
    livekit_rates: LiveKitRates | None = None,
) -> dict[str, Any]:
    """セッション終了時の `session_summary` を組み立てて排出・永続化する。

    1. プロセス内累計（sink.totals）を Firestore `sessions/{id}.ai_cost` へ加算
       （api/worker が都度加算した分と `Increment` で合流する）
    2. 合算後のコスト内訳を読み戻し、LiveKit 分数推定・KPI と結合した payload を組み立てる
    3. `session_summary` イベントを排出（`session_cost_summary` 構造化ログ + ES index）し、
       確定サマリを `ai_cost.summary` へ merge 保存する
    Firestore の失敗は該当ステップだけを落とし（fail-soft）、ログ/ES 排出は続行する。
    """
    totals = sink.totals()
    for component, values in totals.items():
        try:
            await asyncio.to_thread(
                repo.add_session_ai_cost,
                session_id,
                component=component,
                usd=float(values.get("usd", 0.0)),
                input_tokens=int(values.get("input_tokens", 0)),
                output_tokens=int(values.get("output_tokens", 0)),
                requests=int(values.get("requests", 0)),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "session_cost_increment_failed",
                session=session_id,
                component=component,
                error=str(exc),
            )
    components = _components_from_totals(totals)
    meta = None
    requirement_count = 0
    try:
        cost_doc = await asyncio.to_thread(repo.get_session_ai_cost, session_id)
        if cost_doc.get("components"):
            components = {name: dict(values) for name, values in cost_doc["components"].items()}
        meta = await asyncio.to_thread(repo.get_session, session_id)
        requirement_count = len(await asyncio.to_thread(repo.list_requirements, session_id))
    except Exception as exc:  # noqa: BLE001
        log.warning("session_cost_readback_failed", session=session_id, error=str(exc))
    livekit = estimate_livekit_usd(
        session_seconds / 60.0,
        noise_cancellation=noise_cancellation,
        rates=livekit_rates,
    )
    kpi: dict[str, Any] = {
        "finalized_count": (meta.finalized_count or 0) if meta is not None else 0,
        "requirement_count": requirement_count,
        "session_seconds": round(session_seconds, 1),
        "inquiry": dict(inquiry_counts),
    }
    if judge_result is not None:
        kpi["quality_overall"] = judge_result.overall
        kpi["quality_scores"] = dict(judge_result.scores)
    payload = build_session_summary_payload(
        components=components,
        livekit=livekit,
        kpi=kpi,
        usd_jpy_rate=usd_jpy_rate,
    )
    sink.emit(
        build_event(
            event_type=EVENT_SESSION_SUMMARY,
            session_id=session_id,
            product_id=recorder.product_id,
            interview_mode=recorder.interview_mode,
            payload=payload,
        )
    )
    try:
        await asyncio.to_thread(repo.set_session_cost_summary, session_id, payload)
    except Exception as exc:  # noqa: BLE001
        log.warning("session_cost_summary_persist_failed", session=session_id, error=str(exc))
    await asyncio.to_thread(sink.flush, 2.0)
    return payload
