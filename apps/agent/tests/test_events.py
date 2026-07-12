"""Tests for the data channel publisher.

LiveKit ランタイム無しで、契約 §2/§3 のエンベロープ・種別・seq 単調増加・観測性カウンタを検証する。
"""

from __future__ import annotations

import json

import pytest
from sanba_shared.models import (
    InquiryKind,
    InquiryNode,
    InquiryStatus,
    Priority,
    Requirement,
    RequirementCategory,
)

from sanba_agent.events import (
    EVENTS_TOPIC,
    EventPublisher,
    RecordingTransport,
    decode_analysis_visual,
    decode_user_interrupt,
    decode_user_selection,
    decode_user_text,
    requirement_to_contract,
)

ENVELOPE_KEYS = {"v", "type", "seq", "ts", "session_id"}


def _node(node_id: str = "inq_1", **over: object) -> InquiryNode:
    base: dict[str, object] = {"id": node_id, "kind": InquiryKind.GAP, "text": "性能が未確認"}
    base.update(over)
    return InquiryNode(**base)  # type: ignore[arg-type]


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
async def test_context_progress_is_reliable_with_source_and_stage() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    env = await pub.context_progress(
        "repo", "reused", label="octo/app@main", detail="索引済みを利用"
    )
    assert env["type"] == "context.progress"
    assert env["source"] == "repo"
    assert env["stage"] == "reused"
    assert env["label"] == "octo/app@main"
    assert env["detail"] == "索引済みを利用"
    assert t.sent[0]["reliable"] is True


@pytest.mark.asyncio
async def test_context_progress_omits_empty_optional_fields() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    env = await pub.context_progress("prep", "done")
    assert "label" not in env
    assert "detail" not in env


@pytest.mark.asyncio
async def test_session_end_proposed_carries_counts() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    env = await pub.session_end_proposed(open_count=0, requirement_count=5, material_count=2)
    assert env["type"] == "session.end_proposed"
    assert env["open_count"] == 0
    assert env["requirement_count"] == 5
    assert env["material_count"] == 2
    assert t.sent[0]["reliable"] is True


@pytest.mark.asyncio
async def test_reliable_seq_is_monotonic_and_lossy_does_not_consume_it() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.transcript_final("顧客", "customer", "u1", "検索したい")
    s = await pub.status("listening")
    await pub.inquiry_node(_node(), op="upsert")
    reliable = [m["event"] for m in t.sent if m["event"].get("reliable") is not False]
    assert [e["seq"] for e in reliable] == [1, 2]
    assert s["reliable"] is False
    assert s["seq"] == 1
    assert s["lossy_seq"] == 1


@pytest.mark.asyncio
async def test_lossy_seq_increments_independently() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    a = await pub.status("listening")
    b = await pub.status("deliberating")
    assert a["lossy_seq"] == 1
    assert b["lossy_seq"] == 2
    assert a["seq"] == b["seq"] == 0
    assert pub.seq == 0


@pytest.mark.asyncio
async def test_start_lossy_seq_seeds_lossy_across_restart() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t, start_lossy_seq=1_000_000_000)
    s = await pub.status("listening")
    assert s["lossy_seq"] == 1_000_000_001


@pytest.mark.asyncio
async def test_analysis_progress_is_reliable_with_distinct_seq() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    a = await pub.analysis_progress("a1", 10, "received")
    b = await pub.analysis_progress("a1", 50, "analyzing")
    assert a.get("reliable") is not False
    assert "lossy_seq" not in a
    assert a["seq"] == 1
    assert b["seq"] == 2


@pytest.mark.asyncio
async def test_start_seq_seeds_monotonic_continuation() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t, start_seq=5)
    env = await pub.inquiry_node(_node(), op="upsert")
    assert env["seq"] == 6


@pytest.mark.asyncio
async def test_inquiry_node_upsert_payload_matches_contract() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    node = _node(
        "inq_abc",
        kind=InquiryKind.CONTRADICTION,
        text="関連度順と新着順が食い違う",
        refs=["u1", "u2"],
        confidence=0.8,
        depth=2,
        parent_id="inq_root",
    )
    env = await pub.inquiry_node(node, op="upsert")
    assert env["type"] == "inquiry.node"
    assert env["op"] == "upsert"
    assert t.sent[0]["reliable"] is True
    payload = env["node"]
    assert payload["id"] == "inq_abc"
    assert payload["kind"] == "contradiction"
    assert payload["parent_id"] == "inq_root"
    assert payload["status"] == "open"
    assert payload["refs"] == ["u1", "u2"]
    assert payload["confidence"] == 0.8
    assert payload["depth"] == 2


@pytest.mark.asyncio
async def test_inquiry_node_resolve_and_drop_ops() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    resolved = _node("inq_r", status=InquiryStatus.RESOLVED, resolved_seq=3)
    dropped = _node("inq_d", status=InquiryStatus.DROPPED, resolved_seq=4)
    r_env = await pub.inquiry_node(resolved, op="resolve")
    d_env = await pub.inquiry_node(dropped, op="drop")
    assert r_env["op"] == "resolve"
    assert r_env["node"]["status"] == "resolved"
    assert d_env["op"] == "drop"
    assert d_env["node"]["status"] == "dropped"
    assert [e["event"]["seq"] for e in t.sent] == [1, 2]


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
async def test_requirement_citations_map_to_contract() -> None:
    """citations（根拠発話 id）が契約 §3 の [{kind, ref}] 形へ整形される。"""
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    req = Requirement(
        id="req_y",
        statement="検索結果は1秒以内に返す",
        category=RequirementCategory.NON_FUNCTIONAL,
        citations=["u3", "u5"],
    )
    await pub.requirement_upserted(req, status="confirmed")
    payload = t.sent[0]["event"]["requirement"]
    assert payload["citations"] == [
        {"kind": "utterance", "ref": "u3"},
        {"kind": "utterance", "ref": "u5"},
    ]


