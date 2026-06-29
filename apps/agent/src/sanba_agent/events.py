"""Data channel publish (Issue #94 / Epic #93).

P0 画面が依存するリアルタイム基盤のうち、**agent → web のデータチャネル publish**を担う。
契約（docs/design/realtime-contract.md §1/§2/§3）に従い、LiveKit ルームへ
``topic="sanba.events"`` で reliable publish する（音声と同一接続）。

- エンベロープ §2（ADR-0021）: ``v/type/ts/session_id`` ＋ reliable は ``seq``・lossy は
  ``lossy_seq``。reliable seq は連続採番（web のギャップ検知の基準）、lossy seq は
  status/transcript.partial 等の高頻度・使い捨て用で欠番許容（落ちても reliable に穴を開けない）。
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
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog
from sanba_shared.models import Requirement

log = structlog.get_logger(__name__)

# v2（ADR-0021）: reliable/lossy で seq 名前空間を分離。reliable は `seq`、lossy は `lossy_seq`。
SCHEMA_VERSION = 2
EVENTS_TOPIC = "sanba.events"
WEB_EVENTS_TOPIC = "sanba.events.web"  # web → agent（#102 で受信）


class EventPublishError(RuntimeError):
    """commit 後に publish が失敗したことを呼び出し元へ伝える（ADR-0020 §5-9）。

    現在質問のクリア（`question.cleared`）は tombstone を commit してから publish する。
    commit 後の送信失敗を握りつぶすと、接続中の他参加者に clear が届かず古いピンが残るため、
    critical な送信の失敗はこの例外で呼び出し元へ返し、補償（再送/ログ）できるようにする。
    最終的な耐障害境界は tombstone + ハイドレーション GET（再接続/欠番検知で確実に復元）。
    """


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
DETECTOR_AMBIGUITY = "ambiguity_detector"

# 解消理由（detection.resolved）。ユーザー選択＝矛盾カードの解消、agent＝抜けの自動解消。
RESOLUTION_USER_SELECTED = "user_selected"
RESOLUTION_AGENT_RESOLVED = "agent_resolved"


class EventPublisher:
    """セッション 1 つ分の reliable/lossy 2 系統 seq を持ち契約準拠に publish（ADR-0021）。"""

    def __init__(
        self,
        session_id: str,
        transport: DataTransport,
        *,
        start_seq: int = 0,
        clock: Any = _now,
    ) -> None:
        self._session_id = session_id
        self._transport = transport
        self._clock = clock
        # reliable/lossy で seq 名前空間を分離する（ADR-0021）。reliable seq は連続採番で web の
        # ギャップ検知の基準。lossy seq（status / transcript.partial / 会話由来 analysis.progress）
        # は別カウンタで採番し、落ちても reliable seq に穴を開けない（#122）。
        # 再起動後も単調増加を継ぐため、保存済み last_seq（=reliable seq）で両カウンタをシード
        # （#123・ADR-0021）。reliable seq だけを永続化し（呼び出し側 repo.set_session_seq）、
        # 高頻度な lossy は永続化しない（Firestore 書込を増やさない）。lossy も同じ start_seq から
        # 始めることで、再起動直後の status 反映の取りこぼし窓を最小化する。
        self._seq = start_seq
        self._lossy_seq = start_seq
        self._lock = asyncio.Lock()
        # 観測性: 要件数・検知数を種別ごとに計測（契約 §5 / ADR-0005 評価へ）。
        # session.completed のサマリを実測から組み立てるため、抜け/矛盾/解消を分けて持つ。
        self.requirements_published = 0
        self.gaps_published = 0
        self.contradictions_published = 0
        self.ambiguous_published = 0
        self.detections_resolved = 0
        self.contradictions_resolved = 0
        self.questions_published = 0
        self.questions_cleared = 0
        self._tracer = _get_tracer()

    @property
    def seq(self) -> int:
        """採番済みの最大 **reliable** seq（永続化対象 / #123・ADR-0021）。"""
        return self._seq

    @property
    def detections_published(self) -> int:
        """検知（抜け＋矛盾＋不明瞭）の publish 総数。"""
        return self.gaps_published + self.contradictions_published + self.ambiguous_published

    async def _emit(
        self, type_: str, payload: dict[str, Any], *, reliable: bool = True
    ) -> dict[str, Any]:
        # ロックで seq 採番〜送信を直列化し、単調増加と配信順序を保証する。reliable/lossy で
        # 別カウンタを進め、エンベロープには該当する seq フィールドだけを載せる（ADR-0021）。
        async with self._lock:
            if reliable:
                self._seq += 1
                envelope = self._build_envelope(type_, self._seq, payload, reliable=True)
            else:
                self._lossy_seq += 1
                envelope = self._build_envelope(type_, self._lossy_seq, payload, reliable=False)
            await self._send_envelope(envelope, reliable=reliable)
            return envelope

    async def _emit_guarded(
        self,
        type_: str,
        payload: dict[str, Any],
        *,
        before_send: Callable[[int], bool],
        critical_send: bool = False,
    ) -> dict[str, Any] | None:
        """「採番 → 永続化 → 送信」を保証して publish する（ADR-0020 §5-1 / §5-9）。

        seq は **予約（peek）のみ**で、``before_send(seq)`` が成功するまで ``self._seq`` を確定
        しない。``before_send`` が False を返したら（CAS 不一致 / 既クリア）採番も送信もせず
        ``None`` を返す＝**欠番を作らない**。例外送出（保存失敗）時も採番を確定しないため、
        保存できなかったイベントを表に出さない。``critical_send`` のときは commit 後の送信失敗を
        握りつぶさず ``EventPublishError`` で返す（接続中の他参加者へ確実に補償するため）。
        """
        async with self._lock:
            # §5-1: 次 reliable seq を「予約」するだけ（self._seq はまだ進めない）。
            # _emit_guarded は reliable 専用（question.asked / question.cleared / ADR-0020）。
            seq = self._seq + 1
            envelope = self._build_envelope(type_, seq, payload, reliable=True)
            # 採番 → 保存（Firestore tombstone / current 保存）→ 送信。
            if not before_send(seq):
                return None
            # 保存成功後に初めて採番を確定する（ここで seq を消費する）。
            self._seq = seq
            sent = await self._send_envelope(envelope, reliable=True)
            if critical_send and not sent:
                # §5-9: commit 後の publish 失敗を成功扱いしない（呼び出し元で補償）。
                raise EventPublishError(f"publish failed after commit: {type_} seq={seq}")
            return envelope

    def _build_envelope(
        self, type_: str, seq: int, payload: dict[str, Any], *, reliable: bool
    ) -> dict[str, Any]:
        # reliable は `seq`、lossy は `lossy_seq` フィールドで採番値を載せる（ADR-0021）。
        # web はどちらのフィールドを持つかでストリームを判別し、gap 検知を reliable 限定にする。
        seq_field = "seq" if reliable else "lossy_seq"
        return {
            "v": SCHEMA_VERSION,
            "type": type_,
            seq_field: seq,
            "ts": self._clock().isoformat(),
            "session_id": self._session_id,
            **payload,
        }

    async def _send_envelope(self, envelope: dict[str, Any], *, reliable: bool) -> bool:
        """エンベロープを送信し、成否を返す。送信例外は握りつぶす（呼び出し元が要否を判断）。"""
        type_ = envelope["type"]
        # reliable は seq、lossy は lossy_seq を持つ（観測ログ用にどちらかを拾う / ADR-0021）。
        seq = envelope.get("seq", envelope.get("lossy_seq"))
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
                # publish 失敗は会話を止めない（ライブ差分は次のイベントで前進）。
                log.warning("event_publish_failed", type=type_, seq=seq, error=str(exc))
        log.info("event_published", type=type_, seq=seq, reliable=reliable, sent=sent)
        return sent

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

    async def detection_ambiguous(
        self,
        detection_id: str,
        summary: str,
        refs: list[str],
        *,
        detector: str = DETECTOR_AMBIGUITY,
    ) -> dict[str, Any]:
        """不明瞭な論点の検知（#182 / ADR-0022）。矛盾でも抜けでもない第三の未解消検知。

        確定ゲート（07）・深掘り（06）の未解消件数へ算入される
        （web/store・API list_open_detections）。
        """
        self.ambiguous_published += 1
        return await self._emit(
            "detection.ambiguous",
            {
                "id": detection_id,
                "summary": summary,
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
        on_persist: Callable[[int], None] | None = None,
    ) -> dict[str, Any] | None:
        """通常質問（金枠 / #181）を web の問いピンへ出す（音声と併用）。

        ``options`` があればタップで user.answered が返る。無ければ自由記述（音声/テキスト）。
        ``on_persist`` を渡すと、**送信前に**現在質問を永続化する（ADR-0020 §5-1）。``on_persist``
        は予約した envelope seq を ``asked_seq`` として受け取り Firestore に保存する。保存に失敗
        したら送信せず採番も確定しない（復元できないイベントを表に出さない / 欠番も作らない）。
        質問は seq 境界（``set_session_seq``）を進めない一過性イベントである点は従来どおり（§3）。
        """
        payload: dict[str, Any] = {"id": question_id, "prompt": prompt}
        if options:
            payload["options"] = options
        env: dict[str, Any] | None
        if on_persist is None:
            env = await self._emit("question.asked", payload)
        else:

            def _before_send(seq: int) -> bool:
                on_persist(seq)  # 採番 → 保存（失敗時は例外で abort = 採番せず送らない）。
                return True

            env = await self._emit_guarded("question.asked", payload, before_send=_before_send)
        if env is not None:
            self.questions_published += 1
        return env

    async def question_cleared(
        self,
        question_id: str,
        *,
        on_persist: Callable[[int], bool],
    ) -> dict[str, Any] | None:
        """回答済み現在質問のクリアを全参加者へ伝播する（ADR-0020 §5-5 / §5-9）。

        ``on_persist(cleared_seq)`` で Firestore の tombstone を CAS commit してから publish する
        （順序は **予約 → commit → publish**）。``on_persist`` が False を返したら（現在質問 id が
        ``question_id`` と一致しない / 既にクリア済み）publish しない＝採番もしない（§5-3 / §5-7）。
        ``cleared_seq`` は本イベントの **envelope seq そのもの**（二重採番しない / §5-5）で、
        tombstone・live・GET の seq に同一値を使う。commit 後の送信失敗は ``EventPublishError``
        で返す（§5-9）。クリア対象を持たない問いの再送に強い（tombstone は冪等）。
        """
        payload: dict[str, Any] = {"question_id": question_id}
        env = await self._emit_guarded(
            "question.cleared",
            payload,
            before_send=on_persist,
            critical_send=True,
        )
        if env is not None:
            self.questions_cleared += 1
        return env

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


# user.text のサーバ側長さ上限（Codex P2）。従来の /context（max_context_chars）相当の
# ガードがデータチャネル経由には無いため、長大入力でメモリ/LLM コンテキストを浪費しないよう
# agent 受信境界で切り詰める。1ターンの発話としては十分広い値。
MAX_USER_TEXT_CHARS = 4000


def decode_user_text(payload: bytes | str, *, expected_session_id: str | None = None) -> str | None:
    """web → agent の user.text（契約 §4.5 / #185）をデコードする。

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


def decode_user_answered(
    payload: bytes | str, *, expected_session_id: str | None = None
) -> tuple[str, str] | None:
    """web → agent の user.answered（契約 §4.5 / #181）をデコードする。

    通常質問（金枠）への回答。``(question_id, answer)`` を返す。answer は選択肢値
    （selected_value）優先、無ければ自由記述（text）。どちらも無ければ None。
    自由記述は user.text と同じ上限（MAX_USER_TEXT_CHARS）で切り詰める（Codex P2）。
    user.answered.text/selected_value が user.text の防御を迂回するのを防ぐ。
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
    return question_id, answer.strip()[:MAX_USER_TEXT_CHARS]


def _get_tracer() -> Any:
    try:
        from opentelemetry import trace

        return trace.get_tracer("sanba.events")
    except Exception:  # pragma: no cover - otel optional
        return None
