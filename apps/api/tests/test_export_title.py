"""起票時のタイトル遅延生成 `_ensure_session_title`（#482）のテスト。

auto-finalize（ADR-0056）で確定したセッションは既定タイトルのまま起票されるため、
起票時に確定要件から標題を遅延生成して本文見出し・Issue 標題へ反映する。生成不可なら
fail-open で既定のまま。Firestore 非接続のメモリ fallback で走る。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sanba_shared.models import DEFAULT_SESSION_TITLE, SessionMeta

from sanba_api.routers import sessions as sess


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    sess._repo._mem_sessions.clear()
    assert sess._repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield


def _seed(sid: str, title: str) -> SessionMeta:
    sess._repo.create_session_doc(
        SessionMeta(
            id=sid,
            title=title,
            owner_sub="sub-1",
            owner_email="sub-1@example.com",
            roles=["pm"],
            created_at=datetime(2026, 7, 10, tzinfo=UTC),
        )
    )
    got = sess._repo.get_session(sid)
    assert got is not None
    return got


def test_generates_title_when_default(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[dict[str, object]]] = []

    def fake_gen(requirements: list[dict[str, object]], **_: object) -> str:
        calls.append(requirements)
        return "在庫アプリの通知要件"

    monkeypatch.setattr(sess, "generate_requirement_title", fake_gen)
    session = _seed("sess-1", DEFAULT_SESSION_TITLE)
    confirmed = [{"status": "confirmed", "statement": "通知を出す"}]

    updated = sess._ensure_session_title(session, confirmed)

    assert updated.title == "在庫アプリの通知要件"
    assert sess._repo.get_session("sess-1").title == "在庫アプリの通知要件"
    assert calls == [confirmed]


def test_keeps_existing_non_default_title(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_gen(*_: object, **__: object) -> str:
        raise AssertionError("既にタイトルがある場合は生成しない")

    monkeypatch.setattr(sess, "generate_requirement_title", fail_gen)
    session = _seed("sess-2", "手で付けたタイトル")

    updated = sess._ensure_session_title(session, [])

    assert updated.title == "手で付けたタイトル"


def test_fails_open_when_generation_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sess, "generate_requirement_title", lambda *_, **__: None)
    session = _seed("sess-3", DEFAULT_SESSION_TITLE)

    updated = sess._ensure_session_title(session, [{"status": "confirmed", "statement": "x"}])

    assert updated.title == DEFAULT_SESSION_TITLE


def test_generates_title_when_default_with_trailing_space(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[dict[str, object]]] = []

    def fake_gen(requirements: list[dict[str, object]], **_: object) -> str:
        calls.append(requirements)
        return "在庫アプリの通知要件"

    monkeypatch.setattr(sess, "generate_requirement_title", fake_gen)
    session = _seed("sess-4", DEFAULT_SESSION_TITLE + " ")
    confirmed = [{"status": "confirmed", "statement": "通知を出す"}]

    updated = sess._ensure_session_title(session, confirmed)

    assert updated.title == "在庫アプリの通知要件"
    assert calls == [confirmed]


def test_fails_open_when_persist_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sess, "generate_requirement_title", lambda *_, **__: "生成タイトル")

    def boom(*_: object, **__: object) -> object:
        raise RuntimeError("firestore down")

    monkeypatch.setattr(sess._repo, "set_session_title", boom)
    session = _seed("sess-5", DEFAULT_SESSION_TITLE)

    updated = sess._ensure_session_title(session, [{"status": "confirmed", "statement": "x"}])

    assert updated.title == DEFAULT_SESSION_TITLE
