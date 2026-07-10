"""join レートリミットのキー選定とエントリ回収のユニットテスト（SEC-023 / SEC-026）。"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import Request

from sanba_api import deps, main


def _request(
    headers: dict[str, str] | None = None, client_host: str | None = "203.0.113.9"
) -> Request:
    scope: dict[str, Any] = {
        "type": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": (client_host, 12345) if client_host else None,
    }
    return Request(scope)


def test_rate_limit_key_prefers_forwarded_for() -> None:
    req = _request({"x-forwarded-for": "198.51.100.7, 10.0.0.1"})
    assert main._rate_limit_key(req) == "198.51.100.7"


def test_rate_limit_key_falls_back_to_peer_without_forwarded() -> None:
    assert main._rate_limit_key(_request(client_host="203.0.113.5")) == "203.0.113.5"


def test_rate_limit_key_unknown_without_client() -> None:
    assert main._rate_limit_key(_request(client_host=None)) == "unknown"


def test_over_rate_limit_drops_stale_hits(monkeypatch: pytest.MonkeyPatch) -> None:
    deps._join_hits.clear()
    monkeypatch.setattr(deps.settings, "join_rate_per_minute", 5, raising=True)
    deps._join_hits["ip-x"].append(0.0)

    assert deps._over_rate_limit("ip-x") is False
    hits = list(deps._join_hits["ip-x"])
    assert len(hits) == 1
    assert hits[0] > 60


def test_evict_stale_join_hits_removes_expired_keeps_fresh() -> None:
    deps._join_hits.clear()
    deps._join_hits["old"].append(100.0)
    deps._join_hits["fresh"].append(1_000_000.0)

    deps._evict_stale_join_hits(1_000_030.0)

    assert "old" not in deps._join_hits
    assert list(deps._join_hits["fresh"]) == [1_000_000.0]
