"""アップロード解析の realtime publish（ADR-0023）の単体テスト。

LiveKit から切り離し、記録用 sender + in-memory repo でエンベロープ・seq・ステージ・
no-op フォールバックを検証する（agent の EventPublisher テストと同じ方針）。api は
pytest-asyncio を導入していないため、各テストは asyncio.run で coroutine を駆動する。
"""

from __future__ import annotations

import asyncio
import json

from sanba_shared.repository import SessionRepository

from sanba_api.realtime import (
    EVENTS_TOPIC,
    AnalysisPublisher,
    NullSender,
    build_sender,
)


class _RecordingSender:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
        self.sent.append({"event": json.loads(payload), "topic": topic, "reliable": reliable})


def _mem_repo() -> SessionRepository:
    repo = SessionRepository()
    repo._client = None  # force in-memory path
    return repo


def test_progress_emits_contract_envelope_with_stage_pct() -> None:
    sender = _RecordingSender()
    pub = AnalysisPublisher("s1", sender, _mem_repo())
    asyncio.run(pub.progress("a1", "received"))
    ev = sender.sent[0]["event"]
    assert sender.sent[0]["topic"] == EVENTS_TOPIC
    assert sender.sent[0]["reliable"] is True
    assert ev["v"] == 1
    assert ev["type"] == "analysis.progress"
    assert ev["session_id"] == "s1"
    assert ev["asset_id"] == "a1"
    assert ev["stage"] == "received"
    assert ev["pct"] == 10  # received=10（ADR-0023 §1 の境界値）
    assert ev["seq"] == 1
    assert "ts" in ev


def test_stage_pct_mapping_received_analyzing_done() -> None:
    sender = _RecordingSender()
    pub = AnalysisPublisher("s1", sender, _mem_repo())

    async def _run() -> None:
        await pub.progress("a1", "received")
        await pub.progress("a1", "analyzing")
        await pub.visual("a1", ["要件X", "要件Y"])

    asyncio.run(_run())
    pcts = [s["event"].get("pct") for s in sender.sent if s["event"]["type"] == "analysis.progress"]
    assert pcts == [10, 50]
    visual = next(s["event"] for s in sender.sent if s["event"]["type"] == "analysis.visual")
    assert visual["extracted"] == ["要件X", "要件Y"]
    assert visual["conflicts"] == []  # 突合未実装は空配列（ADR-0023 §2）


def test_seq_is_monotonic_across_events() -> None:
    sender = _RecordingSender()
    pub = AnalysisPublisher("s1", sender, _mem_repo())

    async def _run() -> None:
        await pub.progress("a1", "received")
        await pub.progress("a1", "analyzing")
        await pub.visual("a1", [])

    asyncio.run(_run())
    seqs = [s["event"]["seq"] for s in sender.sent]
    assert seqs == [1, 2, 3]


def test_seq_continues_from_shared_space() -> None:
    # agent が進めた last_seq の続きから採番する（共有 seq 空間 / ADR-0021）。
    repo = _mem_repo()
    repo.set_session_seq("s1", 7)
    sender = _RecordingSender()
    pub = AnalysisPublisher("s1", sender, repo)
    asyncio.run(pub.progress("a1", "received"))
    assert sender.sent[0]["event"]["seq"] == 8


def test_failed_stage_payload() -> None:
    sender = _RecordingSender()
    pub = AnalysisPublisher("s1", sender, _mem_repo())
    asyncio.run(pub.progress("a1", "failed"))
    assert sender.sent[0]["event"]["stage"] == "failed"


def test_publish_failure_does_not_raise() -> None:
    class _Boom:
        async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
            raise RuntimeError("livekit down")

    pub = AnalysisPublisher("s1", _Boom(), _mem_repo())
    # 送信失敗でも例外を投げない（アップロードを止めない / ADR-0023 §3）。
    ev = asyncio.run(pub.progress("a1", "received"))
    assert ev["seq"] == 1  # seq は採番され、エンベロープは返る


def test_build_sender_returns_null_when_unconfigured() -> None:
    assert isinstance(build_sender("", "", "", "room"), NullSender)
    assert isinstance(build_sender("ws://x", "k", "s", ""), NullSender)
    # 全て揃えば本番送信（LiveKitServerSender）。
    assert not isinstance(build_sender("ws://x", "k", "s", "room"), NullSender)


def test_livekit_publish_url_falls_back_to_livekit_url() -> None:
    # server-side publish 用 URL は、未設定なら join 用 livekit_url に等しい（本番 Cloud 等）。
    from sanba_api.config import Settings

    s = Settings(livekit_url="ws://browser:7880", livekit_server_url="")
    assert s.livekit_publish_url == "ws://browser:7880"


def test_livekit_publish_url_overrides_join_url_when_set() -> None:
    # docker-compose ローカル: ブラウザ向け join URL(localhost) と publish 先(サービス名)を分離。
    from sanba_api.config import Settings

    s = Settings(livekit_url="ws://localhost:7880", livekit_server_url="ws://livekit:7880")
    assert s.livekit_publish_url == "ws://livekit:7880"
