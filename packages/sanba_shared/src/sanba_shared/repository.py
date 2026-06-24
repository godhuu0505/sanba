"""Firestore-backed persistence for sessions, utterances and requirements.

Stateless workers + external state => Cloud Run friendly (see docs/architecture.md §1).
Falls back to an in-memory store when Firestore is unavailable (e.g. unit tests).

このパッケージはアプリ config に依存しない: リテンション日数は `SessionRepository` の
コンストラクタ引数で受け取る (agent と api が別 settings を持つため / ADR-0014 §8)。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import structlog

from .models import (
    Requirement,
    RequirementStatus,
    SessionMeta,
    Utterance,
)
from .pii import mask_pii

log = structlog.get_logger(__name__)

# 上書き可能な要件フィールド (ADR-0014 §10)。出所メタ (id/created_at/source_speaker/
# confidence) はここに含めない = 人手で書き換えない。
EDITABLE_REQUIREMENT_FIELDS = frozenset({"statement", "priority", "category"})


class RequirementNotFound(Exception):
    """対象の要件が存在しないときに送出。"""


class SessionRepository:
    """Persistence boundary. Swap the backend without touching agent/api logic."""

    def __init__(self, data_retention_days: int = 30, mask_pii_before_persist: bool = True) -> None:
        self._retention_days = data_retention_days
        # 発話を永続化する前に PII をマスクするか（issue #10 / mask_pii_before_index）。
        # ドメイン層は app config に依存しないので、呼び出し側 (agent/api) が注入する。
        self._mask_pii = mask_pii_before_persist
        self._client = self._init_client()
        # In-memory fallback used when Firestore is not configured.
        self._mem_sessions: dict[str, SessionMeta] = {}
        self._mem_utterances: dict[str, list[Utterance]] = {}
        self._mem_requirements: dict[str, dict[str, Requirement]] = {}
        # 検知 (矛盾/抜け) と適用済み最大 seq (#94/#100)。ハイドレーションの土台。
        self._mem_detections: dict[str, dict[str, dict[str, Any]]] = {}
        self._mem_seq: dict[str, int] = {}

    @staticmethod
    def _init_client():  # type: ignore[no-untyped-def]
        try:
            from google.cloud import firestore

            return firestore.Client()
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("firestore_unavailable_using_memory", error=str(exc))
            return None

    def _expire_at(self) -> datetime | None:
        """Retention deadline for stored data (issue #10). None = keep indefinitely.

        Firestore deletes documents whose `expireAt` field is in the past, once a TTL
        policy is enabled on that field (see infra/terraform + docs/security.md).
        """
        days = self._retention_days
        return datetime.now(UTC) + timedelta(days=days) if days > 0 else None

    # ---- Sessions (ADR-0014 §4) -------------------------------------------
    def create_session_doc(self, meta: SessionMeta) -> None:
        """`sessions/{id}` 文書を作成する。一覧/閲覧/承認の土台になる。"""
        if self._client is not None:
            doc = meta.model_dump(mode="json")
            self._client.collection("sessions").document(meta.id).set(doc)
            return
        self._mem_sessions[meta.id] = meta

    def list_sessions(self) -> list[SessionMeta]:
        """全セッションのメタ一覧 (MVP: ページングなし / ADR-0014 保留事項)。"""
        if self._client is not None:
            docs = self._client.collection("sessions").stream()
            return [SessionMeta.model_validate(d.to_dict()) for d in docs]
        return list(self._mem_sessions.values())

    def get_session(self, session_id: str) -> SessionMeta | None:
        if self._client is not None:
            snap = self._client.collection("sessions").document(session_id).get()
            return SessionMeta.model_validate(snap.to_dict()) if snap.exists else None
        return self._mem_sessions.get(session_id)

    # ---- Utterances --------------------------------------------------------
    def add_utterance(self, session_id: str, utterance: Utterance) -> None:
        # PII を含みうる発話は永続化前にマスクする（issue #10 / #130 / mask_pii_before_index）。
        # grounding 索引は retrieval/ingestion 側でマスク済みだが、Firestore 保存経路でも
        # 同じ方針を適用し、生 PII が at-rest で残らないようにする。
        stored = utterance
        if self._mask_pii:
            stored = utterance.model_copy(update={"text": mask_pii(utterance.text)})
        if self._client is not None:
            doc = stored.model_dump(mode="json")
            if (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("utterances")
                .add(doc)
            )
            return
        self._mem_utterances.setdefault(session_id, []).append(stored)

    # ---- Requirements ------------------------------------------------------
    def save_requirement(self, session_id: str, requirement: Requirement) -> None:
        if self._client is not None:
            doc = requirement.model_dump(mode="json")
            # 承認済みは TTL の対象外 (§11)。それ以外はリテンション期限を付ける。
            if requirement.status is not RequirementStatus.APPROVED:
                if (exp := self._expire_at()) is not None:
                    doc["expireAt"] = exp
            self._req_doc(session_id, requirement.id).set(doc)
            return
        self._mem_requirements.setdefault(session_id, {})[requirement.id] = requirement

    def list_requirements(self, session_id: str) -> list[Requirement]:
        if self._client is not None:
            docs = (
                self._client.collection("sessions")
                .document(session_id)
                .collection("requirements")
                .stream()
            )
            return [Requirement.model_validate(d.to_dict()) for d in docs]
        return list(self._mem_requirements.get(session_id, {}).values())

    def get_requirement(self, session_id: str, rid: str) -> Requirement | None:
        if self._client is not None:
            snap = self._req_doc(session_id, rid).get()
            return Requirement.model_validate(snap.to_dict()) if snap.exists else None
        return self._mem_requirements.get(session_id, {}).get(rid)

    def update_requirement(
        self,
        session_id: str,
        rid: str,
        *,
        statement: str | None = None,
        priority: str | None = None,
        category: str | None = None,
    ) -> Requirement:
        """statement/priority/category のみ上書きする (ADR-0014 §10)。

        出所メタ (id/created_at/source_speaker/confidence) と承認状態は不変。
        """
        current = self.get_requirement(session_id, rid)
        if current is None:
            raise RequirementNotFound(rid)
        updates: dict[str, object] = {}
        if statement is not None:
            updates["statement"] = statement
        if priority is not None:
            updates["priority"] = priority
        if category is not None:
            updates["category"] = category
        if not updates:
            return current
        # dict に適用してから検証する (enum へのコアース・不正値検出を一度で行う)。
        data = current.model_dump()
        data.update(updates)
        updated = Requirement.model_validate(data)

        if self._client is not None:
            # merge=True は必須: model に無い expireAt (TTL センチネル) を消さず温存する。
            self._req_doc(session_id, rid).set(updated.model_dump(mode="json"), merge=True)
        else:
            self._mem_requirements.setdefault(session_id, {})[rid] = updated
        return updated

    def set_requirement_status(
        self,
        session_id: str,
        rid: str,
        status: RequirementStatus,
        approved_by: str | None = None,
    ) -> Requirement:
        """承認/却下/差し戻しを行う (ADR-0014 §11)。

        approved にしたら `expireAt` を削除して TTL の対象外にする。
        draft/rejected は `expireAt` を張り直して 30 日自動削除に任せる。
        """
        current = self.get_requirement(session_id, rid)
        if current is None:
            raise RequirementNotFound(rid)

        now = datetime.now(UTC)
        is_approved = status is RequirementStatus.APPROVED
        updated = current.model_copy(
            update={
                "status": status,
                "approved_by": approved_by if is_approved else None,
                "approved_at": now if is_approved else None,
            }
        )

        if self._client is not None:
            doc = updated.model_dump(mode="json")
            from google.cloud import firestore

            if is_approved:
                # null 代入では「null フィールド」が残り TTL が効き続ける懸念があるため
                # センチネルで明示削除する (ADR-0014 §17)。
                doc["expireAt"] = firestore.DELETE_FIELD
            elif (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            self._req_doc(session_id, rid).set(doc, merge=True)
        else:
            self._mem_requirements.setdefault(session_id, {})[rid] = updated
        return updated

    # ---- Detections (#94/#100) ---------------------------------------------
    def save_detection(self, session_id: str, detection: dict[str, Any]) -> None:
        """検知 (矛盾/抜け) を Firestore に upsert する (#94/#100)。

        ハイドレーション (GET /detections?open=1) でリロード/途中参加時に未解消検知を
        復元できるよう、publish だけでなく永続化する (Codex review 対応)。
        """
        detection_id = detection["id"]
        if self._client is not None:
            doc = dict(detection)
            if (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("detections")
                .document(detection_id)
                .set(doc, merge=True)
            )
            return
        self._mem_detections.setdefault(session_id, {})[detection_id] = dict(detection)

    def resolve_detection(self, session_id: str, detection_id: str, resolution: str) -> None:
        """検知を解消済みに更新する。open スナップショットから外れるようにする。"""
        patch: dict[str, Any] = {"resolved": True, "resolution": resolution}
        if self._client is not None:
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("detections")
                .document(detection_id)
                .set(patch, merge=True)
            )
            return
        existing = self._mem_detections.setdefault(session_id, {}).get(detection_id)
        if existing is not None:
            existing.update(patch)

    def set_session_seq(self, session_id: str, seq: int) -> None:
        """セッションの適用済み最大 seq を保存する (ハイドレーション境界, 契約 §4)。"""
        if self._client is not None:
            (
                self._client.collection("sessions")
                .document(session_id)
                .set({"last_seq": seq}, merge=True)
            )
            return
        self._mem_seq[session_id] = seq

    # ---- internal ----------------------------------------------------------
    def _req_doc(self, session_id: str, rid: str):  # type: ignore[no-untyped-def]
        return (
            self._client.collection("sessions")
            .document(session_id)
            .collection("requirements")
            .document(rid)
        )
