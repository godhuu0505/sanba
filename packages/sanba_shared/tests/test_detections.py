"""Tests for detection/seq persistence (Issue #94/#100 — Codex review).

Firestore 無しのメモリモードで、検知の保存・解消・seq 永続化を検証する。
これにより GET /detections?open=1 のハイドレーションとリロード復元が成立する。
"""

from __future__ import annotations

from sanba_shared.models import Utterance
from sanba_shared.repository import SessionRepository


def _mem_repo() -> SessionRepository:
    repo = SessionRepository()
    repo._client = None  # force in-memory path
    return repo


def test_add_utterance_masks_pii_before_persist() -> None:
    """発話は永続化前に PII マスキングされる（issue #10 / mask_pii_before_index）。"""
    repo = _mem_repo()
    repo.add_utterance("s1", Utterance(speaker="participant", text="連絡は bob@example.com まで"))
    stored = repo._mem_utterances["s1"][0]
    assert "bob@example.com" not in stored.text
    assert "[EMAIL]" in stored.text


def test_save_and_resolve_detection() -> None:
    repo = _mem_repo()
    repo.save_detection("s1", {"id": "d1", "kind": "gap", "summary": "x", "resolved": False})
    assert repo._mem_detections["s1"]["d1"]["resolved"] is False

    repo.resolve_detection("s1", "d1", "agent_resolved")
    assert repo._mem_detections["s1"]["d1"]["resolved"] is True
    assert repo._mem_detections["s1"]["d1"]["resolution"] == "agent_resolved"


def test_save_detection_upserts_by_id() -> None:
    repo = _mem_repo()
    repo.save_detection("s1", {"id": "d1", "summary": "first", "resolved": False})
    repo.save_detection("s1", {"id": "d1", "summary": "second", "resolved": False})
    assert repo._mem_detections["s1"]["d1"]["summary"] == "second"


def test_set_session_seq() -> None:
    repo = _mem_repo()
    repo.set_session_seq("s1", 7)
    assert repo._mem_seq["s1"] == 7


def test_save_and_list_materials() -> None:
    # 素材メタを永続化し、GET /context/files の復元に使える（#184・Codex P1）。
    repo = _mem_repo()
    repo.save_material("s1", {"id": "a1", "name": "mock.png", "kind": "image", "status": "done"})
    repo.save_material(
        "s1", {"id": "a2", "name": "rec.mp4", "kind": "video", "status": "analyzing"}
    )
    items = repo.list_materials("s1")
    assert {m["id"] for m in items} == {"a1", "a2"}
    assert next(m for m in items if m["id"] == "a1")["name"] == "mock.png"


def test_save_material_upserts_by_id() -> None:
    repo = _mem_repo()
    repo.save_material(
        "s1", {"id": "a1", "name": "mock.png", "kind": "image", "status": "analyzing"}
    )
    repo.save_material("s1", {"id": "a1", "name": "mock.png", "kind": "image", "status": "done"})
    items = repo.list_materials("s1")
    assert len(items) == 1
    assert items[0]["status"] == "done"
