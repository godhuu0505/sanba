"""Tests for the data channel publisher (Issue #94).

LiveKit ランタイム無しで、契約 §2/§3 のエンベロープ・種別・seq 単調増加・観測性カウンタを検証する。
"""

from __future__ import annotations

import pytest

from sanba_agent.events import (
    EVENTS_TOPIC,
    EventPublisher,
    RecordingTransport,
    requirement_to_contract,
)
from sanba_agent.models import Priority, Requirement, RequirementCategory

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
    assert pub.detections_published == 2


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
