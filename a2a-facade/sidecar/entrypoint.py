"""HolmesGPT sidecar の起動ラッパ（ADR-0069 Phase 1'）。

Cloud Run の env / Secret Manager から HolmesGPT の config.yaml を生成してから server を
起動する。有効化するツールセットは read-only の elasticsearch/data のみで、シェル実行系・
kubernetes 系は明示 OFF（ADR-0069 決定3）。config はコンテナ内 tmpfs にのみ書き、イメージには
シークレットを焼き込まない。
"""

from __future__ import annotations

import os
import pathlib

import yaml

DISABLED_TOOLSETS = [
    "bash",
    "connectivity_check",
    "docker/core",
    "helm/core",
    "internet",
    "kubectl-run",
    "kubernetes/core",
    "kubernetes/kube-prometheus-stack",
    "kubernetes/live-metrics",
    "kubernetes/logs",
]


def build_mcp_servers() -> dict:
    servers: dict[str, dict] = {}
    gcp_url = os.environ.get("GCP_OBS_MCP_URL", "")
    if gcp_url:
        servers["gcp_observability"] = {
            "description": "SANBA 本番 (sanba-prd) の Cloud Logging / Monitoring / Trace read-only",
            "url": gcp_url,
            "mode": "streamable-http",
        }
    firestore_url = os.environ.get("FIRESTORE_MCP_URL", "")
    if firestore_url:
        servers["firestore"] = {
            "description": "SANBA 本番 (sanba-prd) の Firestore read-only",
            "url": firestore_url,
            "mode": "streamable-http",
        }
    return servers


def build_config() -> dict:
    toolsets: dict[str, dict] = {name: {"enabled": False} for name in DISABLED_TOOLSETS}
    toolsets["elasticsearch/data"] = {
        "enabled": True,
        "config": {
            "api_url": os.environ["ES_API_URL"],
            "api_key": os.environ["ES_API_KEY"],
        },
    }
    config: dict = {
        "model": os.environ.get("HOLMES_MODEL", "vertex_ai/gemini-2.5-pro"),
        "toolsets": toolsets,
    }
    mcp_servers = build_mcp_servers()
    if mcp_servers:
        config["mcp_servers"] = mcp_servers
    return config


def main() -> None:
    home = pathlib.Path(os.environ.get("HOME", "/tmp/holmes-home"))
    config_dir = pathlib.Path(os.environ.get("HOLMES_CONFIGPATH_DIR", str(home / ".holmes")))
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.yaml"
    config_path.write_text(yaml.safe_dump(build_config(), allow_unicode=True))
    config_path.chmod(0o600)
    os.execvp("python", ["python", "/app/server.py"])


if __name__ == "__main__":
    main()