@pytest.mark.asyncio
async def test_session_completed_summary_passes_through_counts() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.session_completed(
        contradictions_resolved=1,
        gaps_found=2,
        issues_created=1,
        artifacts=[{"kind": "issue", "url": "http://x"}],
    )
    summary = t.sent[-1]["event"]["summary"]
    assert summary["gaps_found"] == 2
    assert summary["contradictions_resolved"] == 1
    assert summary["issues_created"] == 1


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


def test_decode_user_selection_accepts_matching_session() -> None:
    payload = json.dumps(
        {
            "v": 1,
            "type": "user.selection",
            "session_id": "s1",
            "detection_id": "d1",
            "selected_value": "relevance",
        }
    ).encode()
    assert decode_user_selection(payload, expected_session_id="s1") == ("d1", "relevance")


def test_decode_user_selection_rejects_other_session() -> None:
    """別セッション向け selection の混入を弾く。"""
    payload = json.dumps(
        {
            "v": 1,
            "type": "user.selection",
            "session_id": "s-other",
            "detection_id": "d1",
            "selected_value": "relevance",
        }
    ).encode()
    assert decode_user_selection(payload, expected_session_id="s1") is None


def test_decode_user_text_valid() -> None:
    payload = json.dumps(
        {"v": 1, "type": "user.text", "session_id": "s1", "text": "  新着順で  "}
    ).encode()
    assert decode_user_text(payload) == "新着順で"


def test_decode_user_text_rejects_wrong_type() -> None:
    payload = json.dumps({"type": "user.selection", "text": "x"}).encode()
    assert decode_user_text(payload) is None


def test_decode_user_text_rejects_empty() -> None:
    payload = json.dumps({"type": "user.text", "text": "   "}).encode()
    assert decode_user_text(payload) is None


def test_decode_user_text_rejects_other_session() -> None:
    payload = json.dumps({"type": "user.text", "session_id": "s-other", "text": "x"}).encode()
    assert decode_user_text(payload, expected_session_id="s1") is None


def test_decode_user_text_truncates_oversized_input() -> None:
    from sanba_agent.events import MAX_USER_TEXT_CHARS

    payload = json.dumps({"type": "user.text", "text": "あ" * (MAX_USER_TEXT_CHARS + 500)}).encode()
    decoded = decode_user_text(payload)
    assert decoded is not None
    assert len(decoded) == MAX_USER_TEXT_CHARS


def test_decode_user_interrupt_valid() -> None:
    payload = json.dumps({"v": 1, "type": "user.interrupt", "session_id": "s1"}).encode()
    assert decode_user_interrupt(payload, expected_session_id="s1") is True


def test_decode_user_interrupt_without_expected_session() -> None:
    payload = json.dumps({"v": 1, "type": "user.interrupt", "session_id": "s1"}).encode()
    assert decode_user_interrupt(payload) is True


def test_decode_user_interrupt_rejects_wrong_type() -> None:
    payload = json.dumps({"v": 1, "type": "user.text", "session_id": "s1", "text": "x"}).encode()
    assert decode_user_interrupt(payload, expected_session_id="s1") is False


def test_decode_user_interrupt_rejects_other_session() -> None:
    payload = json.dumps({"v": 1, "type": "user.interrupt", "session_id": "s-other"}).encode()
    assert decode_user_interrupt(payload, expected_session_id="s1") is False


def test_decode_user_interrupt_rejects_bad_json() -> None:
    assert decode_user_interrupt(b"\xff\xfe not json", expected_session_id="s1") is False


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


def _visual_payload(**over: object) -> bytes:
    base = {
        "v": 1,
        "type": "analysis.visual",
        "seq": 1,
        "ts": "2026-07-06T00:00:00Z",
        "session_id": "s1",
        "asset_id": "asset-abc",
        "extracted": ["[00:01] ログイン画面", "[00:05] 保存ボタン"],
        "conflicts": [],
    }
    base.update(over)
    return json.dumps(base).encode()


def test_decode_analysis_visual_valid() -> None:
    got = decode_analysis_visual(_visual_payload(), expected_session_id="s1")
    assert got == ("asset-abc", ["[00:01] ログイン画面", "[00:05] 保存ボタン"])


def test_decode_analysis_visual_rejects_screen_share_echo() -> None:
    assert decode_analysis_visual(_visual_payload(asset_id="visual:1")) is None


def test_decode_analysis_visual_rejects_empty_extracted() -> None:
    assert decode_analysis_visual(_visual_payload(extracted=[])) is None


def test_decode_analysis_visual_rejects_other_session() -> None:
    assert decode_analysis_visual(_visual_payload(), expected_session_id="other") is None


def test_decode_analysis_visual_truncates_observations() -> None:
    many = [f"[00:0{i}] obs{i}" for i in range(30)]
    got = decode_analysis_visual(_visual_payload(extracted=many), expected_session_id="s1")
    assert got is not None and len(got[1]) == 12
