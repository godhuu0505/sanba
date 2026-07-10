"""Tests for detection/seq persistence.

Firestore 無しのメモリモードで、検知の保存・解消・seq 永続化を検証する。
これにより GET /detections?open=1 のハイドレーションとリロード復元が成立する。
"""

from __future__ import annotations

from sanba_shared.models import (
    InquiryKind,
    InquiryNode,
    Requirement,
    RequirementCategory,
    Utterance,
)
from sanba_shared.repository import SessionRepository


def _mem_repo() -> SessionRepository:
    repo = SessionRepository()
    repo._client = None
    return repo


def test_add_utterance_masks_pii_before_persist() -> None:
    """発話は永続化前に PII マスキングされる。"""
    repo = _mem_repo()
    repo.add_utterance("s1", Utterance(speaker="participant", text="連絡は bob@example.com まで"))
    stored = repo._mem_utterances["s1"][0]
    assert "bob@example.com" not in stored.text
    assert "[EMAIL]" in stored.text


def test_save_requirement_masks_pii_statement() -> None:
    repo = _mem_repo()
    repo.save_requirement(
        "s1",
        Requirement(
            id="r1",
            category=RequirementCategory.FUNCTIONAL,
            statement="連絡先は bob@example.com にする",
        ),
    )
    stored = repo._mem_requirements["s1"]["r1"]
    assert "bob@example.com" not in stored.statement
    assert "[EMAIL]" in stored.statement


def test_save_inquiry_node_masks_pii_text() -> None:
    repo = _mem_repo()
    repo.save_inquiry_node(
        "s1", InquiryNode(id="n1", kind=InquiryKind.CHECK, text="連絡は bob@example.com か確認")
    )
    stored = repo.list_inquiry_nodes("s1")[0]
    assert "bob@example.com" not in stored.text
    assert "[EMAIL]" in stored.text


def test_save_material_masks_extracted_texts() -> None:
    repo = _mem_repo()
    repo.save_material(
        "s1",
        {"id": "asset-1", "status": "done", "extracted_texts": ["連絡は bob@example.com"]},
    )
    stored = repo._mem_materials["s1"]["asset-1"]
    assert stored["extracted_texts"] == ["連絡は [EMAIL]"]


def test_save_current_question_masks_prompt_and_options() -> None:
    repo = _mem_repo()
    repo.save_current_question(
        "s1",
        {
            "id": "q1",
            "prompt": "連絡先 bob@example.com で合っていますか",
            "options": [{"label": "bob@example.com", "value": "bob@example.com"}],
        },
        asked_seq=1,
    )
    doc = repo._mem_questions["s1"]
    assert "bob@example.com" not in doc["prompt"]
    assert "[EMAIL]" in doc["prompt"]
    assert doc["options"][0]["label"] == "[EMAIL]"
    assert doc["options"][0]["value"] == "[EMAIL]"


def test_save_detection_masks_summary() -> None:
    repo = _mem_repo()
    repo.save_detection("s1", {"id": "d1", "summary": "連絡は bob@example.com", "resolved": False})
    stored = repo._mem_detections["s1"]["d1"]
    assert "bob@example.com" not in stored["summary"]
    assert "[EMAIL]" in stored["summary"]


def test_persistence_masking_can_be_disabled() -> None:
    repo = SessionRepository(mask_pii_before_persist=False)
    repo._client = None
    repo.save_requirement(
        "s1",
        Requirement(
            id="r1", category=RequirementCategory.FUNCTIONAL, statement="連絡先は bob@example.com"
        ),
    )
    assert "bob@example.com" in repo._mem_requirements["s1"]["r1"].statement


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


def test_get_session_seq_roundtrip_and_default() -> None:
    repo = _mem_repo()
    assert repo.get_session_seq("unknown") == 0
    repo.set_session_seq("s1", 12)
    assert repo.get_session_seq("s1") == 12


def test_reserve_session_seq_allocates_monotonic_intervals() -> None:
    repo = _mem_repo()
    assert repo.reserve_session_seq("s1") == 1
    assert repo.reserve_session_seq("s1") == 2
    assert repo.reserve_session_seq("s1", count=3) == 3
    assert repo.get_session_seq("s1") == 5
    assert repo.reserve_session_seq("s1") == 6


def test_reserve_session_seq_continues_from_persisted_last_seq() -> None:
    repo = _mem_repo()
    repo.set_session_seq("s1", 10)
    assert repo.reserve_session_seq("s1") == 11


def test_reserve_lossy_seq_base_increments_per_startup() -> None:
    repo = _mem_repo()
    block = repo.LOSSY_EPOCH_BLOCK
    first = repo.reserve_lossy_seq_base("s1")
    second = repo.reserve_lossy_seq_base("s1")
    assert first == block
    assert second == 2 * block
    assert first + (block - 1) < second
    assert repo.reserve_lossy_seq_base("s2") == block


def test_get_startup_seq_returns_max_of_last_seq_and_question_seq() -> None:
    repo = _mem_repo()

    repo.set_session_seq("s1", 3)
    assert repo.get_startup_seq("s1") == 3

    repo.save_current_question("s1", {"id": "q1", "prompt": "p", "options": []}, asked_seq=5)
    assert repo.get_startup_seq("s1") == 5

    repo.set_session_seq("s1", 7)
    assert repo.get_startup_seq("s1") == 7

    repo.clear_current_question("s1", "q1", cleared_seq=9)
    assert repo.get_startup_seq("s1") == 9

    assert repo.get_startup_seq("s2") == 0


def test_save_and_list_materials() -> None:
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
    repo = _mem_repo()
    repo.save_current_question("s1", {"id": "q1", "prompt": "p1"}, asked_seq=1)
    repo.clear_current_question("s1", "q1", cleared_seq=2)
    repo.save_current_question("s1", {"id": "q2", "prompt": "p2"}, asked_seq=3)
    doc = repo._mem_questions["s1"]
    assert doc["id"] == "q2"
    assert doc["cleared"] is False
    assert "cleared_seq" not in doc


def test_clear_current_question_only_when_id_matches() -> None:
    repo = _mem_repo()
    repo.save_current_question("s1", {"id": "q2", "prompt": "p2"}, asked_seq=7)
    assert repo.clear_current_question("s1", "q1", cleared_seq=8) is False
    assert repo._mem_questions["s1"]["id"] == "q2"
    assert repo._mem_questions["s1"]["cleared"] is False


def test_clear_current_question_tombstones_and_masks_pii() -> None:
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
    assert "prompt" not in doc
    assert "options" not in doc


def test_clear_current_question_is_idempotent() -> None:
    repo = _mem_repo()
    repo.save_current_question("s1", {"id": "q1", "prompt": "p"}, asked_seq=1)
    assert repo.clear_current_question("s1", "q1", cleared_seq=2) is True
    assert repo.clear_current_question("s1", "q1", cleared_seq=3) is False
    assert repo._mem_questions["s1"]["cleared_seq"] == 2


def test_clear_current_question_missing_returns_false() -> None:
    repo = _mem_repo()
    assert repo.clear_current_question("s1", "q1", cleared_seq=2) is False
