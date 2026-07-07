"""Typed events and result for the Four Keys / DORA computation.

Kept dependency-free and pure so the metric maths can be unit-tested without a
network or a running GitHub. This mirrors the "real logic + graceful fallback"
pattern used across the SANBA apps.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class Deployment:
    """One production deployment (a ``deploy.yml`` workflow run)."""

    id: str
    deployed_at: datetime
    success: bool
    lead_time_seconds: float | None = None


@dataclass(frozen=True)
class Incident:
    """A production incident (an issue labelled ``incident``)."""

    id: str
    opened_at: datetime
    closed_at: datetime | None = None

    @property
    def is_resolved(self) -> bool:
        return self.closed_at is not None

    @property
    def recovery_seconds(self) -> float | None:
        if self.closed_at is None:
            return None
        return (self.closed_at - self.opened_at).total_seconds()


@dataclass(frozen=True)
class FourKeys:
    """The four DORA metrics plus the raw counts used to derive them."""

    window_days: float
    deployments_total: int
    failed_deployments_total: int
    incidents_total: int
    deployment_frequency_per_day: float
    lead_time_hours: float | None
    change_failure_rate: float
    mttr_hours: float | None
    source: str = "github"
    levels: dict[str, str] = field(default_factory=dict)
