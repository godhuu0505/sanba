"""Firestore-backed persistence for sessions, utterances and requirements.

Stateless workers + external state => Cloud Run friendly (see docs/architecture.md §1).
Falls back to an in-memory store when Firestore is unavailable (e.g. unit tests).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import structlog

from .config import settings
from .models import Requirement, Utterance

log = structlog.get_logger(__name__)


def _expire_at() -> datetime | None:
    """Retention deadline for stored data (issue #10). None = keep indefinitely.

    Firestore deletes documents whose `expireAt` field is in the past, once a TTL
    policy is enabled on that field (see infra/terraform + docs/security.md).
    """
    days = settings.data_retention_days
    return datetime.now(UTC) + timedelta(days=days) if days > 0 else None


class SessionRepository:
    """Persistence boundary. Swap the backend without touching agent logic."""

    def __init__(self) -> None:
        self._client = self._init_client()
        # In-memory fallback used when Firestore is not configured.
        self._mem_utterances: dict[str, list[Utterance]] = {}
        self._mem_requirements: dict[str, dict[str, Requirement]] = {}
        self._mem_detections: dict[str, dict[str, dict]] = {}
        self._mem_seq: dict[str, int] = {}

    @staticmethod
    def _init_client():  # type: ignore[no-untyped-def]
        try:
            from google.cloud import firestore

            return firestore.Client()
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("firestore_unavailable_using_memory", error=str(exc))
            return None

    def add_utterance(self, session_id: str, utterance: Utterance) -> None:
        if self._client is not None:
            doc = utterance.model_dump(mode="json")
            if (exp := _expire_at()) is not None:
                doc["expireAt"] = exp
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("utterances")
                .add(doc)
            )
            return
        self._mem_utterances.setdefault(session_id, []).append(utterance)

    def save_requirement(self, session_id: str, requirement: Requirement) -> None:
        if self._client is not None:
            doc = requirement.model_dump(mode="json")
            if (exp := _expire_at()) is not None:
                doc["expireAt"] = exp
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("requirements")
                .document(requirement.id)
                .set(doc)
            )
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

    def save_detection(self, session_id: str, detection: dict) -> None:
        """検知（矛盾/抜け）を Firestore に upsert する（#94/#100）。

        ハイドレーション（GET /detections?open=1）でリロード/途中参加時に未解消検知を
        復元できるよう、publish だけでなく永続化する（Codex review 対応）。
        """
        detection_id = detection["id"]
        if self._client is not None:
            doc = dict(detection)
            if (exp := _expire_at()) is not None:
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
        patch = {"resolved": True, "resolution": resolution}
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
        """セッションの適用済み最大 seq を保存する（ハイドレーション境界, 契約 §4）。"""
        if self._client is not None:
            (
                self._client.collection("sessions")
                .document(session_id)
                .set({"last_seq": seq}, merge=True)
            )
            return
        self._mem_seq[session_id] = seq
