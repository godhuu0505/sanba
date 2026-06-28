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


# ── 現在質問の保存/クリア（#212 / ADR-0020）──────────────────────────────────
def test_save_current_question_stores_pointer_with_asked_seq() -> None:
    repo = _mem_repo()
    repo.save_current_question(
        "s1",
        {"id": "q1", "prompt": "並び順は？", "options": [{"label": "A", "value": "A"}]},
        asked_seq=5,
    )
    doc = repo._mem_questions["s1"]
    assert doc["id"] == "q1"
    assert doc["asked_seq"] == 5
    assert doc["cleared"] is False
    assert doc["prompt"] == "並び順は？"


def test_save_current_question_overwrites_previous_pointer() -> None:
    # 最新1問モデル: 後の ask が前のポインタ（tombstone 含む）を全置換する。
    repo = _mem_repo()
    repo.save_current_question("s1", {"id": "q1", "prompt": "p1"}, asked_seq=1)
    repo.clear_current_question("s1", "q1", cleared_seq=2)
    repo.save_current_question("s1", {"id": "q2", "prompt": "p2"}, asked_seq=3)
    doc = repo._mem_questions["s1"]
    assert doc["id"] == "q2"
    assert doc["cleared"] is False
    assert "cleared_seq" not in doc  # 前 tombstone の cleared_seq を引き継がない


def test_clear_current_question_only_when_id_matches() -> None:
    # §5-3: 現在質問 id == question_id のときだけクリア（古い回答で新しい問いを消さない）。
    repo = _mem_repo()
    repo.save_current_question("s1", {"id": "q2", "prompt": "p2"}, asked_seq=7)
    # 古い q1 の回答が遅れて届いても、current が q2 なのでクリアしない。
    assert repo.clear_current_question("s1", "q1", cleared_seq=8) is False
    assert repo._mem_questions["s1"]["id"] == "q2"
    assert repo._mem_questions["s1"]["cleared"] is False


def test_clear_current_question_tombstones_and_masks_pii() -> None:
    # §5-9: 物理削除せず tombstone 化。prompt/options（PII を含みうる）は消し cleared_seq を残す。
    repo = _mem_repo()
    repo.save_current_question(
        "s1",
        {"id": "q1", "prompt": "氏名は？", "options": [{"label": "x", "value": "x"}]},
        asked_seq=4,
    )
    assert repo.clear_current_question("s1", "q1", cleared_seq=6) is True
    doc = repo._mem_questions["s1"]
    assert doc["cleared"] is True
    assert doc["cleared_seq"] == 6
    assert "prompt" not in doc  # PII を残さない
    assert "options" not in doc


def test_clear_current_question_is_idempotent() -> None:
    # 既クリア（tombstone）への再クリアは no-op で False（並行回答/再送に強い）。
    repo = _mem_repo()
    repo.save_current_question("s1", {"id": "q1", "prompt": "p"}, asked_seq=1)
    assert repo.clear_current_question("s1", "q1", cleared_seq=2) is True
    assert repo.clear_current_question("s1", "q1", cleared_seq=3) is False
    assert repo._mem_questions["s1"]["cleared_seq"] == 2  # 最初のクリア seq を保つ


def test_clear_current_question_missing_returns_false() -> None:
    repo = _mem_repo()
    assert repo.clear_current_question("s1", "q1", cleared_seq=2) is False
