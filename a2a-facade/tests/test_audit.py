from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from sanba_a2a_facade.app import build_audit_store, create_app
from sanba_a2a_facade.audit import DONE, ERROR, RUNNING, NoopAuditStore, build_record
from sanba_a2a_facade.config import FacadeSettings


def test_build_record_shape():
    record = build_record(
        "req-1", "本番のエラーは？", status=RUNNING, caller="agent", started_at="t0"
    )
    assert record["request_id"] == "req-1"
    assert record["question"] == "本番のエラーは？"
    assert record["status"] == RUNNING
    assert record["result"] == ""


def test_build_audit_store_is_noop_when_unconfigured():
    assert isinstance(build_audit_store(FacadeSettings(audit_enabled=False)), NoopAuditStore)
    assert isinstance(
        build_audit_store(FacadeSettings(audit_enabled=True, firestore_project="")),
        NoopAuditStore,
    )


class RecordingAudit:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def upsert(self, request_id: str, record: dict[str, Any]) -> None:
        self.calls.append((request_id, record))


class FakeBackend:
    name = "SANBA SRE Scout"
    description = "read-only"

    def __init__(self, answer: str = "エラーなし", error: Exception | None = None) -> None:
        self._answer = answer
        self._error = error

    def skills(self) -> list[dict[str, Any]]:
        return []

    def ask(self, text: str, *, timeout: float = 300.0) -> str:
        if self._error:
            raise self._error
        return self._answer

    def submit(self, text: str) -> str:
        raise NotImplementedError

    def poll(self, task_id: str) -> tuple[str, str | None]:
        raise NotImplementedError


VERSION_HEADERS = {"A2A-Version": "0.3"}


def _send(text: str = "本番のエラーは？") -> dict:
    return {
        "jsonrpc": "2.0",
        "id": "req-1",
        "method": "message/send",
        "params": {
            "message": {
                "messageId": "req-1",
                "role": "user",
                "parts": [{"text": text}],
            }
        },
    }


def _client(backend: FakeBackend, audit: Any) -> TestClient:
    cfg = FacadeSettings(agent_id="sanba-sre-scout")
    return TestClient(create_app(backend, cfg, audit))


def _post(client: TestClient) -> dict:
    return client.post("/a2a/sanba-sre-scout", json=_send(), headers=VERSION_HEADERS).json()


def test_success_writes_running_then_done():
    audit = RecordingAudit()
    _post(_client(FakeBackend(answer="エラーなし"), audit))
    statuses = [rec["status"] for _, rec in audit.calls]
    assert statuses == [RUNNING, DONE]
    assert audit.calls[-1][1]["result"] == "エラーなし"
    assert audit.calls[-1][1]["finished_at"] != ""


def test_running_and_done_share_the_same_doc_id():
    audit = RecordingAudit()
    _post(_client(FakeBackend(answer="エラーなし"), audit))
    doc_ids = {doc_id for doc_id, _ in audit.calls}
    assert len(doc_ids) == 1


def test_failure_writes_running_then_error():
    audit = RecordingAudit()
    _post(_client(FakeBackend(error=OSError("boom")), audit))
    statuses = [rec["status"] for _, rec in audit.calls]
    assert statuses == [RUNNING, ERROR]
    assert "boom" in audit.calls[-1][1]["error"]


def test_audit_failure_is_fail_soft():
    class BoomAudit:
        def upsert(self, request_id: str, record: dict[str, Any]) -> None:
            raise RuntimeError("firestore down")

    result = _post(_client(FakeBackend(answer="ok"), BoomAudit()))["result"]
    assert result["status"]["state"] == "completed"
    assert result["artifacts"][0]["parts"][0]["text"] == "ok"
