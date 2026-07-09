"""分析イベントの排出シンク（ADR-0061 決定 1 の二重排出）。

排出は (a) 構造化ログ（`ai_cost_event` / `session_cost_summary` → Cloud Logging →
log-based metric）と (b) Elasticsearch `sanba-analytics-events` データストリームへの直接
index の二重化。ES への書き込みは単一ワーカースレッドの executor に逃がし、音声ループ・
リクエストハンドラを塞がない。失敗は `analytics_emit_failed` 警告ログに落として本処理を
止めない（fail-soft、ADR-0051 の流儀）。ES 未設定/接続不可はインメモリへフォールバックし
ローカル/テストで落とさない（`ContextIndexer` と同じ倒し方）。

プロセス内のコンポーネント別累計（`totals()`）も持ち、agent はセッション終了時にこれを
Firestore `sessions/{id}.ai_cost` へ加算する。
"""

from __future__ import annotations

import threading
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Any

import structlog

from .analytics import EVENT_AI_USAGE, EVENT_SESSION_SUMMARY
from .analytics_setup import ANALYTICS_DATA_STREAM, ensure_event_stream_template

log = structlog.get_logger(__name__)

_MEM_LIMIT = 1000


def _fmt_usd(value: Any, digits: int = 8) -> str | None:
    """金額を固定小数点文字列で描く（指数表記だと log-based metric の正規表現が誤抽出する）。"""
    if value is None:
        return None
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class AnalyticsConfig:
    """分析イベントの ES 接続設定（アプリ settings 非依存）。"""

    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    data_stream: str = ANALYTICS_DATA_STREAM


class AnalyticsSink:
    """`ai_usage` / `session_summary` イベントの排出口。emit はどのスレッドからも安全。"""

    def __init__(self, config: AnalyticsConfig | None = None) -> None:
        self._config = config or AnalyticsConfig()
        self._client: Any | None = None
        self._client_initialized = False
        self._mem: list[dict[str, Any]] = []
        self._totals: dict[str, dict[str, float]] = {}
        self._lock = threading.Lock()
        self._pending: set[Future[None]] = set()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sanba-analytics")

    @property
    def is_memory(self) -> bool:
        return not self._config.elasticsearch_url

    def emit(self, event: dict[str, Any]) -> None:
        try:
            self._log_event(event)
            self._accumulate(event)
            future = self._executor.submit(self._index_event, event)
            with self._lock:
                self._pending.add(future)
            future.add_done_callback(self._on_index_done)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "analytics_emit_failed",
                session=event.get("session_id"),
                event_type=event.get("event_type"),
                error=str(exc),
            )

    def totals(self) -> dict[str, dict[str, float]]:
        with self._lock:
            return {component: dict(values) for component, values in self._totals.items()}

    def flush(self, timeout: float = 3.0) -> None:
        with self._lock:
            pending = set(self._pending)
        if pending:
            wait(pending, timeout=timeout)

    def close(self, timeout: float = 1.0) -> None:
        """送信済みを短時間待って残りを破棄する（プロセス退出を塞がない）。冪等。"""
        self.flush(timeout)
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _log_event(self, event: dict[str, Any]) -> None:
        payload = event.get("payload", {})
        if event.get("event_type") == EVENT_AI_USAGE:
            tokens = payload.get("tokens", {})
            log.info(
                "ai_cost_event",
                session=event.get("session_id"),
                product=event.get("product_id"),
                component=payload.get("component"),
                model=payload.get("model"),
                estimated_usd=_fmt_usd(payload.get("estimated_usd")),
                input_tokens=tokens.get("input_tokens", 0),
                output_tokens=tokens.get("output_tokens", 0),
                requests=payload.get("requests", 1),
            )
            return
        if event.get("event_type") == EVENT_SESSION_SUMMARY:
            kpi = payload.get("kpi", {})
            livekit = payload.get("livekit") or {}
            efficiency = payload.get("efficiency", {})
            log.info(
                "session_cost_summary",
                session=event.get("session_id"),
                product=event.get("product_id"),
                interview_mode=event.get("interview_mode"),
                total_usd=_fmt_usd(payload.get("total_usd")),
                total_jpy=_fmt_usd(payload.get("total_jpy"), digits=2),
                ai_usd=_fmt_usd(payload.get("ai_usd")),
                livekit_usd=_fmt_usd(livekit.get("estimated_usd", 0.0)),
                finalized_count=kpi.get("finalized_count", 0),
                resolved_inquiries=(kpi.get("inquiry") or {}).get("resolved_total", 0),
                session_seconds=kpi.get("session_seconds", 0.0),
                usd_per_finalized_requirement=_fmt_usd(
                    efficiency.get("usd_per_finalized_requirement")
                ),
            )
            return
        log.info(
            "analytics_event",
            session=event.get("session_id"),
            event_type=event.get("event_type"),
        )

    def _accumulate(self, event: dict[str, Any]) -> None:
        if event.get("event_type") != EVENT_AI_USAGE:
            return
        payload = event.get("payload", {})
        component = str(payload.get("component", "unknown"))
        tokens = payload.get("tokens", {})
        with self._lock:
            totals = self._totals.setdefault(
                component,
                {"usd": 0.0, "input_tokens": 0, "output_tokens": 0, "requests": 0},
            )
            totals["usd"] = round(totals["usd"] + float(payload.get("estimated_usd", 0.0)), 8)
            totals["input_tokens"] += int(tokens.get("input_tokens", 0))
            totals["output_tokens"] += int(tokens.get("output_tokens", 0))
            totals["requests"] += int(payload.get("requests", 1))

    def _on_index_done(self, future: Future[None]) -> None:
        with self._lock:
            self._pending.discard(future)
        if future.cancelled():
            return
        exc = future.exception()
        if exc is not None:
            log.warning("analytics_emit_failed", error=str(exc))

    def _document(self, event: dict[str, Any]) -> dict[str, Any]:
        return {"@timestamp": event.get("occurred_at"), **event}

    def _index_event(self, event: dict[str, Any]) -> None:
        client = self._ensure_client()
        if client is None:
            with self._lock:
                self._mem.append(self._document(event))
                if len(self._mem) > _MEM_LIMIT:
                    del self._mem[: len(self._mem) - _MEM_LIMIT]
            return
        try:
            client.index(
                index=self._config.data_stream,
                document=self._document(event),
                require_data_stream=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "analytics_emit_failed",
                session=event.get("session_id"),
                event_type=event.get("event_type"),
                error=str(exc),
            )

    def _ensure_client(self) -> Any | None:
        if self._client_initialized:
            return self._client
        self._client_initialized = True
        if not self._config.elasticsearch_url:
            return None
        try:
            from elasticsearch import Elasticsearch

            kwargs: dict[str, Any] = {
                "hosts": [self._config.elasticsearch_url],
                "request_timeout": 5,
            }
            if self._config.elasticsearch_api_key:
                kwargs["api_key"] = self._config.elasticsearch_api_key
            client = Elasticsearch(**kwargs)
            try:
                ensure_event_stream_template(client)
            except Exception as exc:  # noqa: BLE001
                log.warning("analytics_template_ensure_failed", error=str(exc))
            self._client = client
        except Exception as exc:  # noqa: BLE001
            log.warning("analytics_es_unavailable_using_memory", error=str(exc))
            self._client = None
        return self._client
