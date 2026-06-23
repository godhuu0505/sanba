"""Tests for context ingestion (issue #6)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth_google import AuthUser, require_user
from sanba_api.ingestion import ContextIndexer, chunk_text, extract_text_from_upload
from sanba_api.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    """セッション作成に必要な検証済みユーザーをスタブする (ADR-0012)。"""
    app.dependency_overrides[require_user] = lambda: AuthUser(
        sub="owner-123456789", email="owner@example.com", email_verified=True, name="Owner"
    )
    yield
    app.dependency_overrides.pop(require_user, None)


def test_chunk_text_splits_on_paragraphs() -> None:
    text = "段落1の内容。\n\n段落2の内容。\n\n段落3の内容。"
    chunks = chunk_text(text, chunk_size=20)
    assert len(chunks) >= 2
    assert all(c.strip() for c in chunks)


def test_chunk_text_empty_returns_empty() -> None:
    assert chunk_text("   ") == []


def test_long_paragraph_is_windowed() -> None:
    chunks = chunk_text("あ" * 1000, chunk_size=300, overlap=50)
    assert len(chunks) > 1


def test_extract_text_from_txt_upload() -> None:
    assert extract_text_from_upload("notes.md", "# 見出し\n本文".encode()) == "# 見出し\n本文"


def test_memory_indexer_counts_chunks() -> None:
    indexer = ContextIndexer()
    assert indexer.is_memory is True
    n = indexer.index_context("sess-1", ["a", "b", "c"], "spec.md")
    assert n == 3


def test_context_endpoint_indexes_text() -> None:
    created = client.post(
        "/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True}
    ).json()
    sid = created["session_id"]
    res = client.post(
        f"/api/sessions/{sid}/context",
        json={"text": "要約機能が必要。\n\n対象は社内ユーザー。", "source_name": "prd.md"},
    )
    assert res.status_code == 200
    assert res.json()["indexed_chunks"] >= 1


def test_context_endpoint_rejects_oversized() -> None:
    created = client.post(
        "/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True}
    ).json()
    sid = created["session_id"]
    res = client.post(
        f"/api/sessions/{sid}/context",
        json={"text": "x" * 200_001, "source_name": "big.txt"},
    )
    assert res.status_code == 413
