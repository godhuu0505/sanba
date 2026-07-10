"""Collect Four Keys input events from GitHub (stdlib only).

Deployments  := successful/failed runs of the ``deploy.yml`` workflow.
Lead time    := deploy finished_at − shipped commit authored_at.
Incidents    := issues labelled ``incident`` (MTTR + change-failure signal).

If GitHub is unreachable (offline CI, rate limit, no repo) we fall back to a
bundled ``sample_events.json`` so the dashboard always renders. The sample path
is clearly surfaced via the ``source`` field / a Prometheus label so it can
never be mistaken for real production data (no metric hacking).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .models import Deployment, Incident

_API = "https://api.github.com"


def _sample_path() -> Path:
    """Locate the bundled sample, robust to source-tree vs installed layout."""
    candidates = [
        os.getenv("FOURKEYS_SAMPLE"),
        Path(__file__).resolve().parents[2] / "sample_events.json",
        Path.cwd() / "sample_events.json",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return Path(c)
    return Path(__file__).resolve().parents[2] / "sample_events.json"


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _get(url: str, token: str | None) -> dict | list:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "sanba-fourkeys",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)  # noqa: S310 - fixed https host
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
        return json.load(resp)


def _deployments_from_runs(runs: list[dict]) -> list[Deployment]:
    deployments: list[Deployment] = []
    for run in runs:
        if run.get("status") != "completed":
            continue
        conclusion = run.get("conclusion")
        if conclusion not in ("success", "failure"):
            continue
        finished = _parse_ts(run.get("updated_at"))
        if finished is None:
            continue
        commit_ts = _parse_ts((run.get("head_commit") or {}).get("timestamp"))
        lead = (finished - commit_ts).total_seconds() if commit_ts else None
        deployments.append(
            Deployment(
                id=str(run.get("id")),
                deployed_at=finished,
                success=conclusion == "success",
                lead_time_seconds=lead,
            )
        )
    return deployments


def _incidents_from_issues(issues: list[dict]) -> list[Incident]:
    incidents: list[Incident] = []
    for issue in issues:
        if "pull_request" in issue:
            continue
        opened = _parse_ts(issue.get("created_at"))
        if opened is None:
            continue
        incidents.append(
            Incident(
                id=str(issue.get("number")),
                opened_at=opened,
                closed_at=_parse_ts(issue.get("closed_at")),
            )
        )
    return incidents


def _load_sample() -> tuple[list[Deployment], list[Incident]]:
    raw = json.loads(_sample_path().read_text(encoding="utf-8"))
    deployments = [
        Deployment(
            id=d["id"],
            deployed_at=_parse_ts(d["deployed_at"]),  # type: ignore[arg-type]
            success=d["success"],
            lead_time_seconds=d.get("lead_time_seconds"),
        )
        for d in raw.get("deployments", [])
    ]
    incidents = [
        Incident(
            id=i["id"],
            opened_at=_parse_ts(i["opened_at"]),  # type: ignore[arg-type]
            closed_at=_parse_ts(i.get("closed_at")),
        )
        for i in raw.get("incidents", [])
    ]
    return deployments, incidents


def _within_window(
    deployments: list[Deployment], incidents: list[Incident], window_days: float
) -> tuple[list[Deployment], list[Incident]]:
    cutoff = datetime.now(UTC) - timedelta(days=window_days)
    deps = [d for d in deployments if d.deployed_at is not None and d.deployed_at >= cutoff]
    incs = [i for i in incidents if i.opened_at is not None and i.opened_at >= cutoff]
    return deps, incs


def collect(
    repo: str | None = None,
    token: str | None = None,
    workflow: str = "deploy.yml",
    window_days: float = 30.0,
) -> tuple[list[Deployment], list[Incident], str]:
    """Return (deployments, incidents, source) within ``window_days``.

    ``source`` is ``"github"`` for live data or ``"sample"`` for the bundled
    fallback, so callers can label the data provenance honestly.
    """

    repo = repo or os.getenv("GITHUB_REPOSITORY")
    token = token or os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if not repo:
        deployments, incidents = _load_sample()
        source = "sample"
    else:
        try:
            runs_payload = _get(
                f"{_API}/repos/{repo}/actions/workflows/{workflow}/runs?per_page=100",
                token,
            )
            issues_payload = _get(
                f"{_API}/repos/{repo}/issues?labels=incident&state=all&per_page=100",
                token,
            )
            runs = runs_payload.get("workflow_runs", []) if isinstance(runs_payload, dict) else []
            issues = issues_payload if isinstance(issues_payload, list) else []
            deployments = _deployments_from_runs(runs)
            incidents = _incidents_from_issues(issues)
            if deployments or incidents:
                source = "github"
            else:
                deployments, incidents = _load_sample()
                source = "sample"
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError, OSError):
            deployments, incidents = _load_sample()
            source = "sample"

    deployments, incidents = _within_window(deployments, incidents, window_days)
    return deployments, incidents, source
