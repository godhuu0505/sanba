"""Data channel publish (Issue #94 / Epic #93).

P0 画面が依存するリアルタイム基盤のうち、**agent → web のデータチャネル publish**を担う。
契約（docs/design/realtime-contract.md §1/§2/§3）に従い、LiveKit ルームへ
``topic="sanba.events"`` で reliable publish する（音声と同一接続）。

- エンベロープ §2: ``v/type/seq/ts/session_id``。``seq`` はセッション内で単調増加。
- 種別 §3: status / transcript.* / detection.* / requirement.upserted /
  analysis.* / session.completed。
- ``detector`` / ``source_speaker`` は**機能名**で送る（緋/黄土の写像は web 側 #101）。
- 観測性（CLAUDE.md 原則3 / 契約 §5）: publish 時に span/log（type/seq を属性）、
  要件数・検知数を計測。

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
from sanba_shared.models import Requirement

log = structlog.get_logger(__name__)

SCHEMA_VERSION = 1
EVENTS_TOPIC = "sanba.events"
WEB_EVENTS_TOPIC = "sanba.events.web"  # web → agent（#102 で受信）


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


# 緋/黄土の機能名（契約 §3）。
DETECTOR_CONTRADICTION = "contradiction_detector"
DETECTOR_SCOPE = "scope_specialist"
DETECTOR_NFR = "nfr_specialist"

# 解消理由（detection.resolved）。ユーザー選択＝矛盾カードの解消、agent＝抜けの自動解消。
RESOLUTION_USER_SELECTED = "user_selected"
RESOLUTION_AGENT_RESOLVED = "agent_resolved"


class EventPublisher:
    """セッション 1 つ分の単調増加 seq を持ち、契約準拠イベントを publish する。"""

    def __init__(
        self,
        session_id: str,
        transport: DataTransport,
        *,
        clock: Any = _now,
    ) -> None:
        self._session_id = session_id
        self._transport = transport
        self._clock = clock
        self._seq = 0
        self._lock = asyncio.Lock()
        # 観測性: 要件数・検知数を種別ごとに計測（契約 §5 / ADR-0005 評価へ）。
        # session.completed のサマリを実測から組み立てるため、抜け/矛盾/解消を分けて持つ。
        self.requirements_published = 0
        self.gaps_published = 0
        self.contradictions_published = 0
        self.detections_resolved = 0
        self.contradictions_resolved = 0
        self.questions_published = 0
        self._tracer = _get_tracer()

    @property
    def seq(self) -> int:
        return self._seq

    @property
    def detections_published(self) -> int:
        """検知（抜け＋矛盾）の publish 総数。"""
        return self.gaps_published + self.contradictions_published

    async def _emit(
        self, type_: str, payload: dict[str, Any], *, reliable: bool = True
    ) -> dict[str, Any]:
        # ロックで seq 採番〜送信を直列化し、単調増加と配信順序を保証する。
        async with self._lock:
            self._seq += 1
            envelope = {
                "v": SCHEMA_VERSION,
                "type": type_,
                "seq": self._seq,
                "ts": self._clock().isoformat(),
                "session_id": self._session_id,
                **payload,
            }
            data = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
            span = (
                self._tracer.start_as_current_span("sanba.events.publish")
                if self._tracer
                else contextlib.nullcontext()
            )
            with span as s:
                if s is not None:
                    s.set_attribute("sanba.event.type", type_)
                    s.set_attribute("sanba.event.seq", self._seq)
                try:
                    await self._transport.send(data, topic=EVENTS_TOPIC, reliable=reliable)
                except Exception as exc:  # pragma: no cover - network/optional
                    # publish 失敗は会話を止めない（ライブ差分は次のイベントで前進）。
                    log.warning("event_publish_failed", type=type_, seq=self._seq, error=str(exc))
            log.info("event_published", type=type_, seq=self._seq, reliable=reliable)
            return envelope

    # ── §3 種別ヘルパ ──────────────────────────────────────────────────
    async def status(self, phase: str, agents_active: int | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"phase": phase}
        if agents_active is not None:
            payload["agents_active"] = agents_active
        # 高頻度・使い捨ては lossy 可（契約 §1）。
        return await self._emit("status", payload, reliable=False)

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

    async def detection_contradiction(
        self,
        detection_id: str,
        summary: str,
        refs: list[str],
        *,
        options: list[dict[str, str]] | None = None,
        detector: str = DETECTOR_CONTRADICTION,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": detection_id,
            "summary": summary,
            "refs": refs,
            "detector": detector,
        }
        if options:
            payload["options"] = options
        self.contradictions_published += 1
        return await self._emit("detection.contradiction", payload)

    async def detection_gap(
        self,
        detection_id: str,
        summary: str,
        category: str,
        refs: list[str],
        *,
        detector: str = DETECTOR_SCOPE,
    ) -> dict[str, Any]:
        self.gaps_published += 1
        return await self._emit(
            "detection.gap",
            {
                "id": detection_id,
                "summary": summary,
                "category": category,
                "refs": refs,
                "detector": detector,
            },
        )

    async def detection_resolved(
        self,
        detection_id: str,
        resolution: str,
        *,
        selected_value: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "detection_id": detection_id,
            "resolution": resolution,
        }
        if selected_value is not None:
            payload["selected_value"] = selected_value
        # 解消の実測。矛盾カードの解消（ユーザー選択）は session.completed のサマリへ。
        self.detections_resolved += 1
        if resolution == RESOLUTION_USER_SELECTED:
            self.contradictions_resolved += 1
        return await self._emit("detection.resolved", payload)

    async def requirement_upserted(
        self, requirement: Requirement, *, status: str = "confirmed"
    ) -> dict[str, Any]:
        self.requirements_published += 1
        return await self._emit(
            "requirement.upserted", {"requirement": requirement_to_contract(requirement, status)}
        )

    async def question_asked(
        self,
        question_id: str,
        prompt: str,
        *,
        options: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """通常質問（金枠 / #181）を web の問いピンへ出す（音声と併用）。

        ``options`` があればタップで user.answered が返る。無ければ自由記述（音声/テキスト）。
        """
        payload: dict[str, Any] = {"id": question_id, "prompt": prompt}
        if options:
            payload["options"] = options
        self.questions_published += 1
        return await self._emit("question.asked", payload)

    async def analysis_progress(self, asset_id: str, pct: int, stage: str) -> dict[str, Any]:
        return await self._emit(
            "analysis.progress",
            {"asset_id": asset_id, "pct": pct, "stage": stage},
            reliable=False,
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

    web 側 #101 / api 側 #100 と同じ schema（source_speaker / confidence / citations /
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
    LiveKit ランタイムに依存しないので単体テストできる（#102）。
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


def decode_user_text(payload: bytes | str, *, expected_session_id: str | None = None) -> str | None:
    """web → agent の user.text（契約 §4.5 / #185）をデコードする。

    検証に通れば本文テキストを返す。不正・別セッション・空文字なら None。
    テキスト入力を「会話ターン」として扱うため、main 側で発話記録＋応答生成に渡す。
    """
    obj = _decode_web_event(payload, "user.text", expected_session_id=expected_session_id)
    if obj is None:
        return None
    text = obj.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    return text.strip()


def decode_user_answered(
    payload: bytes | str, *, expected_session_id: str | None = None
) -> tuple[str, str] | None:
    """web → agent の user.answered（契約 §4.5 / #181）をデコードする。

    通常質問（金枠）への回答。``(question_id, answer)`` を返す。answer は選択肢値
    （selected_value）優先、無ければ自由記述（text）。どちらも無ければ None。
    """
    obj = _decode_web_event(payload, "user.answered", expected_session_id=expected_session_id)
    if obj is None:
        return None
    question_id = obj.get("question_id")
    if not isinstance(question_id, str):
        return None
    selected = obj.get("selected_value")
    text = obj.get("text")
    answer = selected if isinstance(selected, str) and selected else text
    if not isinstance(answer, str) or not answer.strip():
        return None
    return question_id, answer.strip()


def _get_tracer() -> Any:
    try:
        from opentelemetry import trace

        return trace.get_tracer("sanba.events")
    except Exception:  # pragma: no cover - otel optional
        return None
