"""Tests for context ingestion (issue #6)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth import create_session_token
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.ingestion import ContextIndexer, chunk_text, extract_text_from_upload
from sanba_api.main import app

client = TestClient(app)


def _session_auth(session_id: str, role: str = "pm") -> dict[str, str]:
    """context 投稿は join 済みトークン必須（契約 §4）。テスト用の Bearer を作る。"""
    token = create_session_token(
        session_id, "owner-123456789", role, settings.session_signing_secret, 3600
    )
    return {"Authorization": f"Bearer {token}"}


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


# ── grounding 索引の取消（#245 真の破棄）────────────────────────────────────
def test_delete_context_removes_only_matching_source() -> None:
    """出所接頭辞 `asset:{id}` の chunk だけを消し、他 source/他セッションは残す。"""
    indexer = ContextIndexer()
    indexer.index_context("sess-1", ["o1", "o2"], "asset:asset-aaa")
    indexer.index_context("sess-1", ["k1"], "asset:asset-bbb")
    indexer.index_context("sess-1", ["t1"], "prd.md")
    indexer.index_context("sess-2", ["x1"], "asset:asset-aaa")  # 別セッションは無関係。

    removed = indexer.delete_context("sess-1", "asset:asset-aaa")
    assert removed == 2

    remaining = {(d["session_id"], d["source"]) for d in indexer._mem}
    # 対象セッションの asset-aaa#* は消える。
    assert ("sess-1", "asset:asset-aaa#0") not in remaining
    assert ("sess-1", "asset:asset-aaa#1") not in remaining
    # 別 asset・別 source・別セッションは残る（巻き込まない）。
    assert ("sess-1", "asset:asset-bbb#0") in remaining
    assert ("sess-1", "prd.md#0") in remaining
    assert ("sess-2", "asset:asset-aaa#0") in remaining


def test_delete_context_is_idempotent_when_absent() -> None:
    """存在しない出所の取消は 0 件で安全（冪等）。"""
    indexer = ContextIndexer()
    indexer.index_context("sess-1", ["o1"], "asset:asset-aaa")
    assert indexer.delete_context("sess-1", "asset:asset-zzz") == 0
    assert indexer.delete_context("sess-1", "asset:asset-aaa") == 1
    assert indexer.delete_context("sess-1", "asset:asset-aaa") == 0


def test_context_endpoint_indexes_text() -> None:
    created = client.post(
        "/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True}
    ).json()
    sid = created["session_id"]
    res = client.post(
        f"/api/sessions/{sid}/context",
        json={"text": "要約機能が必要。\n\n対象は社内ユーザー。", "source_name": "prd.md"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    assert res.json()["indexed_chunks"] >= 1


def test_context_endpoint_requires_session_token() -> None:
    """匿名での RAG グラウンディング汚染を防ぐ（join 済みトークン必須）。"""
    res = client.post(
        "/api/sessions/sess-anon/context",
        json={"text": "注入テキスト", "source_name": "x"},
    )
    assert res.status_code == 401


def test_context_endpoint_rejects_token_for_other_session() -> None:
    """別セッションのトークンでは投稿できない（session_id 不一致）。"""
    res = client.post(
        "/api/sessions/sess-target/context",
        json={"text": "注入テキスト", "source_name": "x"},
        headers=_session_auth("sess-OTHER"),
    )
    assert res.status_code == 403


def test_context_endpoint_rejects_oversized() -> None:
    created = client.post(
        "/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True}
    ).json()
    sid = created["session_id"]
    res = client.post(
        f"/api/sessions/{sid}/context",
        json={"text": "x" * 200_001, "source_name": "big.txt"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 413
