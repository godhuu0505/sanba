"""Tests for the data channel publisher.

LiveKit ランタイム無しで、契約 §2/§3 のエンベロープ・種別・seq 単調増加・観測性カウンタを検証する。
"""

from __future__ import annotations

import json

import pytest
from sanba_shared.models import Priority, Requirement, RequirementCategory

from sanba_agent.events import (
    EVENTS_TOPIC,
    DataTransport,
    EventPublisher,
    EventPublishError,
    RecordingTransport,
    decode_analysis_visual,
    decode_user_answered,
    decode_user_selection,
    decode_user_text,
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
async def test_reliable_seq_is_monotonic_and_lossy_does_not_consume_it() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.transcript_final("顧客", "customer", "u1", "検索したい")
    s = await pub.status("listening")
    await pub.detection_gap("d1", "性能が未確認", "non_functional", [])
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
    env = await pub.detection_gap("d1", "性能が未確認", "non_functional", [])
    assert env["seq"] == 6


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
async def test_detection_ambiguous_payload() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.detection_ambiguous("d9", "並び順の意図が不明瞭", refs=["u3"])
    ev = t.sent[0]["event"]
    assert ev["type"] == "detection.ambiguous"
    assert ev["detector"] == "ambiguity_detector"
    assert ev["refs"] == ["u3"]
    assert "category" not in ev
    assert t.sent[0]["reliable"] is True
    assert pub.ambiguous_published == 1
    assert pub.detections_published == 1


@pytest.mark.asyncio
async def test_question_asked_payload() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.question_asked(
        "q1",
        "並び順は何を既定にしますか",
        options=[{"label": "関連度順", "value": "関連度順"}],
    )
    ev = t.sent[0]["event"]
    assert ev["type"] == "question.asked"
    assert ev["id"] == "q1"
    assert ev["prompt"].startswith("並び順")
    assert ev["options"][0]["label"] == "関連度順"
    assert t.sent[0]["reliable"] is True
    assert pub.questions_published == 1


@pytest.mark.asyncio
async def test_question_asked_persists_before_send() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    order: list[str] = []
    seen_seq: list[int] = []

    def on_persist(seq: int) -> None:
        seen_seq.append(seq)
        order.append("persist")

    orig_send = t.send

    async def tracking_send(payload: bytes, *, topic: str, reliable: bool) -> None:
        order.append("send")
        await orig_send(payload, topic=topic, reliable=reliable)

    t.send = tracking_send  # type: ignore[method-assign]
    env = await pub.question_asked("q1", "並び順は？", on_persist=on_persist)
    assert order == ["persist", "send"]
    assert env is not None
    assert seen_seq == [env["seq"]]
    assert pub.questions_published == 1


@pytest.mark.asyncio
async def test_question_asked_save_failure_does_not_send_or_consume_seq() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)

    def failing_persist(seq: int) -> None:
        raise RuntimeError("firestore down")

    with pytest.raises(RuntimeError):
        await pub.question_asked("q1", "p", on_persist=failing_persist)
    assert t.sent == []
    assert pub.seq == 0
    assert pub.questions_published == 0
    env = await pub.detection_gap("d1", "性能が未確認", "non_functional", [])
    assert env["seq"] == 1


@pytest.mark.asyncio
async def test_question_cleared_uses_envelope_seq_and_persists_first() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    order: list[str] = []
    persisted_seq: list[int] = []

    def on_persist(cleared_seq: int) -> bool:
        persisted_seq.append(cleared_seq)
        order.append("persist")
        return True

    orig_send = t.send

    async def tracking_send(payload: bytes, *, topic: str, reliable: bool) -> None:
        order.append("send")
        await orig_send(payload, topic=topic, reliable=reliable)

    t.send = tracking_send  # type: ignore[method-assign]
    env = await pub.question_cleared("q1", on_persist=on_persist)
    assert env is not None
    assert env["type"] == "question.cleared"
    assert env["question_id"] == "q1"
    assert order == ["persist", "send"]
    assert persisted_seq == [env["seq"]]
    assert pub.questions_cleared == 1


@pytest.mark.asyncio
async def test_question_cleared_aborts_when_cas_rejects() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)

    def on_persist(cleared_seq: int) -> bool:
        return False

    env = await pub.question_cleared("q1", on_persist=on_persist)
    assert env is None
    assert t.sent == []
    assert pub.seq == 0
    assert pub.questions_cleared == 0


@pytest.mark.asyncio
async def test_question_cleared_raises_when_publish_fails_after_commit() -> None:
    class FailingTransport:
        async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
            raise RuntimeError("network down")

    transport: DataTransport = FailingTransport()
    pub = EventPublisher("s1", transport)
    committed: list[int] = []

    def on_persist(cleared_seq: int) -> bool:
        committed.append(cleared_seq)
        return True

    with pytest.raises(EventPublishError):
        await pub.question_cleared("q1", on_persist=on_persist)
    assert committed == [1]
    assert pub.seq == 1


@pytest.mark.asyncio
async def test_question_asked_without_options() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.question_asked("q2", "自由にお聞かせください")
    ev = t.sent[0]["event"]
    assert "options" not in ev


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
async def test_counters_track_detections() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.detection_gap("d1", "性能が未確認", "non_functional", [])
    await pub.detection_contradiction("d2", "食い違い", refs=[])
    assert pub.gaps_published == 1
    assert pub.contradictions_published == 1
    assert pub.detections_published == 2


@pytest.mark.asyncio
async def test_resolution_counters_distinguish_user_and_agent() -> None:
    t = RecordingTransport()
    pub = EventPublisher("s1", t)
    await pub.detection_resolved("d1", resolution="agent_resolved")
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


def test_decode_user_answered_prefers_selected_value() -> None:
    payload = json.dumps(
        {
            "type": "user.answered",
            "session_id": "s1",
            "question_id": "q1",
            "selected_value": "relevance",
            "text": "自由記述",
        }
    ).encode()
    assert decode_user_answered(payload, expected_session_id="s1") == ("q1", "relevance")


def test_decode_user_answered_falls_back_to_text() -> None:
    payload = json.dumps(
        {"type": "user.answered", "question_id": "q1", "text": "関連度順がよい"}
    ).encode()
    assert decode_user_answered(payload) == ("q1", "関連度順がよい")


def test_decode_user_answered_rejects_missing_answer() -> None:
    payload = json.dumps({"type": "user.answered", "question_id": "q1"}).encode()
    assert decode_user_answered(payload) is None


def test_decode_user_answered_truncates_oversized_text() -> None:
    from sanba_agent.events import MAX_USER_TEXT_CHARS

    payload = json.dumps(
        {"type": "user.answered", "question_id": "q1", "text": "あ" * (MAX_USER_TEXT_CHARS + 100)}
    ).encode()
    result = decode_user_answered(payload)
    assert result is not None
    assert len(result[1]) == MAX_USER_TEXT_CHARS


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
