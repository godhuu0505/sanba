from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fourkeys.dora import compute
from fourkeys.exporter import render_prometheus
from fourkeys.models import Deployment, Incident

NOW = datetime(2026, 6, 15, tzinfo=UTC)


def _deploy(days_ago: float, success: bool, lead_h: float | None) -> Deployment:
    return Deployment(
        id=f"d{days_ago}",
        deployed_at=NOW - timedelta(days=days_ago),
        success=success,
        lead_time_seconds=None if lead_h is None else lead_h * 3600,
    )


def test_frequency_and_counts() -> None:
    deps = [_deploy(i, True, 2.0) for i in range(10)]
    m = compute(deps, [], window_days=10)
    assert m.deployments_total == 10
    assert m.deployment_frequency_per_day == 1.0
    assert m.levels["deployment_frequency"] == "elite"


def test_change_failure_rate() -> None:
    deps = [
        _deploy(1, True, 1.0),
        _deploy(2, False, 1.0),
        _deploy(3, True, 1.0),
        _deploy(4, True, 1.0),
    ]
    m = compute(deps, [], window_days=30)
    assert m.failed_deployments_total == 1
    assert m.change_failure_rate == 0.25
    assert m.levels["change_failure_rate"] == "medium"


def test_lead_time_uses_only_successful_deploys() -> None:
    deps = [_deploy(1, True, 48.0), _deploy(2, True, 96.0), _deploy(3, False, 999.0)]
    m = compute(deps, [], window_days=30)
    assert m.lead_time_hours == 72.0
    assert m.levels["lead_time"] == "high"


def test_mttr_median_ignores_open_incidents() -> None:
    opened = NOW - timedelta(hours=5)
    incidents = [
        Incident("1", opened_at=opened, closed_at=opened + timedelta(hours=2)),
        Incident("2", opened_at=opened, closed_at=opened + timedelta(hours=4)),
        Incident("3", opened_at=opened, closed_at=None),
    ]
    m = compute([], incidents, window_days=30)
    assert m.incidents_total == 3
    assert m.mttr_hours == 3.0
    assert m.levels["mttr"] == "high"


def test_empty_inputs_are_safe() -> None:
    m = compute([], [], window_days=30)
    assert m.deployment_frequency_per_day == 0.0
    assert m.change_failure_rate == 0.0
    assert m.lead_time_hours is None
    assert m.mttr_hours is None


def test_prometheus_render_contains_all_series() -> None:
    m = compute([_deploy(1, True, 2.0)], [], window_days=7)
    text = render_prometheus(m)
    for name in (
        "fourkeys_deployment_frequency_per_day",
        "fourkeys_lead_time_hours",
        "fourkeys_change_failure_rate",
        "fourkeys_mttr_hours",
        "fourkeys_performance_level",
        "fourkeys_data_source",
    ):
        assert name in text
    assert "fourkeys_mttr_hours nan" in text
