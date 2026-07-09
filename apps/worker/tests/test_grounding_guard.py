"""grounding バックエンドの起動時検証（ADR-0063 決定6）のテスト。

`REQUIRE_ELASTICSEARCH` 設定時は ES 不通（in-memory 縮退）で fail-fast し、
未設定時は従来どおり縮退のまま起動できることを検証する。
"""

from __future__ import annotations

import pytest

from sanba_worker.main import ensure_grounding_backend


class _FakeIndexer:
    def __init__(self, *, memory: bool) -> None:
        self.is_memory = memory


def test_required_with_memory_backend_fails_fast() -> None:
    with pytest.raises(RuntimeError, match="REQUIRE_ELASTICSEARCH"):
        ensure_grounding_backend(_FakeIndexer(memory=True), required=True)  # type: ignore[arg-type]


def test_memory_backend_allowed_when_not_required() -> None:
    ensure_grounding_backend(_FakeIndexer(memory=True), required=False)  # type: ignore[arg-type]


def test_es_backend_passes_even_when_required() -> None:
    ensure_grounding_backend(_FakeIndexer(memory=False), required=True)  # type: ignore[arg-type]
