"""解析の realtime publish（アップロード素材の解析進捗 / ADR-0023・ADR-0040）。

解析の実行主体（API のアップロード同期解析 / worker の非同期動画解析）が、解析の境界で
``analysis.progress`` を、完了で ``analysis.visual`` を LiveKit データチャネル
（topic ``sanba.events``・reliable）へ直接 publish する。agent を経由せず疎結合に保つ。
以前は ``apps/api`` に閉じていたが、worker からも同じ publish が要るため domain 層へ移設した
（ADR-0040 §4。api は薄い再エクスポートで互換維持）。

- エンベロープは契約 §2（``v/type/seq/ts/session_id``）に従い、agent の ``EventPublisher``
  と同形にする（web の ``parse.ts``/``store.ts`` がそのまま受理できる）。
- ``seq`` は **ADR-0021 の共有 seq 空間**から ``reserve_session_seq`` で予約する。API と
  agent が同じセッションへ publish しても単調増加を崩さない（区間をアトミック予約）。
- ステージは「実体に正直」な粗い段階のみ（ADR-0023 §1）。中間 pct は捏造しない。
- 送信は ``DataSender`` に委譲し、LiveKit ランタイムから切り離してテストできるようにする。
  LiveKit 未設定/未接続・送信失敗時は no-op（API 本処理＝アップロードを止めない / §3）。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog

from .repository import SessionRepository

log = structlog.get_logger(__name__)

SCHEMA_VERSION = 1
EVENTS_TOPIC = "sanba.events"

STAGE_RECEIVED = "received"
STAGE_ANALYZING = "analyzing"
STAGE_DONE = "done"
STAGE_FAILED = "failed"

STAGE_PCT: dict[str, int] = {
    STAGE_RECEIVED: 10,
    STAGE_ANALYZING: 50,
    STAGE_DONE: 100,
    STAGE_FAILED: 100,
}


def _now() -> datetime:
    return datetime.now(UTC)


class DataSender(Protocol):
    """データチャネル送信の最小インターフェース（LiveKit から分離してテスト可能に）。"""

    async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None: ...


class NullSender:
    """LiveKit 未設定/未接続時の no-op 送信（ADR-0023 §3: 本処理を止めない）。"""

    async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
        return None


class LiveKitServerSender:
    """LiveKit サーバ API（RoomService.send_data）でデータチャネルへ publish する本番送信。

    サーバ identity（API key/secret）で送る＝ルーム参加者でなくても publish できる。
    送信失敗は呼び出し元（``AnalysisPublisher``）で握りつぶす（解析本処理を止めない）。
    """

    def __init__(self, url: str, api_key: str, api_secret: str, room: str) -> None:
        self._url = url
        self._api_key = api_key
        self._api_secret = api_secret
        self._room = room

    async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
        from livekit import api as lkapi

        client = lkapi.LiveKitAPI(self._url, self._api_key, self._api_secret)
        try:
            kind = lkapi.DataPacket.Kind.RELIABLE if reliable else lkapi.DataPacket.Kind.LOSSY
            await client.room.send_data(
                lkapi.SendDataRequest(room=self._room, data=payload, kind=kind, topic=topic)
            )
        finally:
            await client.aclose()


class AnalysisPublisher:
    """1 セッション分のアップロード解析イベントを契約準拠で publish する。"""

    def __init__(
        self,
        session_id: str,
        sender: DataSender,
        repo: SessionRepository,
        *,
        clock: Any = _now,
    ) -> None:
        self._session_id = session_id
        self._sender = sender
        self._repo = repo
        self._clock = clock

    async def _emit(self, type_: str, payload: dict[str, Any], *, reliable: bool) -> dict[str, Any]:
        seq = self._repo.reserve_session_seq(self._session_id)
        envelope: dict[str, Any] = {
            "v": SCHEMA_VERSION,
            "type": type_,
            "seq": seq,
            "ts": self._clock().isoformat(),
            "session_id": self._session_id,
            **payload,
        }
        data = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
        try:
            await self._sender.send(data, topic=EVENTS_TOPIC, reliable=reliable)
            sent = True
        except Exception as exc:  # pragma: no cover
            log.warning("analysis_publish_failed", type=type_, seq=seq, error=str(exc))
            sent = False
        log.info("analysis_published", type=type_, seq=seq, sent=sent)
        return envelope

    async def progress(self, asset_id: str, stage: str) -> dict[str, Any]:
        """解析の境界を ``analysis.progress``(asset_id, pct, stage) で通知する。

        pct はステージの境界値（ADR-0023 §1）。アップロード解析は数件の離散イベントなので
        reliable で送る（高頻度 lossy の会話 status とは別扱い / ADR-0023 §2）。
        """
        return await self._emit(
            "analysis.progress",
            {"asset_id": asset_id, "pct": STAGE_PCT.get(stage, 0), "stage": stage},
            reliable=True,
        )

    async def visual(
        self,
        asset_id: str,
        extracted: list[str],
        conflicts: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """解析完了を ``analysis.visual``(asset_id, extracted, conflicts) で通知する。

        web は visual 受信で pct を 100 に固定し done と判定する。``conflicts``
        （言葉×画の矛盾 / ADR-0004）は突合実装までは空配列でよい（ADR-0023 §2）。
        """
        return await self._emit(
            "analysis.visual",
            {"asset_id": asset_id, "extracted": extracted, "conflicts": conflicts or []},
            reliable=True,
        )


def build_sender(url: str, api_key: str, api_secret: str, room: str) -> DataSender:
    """設定が揃っていれば LiveKit 送信を、欠けていれば no-op を返す（ADR-0023 §3）。

    creds/url 未設定（ローカル/CI/未接続）では publish を no-op にし、アップロード処理を
    一切止めない。web はその場合 GET context/files のハイドレーションで状態を復元できる。
    """
    if url and api_key and api_secret and room:
        return LiveKitServerSender(url, api_key, api_secret, room)
    return NullSender()
