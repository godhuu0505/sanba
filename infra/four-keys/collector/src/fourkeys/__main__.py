"""CLI: ``serve`` (Prometheus endpoint) or ``collect`` (one-shot stdout)."""

from __future__ import annotations

import argparse
import json
import os

from .exporter import render_prometheus, serve, snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fourkeys", description="SANBA Four Keys collector")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_serve = sub.add_parser("serve", help="serve /metrics for Prometheus")
    p_serve.add_argument("--port", type=int, default=int(os.getenv("FOURKEYS_PORT", "9301")))
    p_serve.add_argument("--window-days", type=float, default=30.0)

    p_collect = sub.add_parser("collect", help="print metrics once and exit")
    p_collect.add_argument("--json", action="store_true", help="emit JSON instead of Prometheus")
    p_collect.add_argument("--window-days", type=float, default=30.0)

    args = parser.parse_args(argv)

    if args.cmd == "serve":
        print(f"fourkeys: serving /metrics on :{args.port} (window={args.window_days}d)")
        serve(port=args.port, window_days=args.window_days)
        return 0

    m = snapshot(args.window_days)
    if args.json:
        print(
            json.dumps(
                {
                    "window_days": m.window_days,
                    "source": m.source,
                    "deployments_total": m.deployments_total,
                    "failed_deployments_total": m.failed_deployments_total,
                    "incidents_total": m.incidents_total,
                    "deployment_frequency_per_day": m.deployment_frequency_per_day,
                    "lead_time_hours": m.lead_time_hours,
                    "change_failure_rate": m.change_failure_rate,
                    "mttr_hours": m.mttr_hours,
                    "levels": m.levels,
                },
                indent=2,
            )
        )
    else:
        print(render_prometheus(m), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
