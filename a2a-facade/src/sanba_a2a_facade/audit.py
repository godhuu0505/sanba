"""委譲レコードの監査ストア（ADR-0069 / issue #547）。

durable sync 方式のため submit/poll は持たないが、委譲の事実（誰が・何を・結果・所要）を
sanba-ops Firestore に 1 レコード残す。同一 `request_id` は冪等に上書きする。書き込み失敗は
fail-soft（調査本体は止めない）。レコードの組み立てはネットワーク非依存の純関数として切り出し、
単体テストで固定する。
"""

from __future__ import annotations

from typing import Any, Protocol

RUNNING = "running"
DONE = "done"
ERROR = "error"


def build_record(
    request_id: str,
    question: str,
    *,
    status: str,
    caller: str = "",
    result: str = "",
    error: str = "",
    started_at: str = "",
    finished_at: str = "",
) -> dict[str, Any]:
    """Firestore へ書く委譲レコードを組み立てる（純関数）。"""
    return {
        "request_id": request_id,
        "question": question,
        "status": status,
        "caller": caller,
        "result": result,
        "error": error,
        "started_at": started_at,
        "finished_at": finished_at,
    }


class AuditStore(Protocol):
    def upsert(self, request_id: str, record: dict[str, Any]) -> None: ...


class NoopAuditStore:
    """監査無効時（未設定）の縮退。何もしない。"""

    def upsert(self, request_id: str, record: dict[str, Any]) -> None:
        return None


class FirestoreAuditStore:
    """sanba-ops Firestore へ委譲レコードを冪等 upsert する。"""

    def __init__(self, project: str, collection: str = "holmes-investigations") -> None:
        self._project = project
        self._collection = collection
        self._client: Any = None

    def _lazy_client(self) -> Any:  # pragma: no cover
        if self._client is None:
            from google.cloud import firestore

            self._client = firestore.Client(project=self._project)
        return self._client

    def upsert(self, request_id: str, record: dict[str, Any]) -> None:  # pragma: no cover
        self._lazy_client().collection(self._collection).document(request_id).set(record)
