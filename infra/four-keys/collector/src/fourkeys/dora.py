"""Pure DORA / Four Keys computation.

No I/O here on purpose — feed it ``Deployment`` and ``Incident`` lists and get a
``FourKeys`` back. The performance bands follow the DORA "State of DevOps"
report (Elite / High / Medium / Low). We measure to find bottlenecks, never to
look good — metric hacking is explicitly out of scope (CLAUDE.md 原則4).
"""

from __future__ import annotations

from collections.abc import Sequence
from statistics import median

from .models import Deployment, FourKeys, Incident

_HOUR = 3600.0
_DAY = 24 * _HOUR
_WEEK = 7 * _DAY
_MONTH = 30 * _DAY


def _deploy_frequency_level(per_day: float) -> str:
    if per_day >= 1:
        return "elite"
    if per_day >= 1 / 7:
        return "high"
    if per_day >= 1 / 30:
        return "medium"
    return "low"


def _lead_time_level(hours: float | None) -> str:
    if hours is None:
        return "unknown"
    seconds = hours * _HOUR
    if seconds < _DAY:
        return "elite"
    if seconds < _WEEK:
        return "high"
    if seconds < _MONTH:
        return "medium"
    return "low"


def _change_failure_level(rate: float) -> str:
    if rate <= 0.05:
        return "elite"
    if rate <= 0.15:
        return "high"
    if rate <= 0.30:
        return "medium"
    return "low"


def _mttr_level(hours: float | None) -> str:
    if hours is None:
        return "unknown"
    seconds = hours * _HOUR
    if seconds < _HOUR:
        return "elite"
    if seconds < _DAY:
        return "high"
    if seconds < _WEEK:
        return "medium"
    return "low"


def compute(
    deployments: Sequence[Deployment],
    incidents: Sequence[Incident],
    window_days: float,
    source: str = "github",
) -> FourKeys:
    """Compute the four keys over ``window_days`` of history."""

    window_days = max(window_days, 1e-9)
    total = len(deployments)
    failed = sum(1 for d in deployments if not d.success)

    frequency = total / window_days

    lead_samples = [
        d.lead_time_seconds for d in deployments if d.success and d.lead_time_seconds is not None
    ]
    lead_hours = median(lead_samples) / _HOUR if lead_samples else None

    change_failure_rate = (failed / total) if total else 0.0

    recovery_samples = [i.recovery_seconds for i in incidents if i.recovery_seconds is not None]
    mttr_hours = median(recovery_samples) / _HOUR if recovery_samples else None

    levels = {
        "deployment_frequency": _deploy_frequency_level(frequency),
        "lead_time": _lead_time_level(lead_hours),
        "change_failure_rate": _change_failure_level(change_failure_rate),
        "mttr": _mttr_level(mttr_hours),
    }

    return FourKeys(
        window_days=window_days,
        deployments_total=total,
        failed_deployments_total=failed,
        incidents_total=len(incidents),
        deployment_frequency_per_day=frequency,
        lead_time_hours=lead_hours,
        change_failure_rate=change_failure_rate,
        mttr_hours=mttr_hours,
        source=source,
        levels=levels,
    )
