"""Data channel publish.

P0 画面が依存するリアルタイム基盤のうち、**agent → web のデータチャネル publish**を担う。
契約（docs/reference/realtime-contract.md §1/§2/§3）に従い、LiveKit ルームへ
``topic="sanba.events"`` で reliable publish する（音声と同一接続）。

- エンベロープ §2: ``v/type/seq/ts/session_id``。``seq`` はセッション内で単調増加。
- 種別 §3: status / transcript.* / inquiry.node / requirement.upserted /
  analysis.* / session.completed（確認事項は ADR-0059 で detection.* を廃し一本化）。
- ``source_speaker`` は**機能名**で送る（緋/黄土の写像は web 側で行う）。
- 観測性（CLAUDE.md 原則3 / 契約 §5）: publish 時に span/log（type/seq を属性）、要件数を計測。

LiveKit ランタイムから切り離してテストできるよう、送信は ``DataTransport`` に委譲する。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog
from sanba_shared.models import InquiryNode, Requirement

log = structlog.get_logger(__name__)

SCHEMA_VERSION = 1
EVENTS_TOPIC = "sanba.events"
WEB_EVENTS_TOPIC = "sanba.events.web"


class DataTransport(Protocol):
    """データチャネル送信の最小インターフェース（LiveKit から分離してテスト可能に）。"""

    async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None: ...


class LiveKitTransport:
    """`livekit.rtc.Room` のローカル参加者経由で publish する本番トランスポート。"""

    def __init__(self, room: Any) -> None:
        self._room = room

    async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
        await self._room.local_participant.publish_data(payload, reliable=reliable, topic=topic)


@dataclass
class RecordingTransport:
    """テスト用。送信ペイロードを記録するだけのトランスポート。"""

    sent: list[dict[str, Any]] = field(default_factory=list)

    async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
        self.sent.append({"event": json.loads(payload), "topic": topic, "reliable": reliable})


def _now() -> datetime:
    return datetime.now(UTC)


class EventPublisher:
    """セッション 1 つ分の単調増加 seq を持ち、契約準拠イベントを publish する。"""

    def __init__(
        self,
        session_id: str,
        transport: DataTransport,
        *,
        start_seq: int = 0,
        start_lossy_seq: int = 0,
        clock: Any = _now,
    ) -> None:
        self._session_id = session_id
        self._transport = transport
        self._clock = clock
        self._seq = start_seq
        self._lossy_seq = start_lossy_seq
        self._lock = asyncio.Lock()
        self.requirements_published = 0
        self._tracer = _get_tracer()

    @property
    def seq(self) -> int:
        return self._seq

    @property
    def lossy_seq(self) -> int:
        return self._lossy_seq

    async def _emit(
        self, type_: str, payload: dict[str, Any], *, reliable: bool = True
    ) -> dict[str, Any]:
        async with self._lock:
            if reliable:
                self._seq += 1
                envelope = self._build_envelope(type_, self._seq, payload, reliable=True)
            else:
                self._lossy_seq += 1
                envelope = self._build_envelope(
                    type_, self._seq, payload, reliable=False, lossy_seq=self._lossy_seq
                )
            await self._send_envelope(envelope, reliable=reliable)
            return envelope

    def _build_envelope(
        self,
        type_: str,
        seq: int,
        payload: dict[str, Any],
        *,
        reliable: bool = True,
        lossy_seq: int | None = None,
    ) -> dict[str, Any]:
        envelope: dict[str, Any] = {
            "v": SCHEMA_VERSION,
            "type": type_,
            "seq": seq,
            "ts": self._clock().isoformat(),
            "session_id": self._session_id,
            "reliable": reliable,
            **payload,
        }
        if lossy_seq is not None:
            envelope["lossy_seq"] = lossy_seq
        return envelope

    async def _send_envelope(self, envelope: dict[str, Any], *, reliable: bool) -> bool:
        """エンベロープを送信し、成否を返す。送信例外は握りつぶす（呼び出し元が要否を判断）。"""
        type_ = envelope["type"]
        seq = envelope["seq"]
        data = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
        span = (
            self._tracer.start_as_current_span("sanba.events.publish")
            if self._tracer
            else contextlib.nullcontext()
        )
        sent = False
        with span as s:
            if s is not None:
                s.set_attribute("sanba.event.type", type_)
                s.set_attribute("sanba.event.seq", seq)
            try:
                await self._transport.send(data, topic=EVENTS_TOPIC, reliable=reliable)
                sent = True
            except Exception as exc:  # pragma: no cover - network/optional
                log.warning("event_publish_failed", type=type_, seq=seq, error=str(exc))
        log.info("event_published", type=type_, seq=seq, reliable=reliable, sent=sent)
        return sent

    async def status(self, phase: str, agents_active: int | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"phase": phase}
        if agents_active is not None:
            payload["agents_active"] = agents_active
        return await self._emit("status", payload, reliable=False)

    async def context_progress(
        self,
        source: str,
        stage: str,
        *,
        label: str = "",
        detail: str = "",
    ) -> dict[str, Any]:
        """会話開始時の前提読み込み（prep / repo）の状態を ``context.progress`` で通知する。

        素材（アップロード）の進捗は ``analysis.progress`` が担うので重複させない。
        ``stage`` は実体に正直な段階のみ（running / done / reused / partial / failed）で、
        中間 pct は捏造しない（ADR-0023 §1 の規律を prep/repo にも適用）。reliable で送る
        （数件の離散イベント）。web は会話履歴のシステムバブルと参考資料タブへ写像する。
        """
        payload: dict[str, Any] = {"source": source, "stage": stage}
        if label:
            payload["label"] = label
        if detail:
            payload["detail"] = detail
        return await self._emit("context.progress", payload, reliable=True)

    async def transcript_partial(
        self, speaker: str, role: str, utterance_id: str, text: str
    ) -> dict[str, Any]:
        return await self._emit(
            "transcript.partial",
            {"speaker": speaker, "role": role, "utterance_id": utterance_id, "text": text},
            reliable=False,
        )

    async def transcript_final(
        self, speaker: str, role: str, utterance_id: str, text: str
    ) -> dict[str, Any]:
        return await self._emit(
            "transcript.final",
            {"speaker": speaker, "role": role, "utterance_id": utterance_id, "text": text},
        )

    async def requirement_upserted(
        self, requirement: Requirement, *, status: str = "confirmed"
    ) -> dict[str, Any]:
        self.requirements_published += 1
        return await self._emit(
            "requirement.upserted", {"requirement": requirement_to_contract(requirement, status)}
        )

    async def analysis_progress(self, asset_id: str, pct: int, stage: str) -> dict[str, Any]:
        return await self._emit(
            "analysis.progress",
            {"asset_id": asset_id, "pct": pct, "stage": stage},
        )

    async def analysis_visual(
        self,
        asset_id: str,
        extracted: list[str],
        conflicts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return await self._emit(
            "analysis.visual",
            {"asset_id": asset_id, "extracted": extracted, "conflicts": conflicts},
        )

    async def session_end_proposed(
        self,
        open_count: int,
        requirement_count: int,
        material_count: int,
    ) -> dict[str, Any]:
        """全確認事項が解消したときの「終了の提案」を web へ伝える（P1-b）。

        web は提案カードを出し、ユーザーが同意すれば会話で締めへ進む。reliable で送る。
        """
        return await self._emit(
            "session.end_proposed",
            {
                "open_count": open_count,
                "requirement_count": requirement_count,
                "material_count": material_count,
            },
        )

    async def inquiry_node(self, node: InquiryNode, *, op: str) -> dict[str, Any]:
        """確認事項ロジックツリーのノード変化を ``inquiry.node`` で通知する（ADR-0059）。

        ``op`` は upsert / resolve / drop。ノード全体を upsert セマンティクスで送る（冪等）。
        web はツリービュー（`InquiryTree`）へ写像する。reliable/seq（再接続で `GET /inquiry`
        + seq gap 埋め）。
        """
        return await self._emit(
            "inquiry.node", {"op": op, "node": node.model_dump(mode="json")}, reliable=True
        )

    async def session_completed(
        self,
        contradictions_resolved: int,
        gaps_found: int,
        issues_created: int,
        artifacts: list[dict[str, str]],
    ) -> dict[str, Any]:
        return await self._emit(
            "session.completed",
            {
                "summary": {
                    "contradictions_resolved": contradictions_resolved,
                    "gaps_found": gaps_found,
                    "issues_created": issues_created,
                },
                "artifacts": artifacts,
            },
        )


def requirement_to_contract(requirement: Requirement, status: str) -> dict[str, Any]:
    """`Requirement` モデルを契約 §3 の requirement ペイロードに整形する。

    web 側 / api 側と同じ schema（source_speaker / confidence / citations /
    status を含む）に揃える。
    """
    return {
        "id": requirement.id,
        "statement": requirement.statement,
        "category": str(requirement.category),
        "priority": str(requirement.priority),
        "confidence": requirement.confidence,
        "source_speaker": requirement.source_speaker or "",
        "citations": [{"kind": "utterance", "ref": ref} for ref in requirement.citations],
        "status": status,
    }


def decode_user_selection(
    payload: bytes | str, *, expected_session_id: str | None = None
) -> tuple[str, str] | None:
    """web → agent の user.selection（契約 §4.5）をデコードする。

    検証に通れば ``(detection_id, selected_value)`` を返す。不正なら None。
    ``expected_session_id`` を渡すと、エンベロープの ``session_id`` が一致しない
    メッセージを破棄する（同一 LiveKit ルーム内の別セッション向け selection 混入を防ぐ。
    web 側 store の ``expectedSessionId`` 照合と対称な受信境界）。
    LiveKit ランタイムに依存しないので単体テストできる。
    """
    try:
        text = payload.decode("utf-8") if isinstance(payload, bytes) else payload
        obj = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict) or obj.get("type") != "user.selection":
        return None
    if expected_session_id is not None and obj.get("session_id") != expected_session_id:
        return None
    detection_id = obj.get("detection_id")
    selected_value = obj.get("selected_value")
    if not isinstance(detection_id, str) or not isinstance(selected_value, str):
        return None
    return detection_id, selected_value


def _decode_web_event(
    payload: bytes | str, expected_type: str, *, expected_session_id: str | None
) -> dict[str, Any] | None:
    """web → agent のイベント（契約 §4.5）を JSON デコードし型/セッションを照合する。

    ``expected_type`` と一致し、``expected_session_id`` を渡した場合は session_id も一致する
    dict を返す。不正・不一致なら None（同室の別セッション向けイベント混入を弾く）。
    """
    try:
        text = payload.decode("utf-8") if isinstance(payload, bytes) else payload
        obj = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict) or obj.get("type") != expected_type:
        return None
    if expected_session_id is not None and obj.get("session_id") != expected_session_id:
        return None
    return obj


MAX_USER_TEXT_CHARS = 4000


def decode_user_text(payload: bytes | str, *, expected_session_id: str | None = None) -> str | None:
    """web → agent の user.text（契約 §4.5）をデコードする。

    検証に通れば本文テキストを返す。不正・別セッション・空文字なら None。
    上限（MAX_USER_TEXT_CHARS）を超える入力は切り詰める（メモリ/LLM コンテキスト保護）。
    テキスト入力を「会話ターン」として扱うため、main 側で発話記録＋応答生成に渡す。
    """
    obj = _decode_web_event(payload, "user.text", expected_session_id=expected_session_id)
    if obj is None:
        return None
    text = obj.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    return text.strip()[:MAX_USER_TEXT_CHARS]


def decode_user_interrupt(payload: bytes | str, *, expected_session_id: str | None = None) -> bool:
    """web → agent の user.interrupt（契約 §4.5 / ADR-0066 S3）をデコードする。

    PTT 押下開始の合図。検証に通れば True、不正・別セッションなら False。
    受信側は読み上げ中の応答を即時中断する（クライアントの mic ゲートと対で、
    エージェント発話へのバージインを決定論的にする）。ペイロードは付加フィールド無し。
    """
    obj = _decode_web_event(payload, "user.interrupt", expected_session_id=expected_session_id)
    return obj is not None


_MIC_MODES = frozenset({"ptt", "handsfree"})


def decode_user_mic_mode(
    payload: bytes | str, *, expected_session_id: str | None = None
) -> str | None:
    """web → agent の user.mic_mode（契約 §4.5 / ADR-0073）をデコードする。

    マイク操作モード（"ptt" / "handsfree"）の宣言。接続時と切替時に届く。検証に通れば
    モード文字列を、不正・別セッション・未知の値なら None を返す。受信側は現在の手動/自動
    構成と食い違うときだけセッションを再構築する。
    """
    obj = _decode_web_event(payload, "user.mic_mode", expected_session_id=expected_session_id)
    if obj is None:
        return None
    mode = obj.get("mode")
    if not isinstance(mode, str) or mode not in _MIC_MODES:
        return None
    return mode


def decode_user_turn_start(payload: bytes | str, *, expected_session_id: str | None = None) -> bool:
    """web → agent の user.turn_start（契約 §4.5 / ADR-0073）をデコードする。

    PTT 押下＝発話ターン開始の合図。検証に通れば True。受信側は読み上げを中断（バージイン）し、
    手動ターン構成では同時に activity_start を送って発話ターンを開く。付加フィールド無し。
    """
    obj = _decode_web_event(payload, "user.turn_start", expected_session_id=expected_session_id)
    return obj is not None


def decode_user_turn_commit(
    payload: bytes | str, *, expected_session_id: str | None = None
) -> bool:
    """web → agent の user.turn_commit（契約 §4.5 / ADR-0073）をデコードする。

    PTT 離す＝発話ターン確定の合図。検証に通れば True。受信側は手動ターンを確定し
    （activity_end + 応答生成）、離した瞬間にエージェントが話し始める。付加フィールド無し。
    """
    obj = _decode_web_event(payload, "user.turn_commit", expected_session_id=expected_session_id)
    return obj is not None


MAX_INJECTED_OBSERVATIONS = 12


def decode_analysis_visual(
    payload: bytes | str, *, expected_session_id: str | None = None
) -> tuple[str, list[str]] | None:
    """worker/api → agent の analysis.visual（契約 §3 / ADR-0040 §4）をデコードする。

    アップロード素材（動画）の解析完了イベント。``(asset_id, extracted)`` を返す。asset_id が
    アップロード素材（``asset-`` 始まり）でない、または extracted が空なら None。
    ``visual:`` 始まり（agent 自身の画面共有 note_visual_requirement 由来）はエコーなので弾く。
    観察は上限件数で切り詰める（注入プロンプトの肥大を防ぐ）。
    """
    obj = _decode_web_event(payload, "analysis.visual", expected_session_id=expected_session_id)
    if obj is None:
        return None
    asset_id = obj.get("asset_id")
    if not isinstance(asset_id, str) or not asset_id.startswith("asset-"):
        return None
    extracted = obj.get("extracted")
    if not isinstance(extracted, list):
        return None
    observations = [s for s in extracted if isinstance(s, str) and s.strip()]
    if not observations:
        return None
    return asset_id, observations[:MAX_INJECTED_OBSERVATIONS]


def _get_tracer() -> Any:
    try:
        from opentelemetry import trace

        return trace.get_tracer("sanba.events")
    except Exception:  # pragma: no cover - otel optional
        return None
