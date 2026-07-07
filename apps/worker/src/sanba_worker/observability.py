"""Minimal OTel metrics for the worker (defensive: no-op without an exporter).

新しい処理には観測性を通す（CLAUDE.md 原則3）。動画解析の結末を
`sanba_video_analysis_total{result}` に集約し、処理時間を記録する。エクスポータ未設定でも
落ちない（メーターは no-op になる）。
"""

from __future__ import annotations

from typing import Any

import structlog

log = structlog.get_logger(__name__)

_analysis_total: Any = None
_analysis_duration: Any = None

try:  # pragma: no cover
    from opentelemetry import metrics

    _meter = metrics.get_meter("sanba.worker")
    _analysis_total = _meter.create_counter(
        "sanba_video_analysis_total",
        description="Video analysis outcomes by result (done/failed/skipped/error).",
    )
    _analysis_duration = _meter.create_histogram(
        "sanba_video_analysis_seconds",
        unit="s",
        description="Wall-clock seconds spent analysing a video.",
    )
except Exception:  # pragma: no cover
    pass


def record_analysis(result: str, *, seconds: float | None = None) -> None:
    """解析結末を記録する（result=done/failed/skipped/error）。"""
    if _analysis_total is not None:  # pragma: no cover
        _analysis_total.add(1, {"result": result})
        if seconds is not None and _analysis_duration is not None:
            _analysis_duration.record(seconds, {"result": result})
    log.info("video_analysis_recorded", result=result, seconds=seconds)
