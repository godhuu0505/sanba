"""Render Four Keys as Prometheus exposition text and serve them over HTTP."""

from __future__ import annotations

import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .dora import compute
from .github_source import collect
from .models import FourKeys

_LEVELS = ("elite", "high", "medium", "low", "unknown")


def _line(name: str, value: float, labels: str = "") -> str:
    return f"{name}{labels} {value}"


def render_prometheus(m: FourKeys) -> str:
    """Format a ``FourKeys`` as Prometheus text exposition (v0.0.4)."""

    out: list[str] = []

    def metric(name: str, help_text: str, mtype: str, value: float | None) -> None:
        out.append(f"# HELP {name} {help_text}")
        out.append(f"# TYPE {name} {mtype}")
        out.append(_line(name, value if value is not None else float("nan")))

    metric(
        "fourkeys_deployment_frequency_per_day",
        "Successful + failed production deployments per day (DORA).",
        "gauge",
        m.deployment_frequency_per_day,
    )
    metric(
        "fourkeys_lead_time_hours",
        "Median lead time for changes, commit authored -> deploy finished (hours).",
        "gauge",
        m.lead_time_hours,
    )
    metric(
        "fourkeys_change_failure_rate",
        "Failed deployments / total deployments (0..1).",
        "gauge",
        m.change_failure_rate,
    )
    metric(
        "fourkeys_mttr_hours",
        "Median time to restore service, incident opened -> closed (hours).",
        "gauge",
        m.mttr_hours,
    )
    metric("fourkeys_deployments_total", "Deployments in window.", "gauge", m.deployments_total)
    metric(
        "fourkeys_failed_deployments_total",
        "Failed deployments in window.",
        "gauge",
        m.failed_deployments_total,
    )
    metric("fourkeys_incidents_total", "Incidents in window.", "gauge", m.incidents_total)
    metric("fourkeys_window_days", "Measurement window in days.", "gauge", m.window_days)
    metric(
        "fourkeys_last_collection_timestamp_seconds",
        "Unix time of the last successful collection.",
        "gauge",
        time.time(),
    )

    out.append("# HELP fourkeys_data_source Active data source (1 = active).")
    out.append("# TYPE fourkeys_data_source gauge")
    for src in ("github", "sample"):
        active = 1 if m.source == src else 0
        out.append(_line("fourkeys_data_source", active, f'{{source="{src}"}}'))

    out.append("# HELP fourkeys_performance_level DORA band per metric (1 = active).")
    out.append("# TYPE fourkeys_performance_level gauge")
    for metric_name, active_level in m.levels.items():
        for level in _LEVELS:
            labels = f'{{metric="{metric_name}",level="{level}"}}'
            hit = 1 if active_level == level else 0
            out.append(_line("fourkeys_performance_level", hit, labels))

    return "\n".join(out) + "\n"


def snapshot(window_days: float = 30.0) -> FourKeys:
    deployments, incidents, source = collect(window_days=window_days)
    return compute(deployments, incidents, window_days=window_days, source=source)


def serve(port: int = 9301, window_days: float = 30.0) -> None:
    """Expose ``/metrics`` for Prometheus to scrape. Recomputes per scrape."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if self.path not in ("/metrics", "/"):
                self.send_error(404)
                return
            body = render_prometheus(snapshot(window_days)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            return

    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)  # noqa: S104 - container service
    httpd.serve_forever()
