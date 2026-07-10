"""grounding バックエンドの起動時検証（ADR-0064 決定6）のテスト。

`REQUIRE_ELASTICSEARCH` 設定時は ES 不通で fail-fast し、未設定時は従来どおり
in-memory 縮退で起動できることを検証する。
"""

from __future__ import annotations

import pytest

from sanba_agent.config import settings
from sanba_agent.main import ensure_grounding_backend


def test_require_elasticsearch_fails_fast_without_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "require_elasticsearch", True)
    with pytest.raises(RuntimeError, match="REQUIRE_ELASTICSEARCH"):
        ensure_grounding_backend()


def test_memory_fallback_allowed_when_not_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "require_elasticsearch", False)
    ensure_grounding_backend()
