"""Tests for the data channel publisher (Issue #94).

LiveKit ランタイム無しで、契約 §2/§3 のエンベロープ・種別・seq 単調増加・観測性カウンタを検証する。
"""

from __future__ import annotations

import json

import pytest
from sanba_shared.models import Priority, Requirement, RequirementCategory

from sanba_agent.events import (
    EVENTS_TOPIC,
    EventPublisher,
    RecordingTransport,
    decode_user_selection,
    requirement_to_contract,
)

ENVELOPE_KEYS = {"v", "type", "seq", "ts", "session_id"}


@pytest.mark.asyncio
async def test_envelope_has_required_fields() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    env = await pub.status("listening")
    assert ENVELOPE_KEYS <= set(env)
    assert env["v"] == 1
    assert env["type"] == "status"
    assert env["session_id"] == "s1"
    assert t.sent[0]["topic"] == EVENTS_TOPIC


@pytest.mark.asyncio
async def test_seq_is_monotonic_across_types() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.status("listening")
    await pub.transcript_final("顧客", "customer", "u1", "検索したい")
    await pub.detection_gap("d1", "性能が未確認", "non_functional", [])
    seqs = [m["event"]["seq"] for m in t.sent]
    assert seqs == [1, 2, 3]


@pytest.mark.asyncio
async def test_detection_contradiction_payload() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.detection_contradiction(
        "d1",
        "関連度順と新着順が食い違う",
        refs=["u1", "u2"],
        options=[{"label": "関連度順", "value": "relevance"}],
    )
    ev = t.sent[0]["event"]
    assert ev["type"] == "detection.contradiction"
    assert ev["detector"] == "contradiction_detector"
    assert ev["refs"] == ["u1", "u2"]
    assert ev["options"][0]["value"] == "relevance"
    assert t.sent[0]["reliable"] is True


@pytest.mark.asyncio
async def test_status_is_lossy() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.status("deliberating", agents_active=2)
    assert t.sent[0]["reliable"] is False
    assert t.sent[0]["event"]["agents_active"] == 2


@pytest.mark.asyncio
async def test_requirement_upserted_matches_contract_schema() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    req = Requirement(
        id="req_x",
        statement="キーワード検索を新設する",
        category=RequirementCategory.FUNCTIONAL,
        priority=Priority.MUST,
        source_speaker="顧客",
    )
    await pub.requirement_upserted(req, status="confirmed")
    payload = t.sent[0]["event"]["requirement"]
    assert payload["id"] == "req_x"
    assert payload["category"] == "functional"
    assert payload["priority"] == "must"
    assert payload["status"] == "confirmed"
    assert payload["citations"] == []
    assert pub.requirements_published == 1


@pytest.mark.asyncio
async def test_counters_track_detections() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.detection_gap("d1", "性能が未確認", "non_functional", [])
    await pub.detection_contradiction("d2", "食い違い", refs=[])
    # 種別ごとに分けて計測し、detections_published は合算（後方互換）。
    assert pub.gaps_published == 1
    assert pub.contradictions_published == 1
    assert pub.detections_published == 2


@pytest.mark.asyncio
async def test_resolution_counters_distinguish_user_and_agent() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    # 抜けの自動解消（agent）は contradictions_resolved に数えない。
    await pub.detection_resolved("d1", resolution="agent_resolved")
    # 矛盾カードのユーザー解消のみ contradictions_resolved。
    await pub.detection_resolved("d2", resolution="user_selected", selected_value="relevance")
    assert pub.detections_resolved == 2
    assert pub.contradictions_resolved == 1


@pytest.mark.asyncio
async def test_session_completed_summary_uses_real_counts() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.detection_gap("g1", "抜け1", "non_functional", [])
    await pub.detection_gap("g2", "抜け2", "scope", [])
    await pub.detection_contradiction("c1", "矛盾", refs=[])
    await pub.detection_resolved("c1", resolution="user_selected", selected_value="v")
    await pub.session_completed(
        contradictions_resolved=pub.contradictions_resolved,
        gaps_found=pub.gaps_published,
        issues_created=1,
        artifacts=[{"kind": "issue", "url": "http://x"}],
    )
    summary = t.sent[-1]["event"]["summary"]
    # gaps_found は抜けのみ（矛盾を二重計上しない）、contradictions_resolved は解消済みの矛盾のみ。
    assert summary["gaps_found"] == 2
    assert summary["contradictions_resolved"] == 1


def test_decode_user_selection_valid() -> None:
    payload = json.dumps(
        {
            "v": 1,
            "type": "user.selection",
            "session_id": "s1",
            "detection_id": "d1",
            "selected_value": "relevance",
        }
    ).encode()
    assert decode_user_selection(payload) == ("d1", "relevance")


def test_decode_user_selection_rejects_wrong_type() -> None:
    payload = json.dumps({"type": "status", "detection_id": "d1"}).encode()
    assert decode_user_selection(payload) is None


def test_decode_user_selection_rejects_missing_fields() -> None:
    payload = json.dumps({"type": "user.selection", "detection_id": "d1"}).encode()
    assert decode_user_selection(payload) is None


def test_decode_user_selection_rejects_bad_json() -> None:
    assert decode_user_selection(b"\xff\xfe not json") is None


def test_requirement_to_contract_handles_missing_speaker() -> None:
    req = Requirement(
        id="r1",
        statement="x",
        category=RequirementCategory.SCOPE,
        priority=Priority.SHOULD,
    )
    out = requirement_to_contract(req, "draft")
    assert out["source_speaker"] == ""
    assert out["status"] == "draft"
