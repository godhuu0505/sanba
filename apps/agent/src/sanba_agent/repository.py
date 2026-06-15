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
