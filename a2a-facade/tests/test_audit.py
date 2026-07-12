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


def _send(text: str = "本番のエラーは？", caller: str = "") -> dict:
    params: dict[str, Any] = {
        "message": {
            "messageId": "req-1",
            "role": "user",
            "parts": [{"text": text}],
        }
    }
    if caller:
        params["metadata"] = {"caller": caller}
    return {"jsonrpc": "2.0", "id": "req-1", "method": "message/send", "params": params}


def _client(backend: FakeBackend, audit: Any) -> TestClient:
    cfg = FacadeSettings(agent_id="sanba-sre-scout")
    return TestClient(create_app(backend, cfg, audit))


def _post(client: TestClient, text: str = "本番のエラーは？", caller: str = "") -> dict:
    return client.post(
        "/a2a/sanba-sre-scout", json=_send(text, caller), headers=VERSION_HEADERS
    ).json()


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


def test_records_carry_caller_and_ttl_expiry():
    audit = RecordingAudit()
    _post(_client(FakeBackend(answer="エラーなし"), audit), caller="sess-abc123")
    for _, rec in audit.calls:
        assert rec["caller"] == "sess-abc123"
        assert rec["expire_at"] is not None


def test_pii_is_masked_before_persisting():
    audit = RecordingAudit()
    _post(
        _client(FakeBackend(answer="連絡先は ops@example.com、電話 090-1234-5678 です"), audit),
        text="user@example.com のセッションを調べて",
    )
    done = audit.calls[-1][1]
    assert "@example.com" not in done["result"]
    assert "090-1234-5678" not in done["result"]
    assert "[EMAIL]" in done["result"]
    assert "@example.com" not in done["question"]


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
