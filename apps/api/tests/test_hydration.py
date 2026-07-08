"""Tests for hydration & export APIs (contract §4).

トークン認可（join 済みトークン必須）と、要件/検知のスナップショット整形・起票を検証する。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth import create_session_token
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.main import _read_repo, _repo, app

client = TestClient(app)


def _fake_user() -> AuthUser:
    return AuthUser(sub="owner-123456789", email="o@example.com", email_verified=True, name="Owner")


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    app.dependency_overrides[require_user] = _fake_user
    _read_repo._mem_requirements.clear()
    _read_repo._mem_detections.clear()
    _read_repo._mem_questions.clear()
    yield
    app.dependency_overrides.pop(require_user, None)


def _token(session_id: str, role: str = "pm") -> str:
    return create_session_token(
        session_id, "owner-123456789", role, settings.session_signing_secret, 3600
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_requirement_status_maps_admin_axis_to_conversation_axis() -> None:
    from sanba_api.repository import requirement_doc_to_contract

    def status_of(admin: str | None) -> str:
        doc = {"id": "r", "statement": "x", "category": "functional", "priority": "must"}
        if admin is not None:
            doc["status"] = admin
        return requirement_doc_to_contract(doc)["status"]

    assert status_of("draft") == "confirmed"
    assert status_of("approved") == "confirmed"
    assert status_of(None) == "confirmed"
    assert status_of("rejected") == "draft"


def test_requirements_requires_session_token() -> None:
    res = client.get("/api/sessions/sess-1/requirements")
    assert res.status_code == 401


def test_requirements_rejects_token_for_other_session() -> None:
    res = client.get("/api/sessions/sess-1/requirements", headers=_auth(_token("sess-OTHER")))
    assert res.status_code == 403


def test_requirements_rejects_tampered_token() -> None:
    tampered = _token("sess-1")[:-2] + "xx"
    res = client.get("/api/sessions/sess-1/requirements", headers=_auth(tampered))
    assert res.status_code == 403


def test_requirements_snapshot_shape() -> None:
    _read_repo._seed_requirement(
        "sess-1",
        {
            "id": "r1",
            "statement": "キーワード検索を新設する",
            "category": "functional",
            "priority": "must",
            "confidence": 0.9,
            "source_speaker": "顧客",
        },
    )
    res = client.get("/api/sessions/sess-1/requirements", headers=_auth(_token("sess-1")))
    assert res.status_code == 200
    body = res.json()
    assert body["seq"] == 0
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["id"] == "r1"
    assert item["priority"] == "must"
    assert item["citations"] == []
    assert item["status"] == "confirmed"


def test_detections_returns_only_unresolved() -> None:
    _read_repo._seed_detection(
        "sess-2", {"id": "d1", "kind": "gap", "summary": "性能未確認", "resolved": False}
    )
    _read_repo._seed_detection(
        "sess-2", {"id": "d2", "kind": "contradiction", "summary": "解消済み", "resolved": True}
    )
    res = client.get("/api/sessions/sess-2/detections?open=1", headers=_auth(_token("sess-2")))
    assert res.status_code == 200
    items = res.json()["items"]
    assert [d["id"] for d in items] == ["d1"]


def test_requirements_returns_persisted_seq_boundary() -> None:
    _read_repo._seed_requirement(
        "sess-seq",
        {"id": "r1", "statement": "x", "category": "functional", "priority": "must"},
    )
    _read_repo._seed_seq("sess-seq", 42)
    res = client.get("/api/sessions/sess-seq/requirements", headers=_auth(_token("sess-seq")))
    assert res.json()["seq"] == 42


def test_current_question_requires_session_token() -> None:
    res = client.get("/api/sessions/sess-q/questions/current")
    assert res.status_code == 401


def test_current_question_rejects_token_for_other_session() -> None:
    res = client.get("/api/sessions/sess-q/questions/current", headers=_auth(_token("sess-OTHER")))
    assert res.status_code == 403


def test_current_question_returns_active_question_with_asked_seq() -> None:
    _read_repo._seed_question(
        "sess-q",
        {
            "id": "q1",
            "prompt": "並び順は何を既定にしますか",
            "options": [{"label": "関連度順", "value": "関連度順"}],
            "asked_seq": 5,
            "cleared": False,
        },
    )
    res = client.get("/api/sessions/sess-q/questions/current", headers=_auth(_token("sess-q")))
    assert res.status_code == 200
    body = res.json()
    assert body["seq"] == 5
    assert body["question"]["id"] == "q1"
    assert body["question"]["prompt"].startswith("並び順")
    assert body["question"]["options"][0]["value"] == "関連度順"


def test_current_question_returns_null_with_cleared_seq_for_tombstone() -> None:
    _read_repo._seed_question(
        "sess-q",
        {"id": "q1", "cleared": True, "cleared_seq": 8},
    )
    res = client.get("/api/sessions/sess-q/questions/current", headers=_auth(_token("sess-q")))
    assert res.status_code == 200
    body = res.json()
    assert body["question"] is None
    assert body["seq"] == 8


def test_current_question_returns_null_seq_zero_when_unset() -> None:
    res = client.get("/api/sessions/sess-q/questions/current", headers=_auth(_token("sess-q")))
    assert res.status_code == 200
    body = res.json()
    assert body["question"] is None
    assert body["seq"] == 0


def test_finalize_requires_session_token() -> None:
    res = client.post("/api/sessions/sess-fin/finalize")
    assert res.status_code == 401


def test_finalize_unknown_session_404() -> None:
    res = client.post("/api/sessions/sess-unknown/finalize", headers=_auth(_token("sess-unknown")))
    assert res.status_code == 404


def test_finalize_marks_session_and_counts_confirmed() -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {
            "id": "c1",
            "statement": "確定",
            "category": "functional",
            "priority": "must",
            "status": "confirmed",
        },
    )
    _read_repo._seed_requirement(
        sid,
        {
            "id": "d1",
            "statement": "却下",
            "category": "scope",
            "priority": "should",
            "status": "rejected",
        },
    )
    res = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert res.status_code == 200
    body = res.json()
    assert body["finalized"] is True
    assert body["confirmed_count"] == 1
    meta = _repo.get_session(sid)
    assert meta is not None
    assert meta.status == "finalized"
    assert meta.finalized_count == 1
    assert meta.finalized_at is not None
    assert meta.finalized_requirement_ids == ["c1"]
    assert meta.labels == ["sanba", "priority:must", "functional"], (
        "確定時に AI ラベル（priority/category 由来）を永続化する（P1-c）"
    )


def test_finalize_approves_confirmed_requirements_for_preservation() -> None:
    """確定時集合は approved になり TTL 保全の対象になる。

    管理画面の承認 UI 廃止に伴い、draft のまま 30 日 TTL で消えると過去要件閲覧
    （/sessions/{id}）と export が欠落する。finalize が set_requirement_status(APPROVED)
    を通すことで expireAt が外れる（TTL 削除自体は Firestore 経路の既存責務）。
    """
    from sanba_shared.models import Priority, Requirement, RequirementCategory

    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _repo.save_requirement(
        sid,
        Requirement(
            id="c1",
            statement="確定",
            category=RequirementCategory.FUNCTIONAL,
            priority=Priority.MUST,
        ),
    )
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    res = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert res.status_code == 200
    stored = _repo.get_requirement(sid, "c1")
    assert stored is not None
    assert stored.status.value == "approved"
    assert stored.approved_by == "owner-123456789"
    assert stored.approved_at is not None


def test_finalize_survives_missing_requirement_on_preservation() -> None:
    """読み出し側にだけ在る要件（TTL 失効等）は保全をスキップし finalize は成立する。"""
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "gone", "statement": "消えた", "category": "scope", "priority": "should"}
    )
    res = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert res.status_code == 200
    assert res.json()["confirmed_count"] == 1


def test_finalize_rejects_when_unresolved_detections_remain() -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_detection(
        sid, {"id": "d1", "kind": "gap", "summary": "性能未確認", "resolved": False}
    )
    res = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert res.status_code == 409
    meta = _repo.get_session(sid)
    assert meta is not None
    assert meta.status != "finalized"


def test_finalize_is_idempotent_and_keeps_first_snapshot() -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    first = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert first.json()["confirmed_count"] == 1
    meta1 = _repo.get_session(sid)
    assert meta1 is not None
    first_at = meta1.finalized_at

    _read_repo._seed_requirement(
        sid, {"id": "c2", "statement": "後から追加", "category": "scope", "priority": "should"}
    )
    second = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert second.status_code == 200
    assert second.json()["confirmed_count"] == 1
    meta2 = _repo.get_session(sid)
    assert meta2 is not None
    assert meta2.finalized_count == 1
    assert meta2.finalized_at == first_at


def test_finalize_idempotent_even_with_late_open_detection() -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    first = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert first.status_code == 200
    _read_repo._seed_detection(
        sid, {"id": "d-late", "kind": "gap", "summary": "後追い", "resolved": False}
    )
    again = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert again.status_code == 200
    assert again.json()["confirmed_count"] == 1


def test_export_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "github_repo", "")
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    assert res.status_code == 200
    body = res.json()
    assert body["exported"] is False
    assert body["reason"]


class _FakeAppClient:
    """操作者本人の installation を模した App クライアント（起票捕捉つき）。"""

    def __init__(self, captured: dict[str, object], repos: set[str]) -> None:
        self._captured = captured
        self._repos = repos

    def repo_full_names(self, installation_id: int) -> set[str]:
        return self._repos

    def create_issue(
        self,
        installation_id: int,
        repo: str,
        title: str,
        body: str,
        labels: list[str] | None = None,
    ) -> str:
        self._captured["installation_id"] = installation_id
        self._captured["repo"] = repo
        self._captured["body"] = body
        self._captured["labels"] = labels
        return "https://github.com/o/r/issues/1"

    def close(self) -> None:
        pass


def _enable_github(
    monkeypatch: pytest.MonkeyPatch,
    *,
    linked: bool = True,
    repos: set[str] | None = None,
) -> dict[str, object]:
    """操作者本人の GitHub App installation を有効化し、create_issue を捕捉する（ADR-0053）。

    共有 PAT ではなく App installation token 経由の起票を模す。`linked=False` で未連携、
    `repos` で installation がアクセスできる repo 集合を差し替える（権限ゲートの検証用）。
    """
    from sanba_shared.models import GitHubLink

    from sanba_api import deps
    from sanba_api.routers import sessions as sessions_router

    monkeypatch.setattr(settings, "github_repo", "o/r")
    captured: dict[str, object] = {}
    allowed = repos if repos is not None else {"o/r", "acme/product-a"}

    def _client() -> _FakeAppClient:
        return _FakeAppClient(captured, allowed)

    monkeypatch.setattr(deps, "_github_app_client", _client)
    monkeypatch.setattr(sessions_router, "_github_app_client", _client)

    link = (
        GitHubLink(sub="owner-123456789", installation_id=99, github_login="dev")
        if linked
        else None
    )
    monkeypatch.setattr(
        _repo, "get_github_link", lambda sub: link if sub == "owner-123456789" else None
    )
    return captured


def test_export_uses_session_selected_repo(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "acme/product-a"},
    )
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    assert res.json()["exported"] is True
    assert captured["repo"] == "acme/product-a"
    assert captured["labels"] == ["sanba", "priority:must", "functional"]


def test_export_respects_explicit_opt_out(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": ""},
    )
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is False
    assert "repo" not in captured


def test_export_fallback_repo_outside_allowlist_is_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    monkeypatch.setattr(settings, "github_repo_allowlist", "acme")
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is False
    assert body["reason"] == "github repo not allowed"
    assert "repo" not in captured


def test_export_falls_back_to_env_repo_without_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    assert res.json()["exported"] is True
    assert captured["repo"] == "o/r"


def test_export_blocked_when_user_not_linked(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    captured = _enable_github(monkeypatch, linked=False)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is False
    assert body["reason"] == "github not linked"
    assert "repo" not in captured


def test_export_blocked_when_user_lacks_repo_access(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    captured = _enable_github(monkeypatch, repos={"someone-else/other"})
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is False
    assert body["reason"] == "no repo access"
    assert "repo" not in captured


def test_export_body_records_exporter(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    assert captured["installation_id"] == 99
    assert "export by dev" in str(captured["body"])
    assert sid in str(captured["body"])


def test_export_eligibility_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _enable_github(monkeypatch)
    ok = client.get(f"/api/sessions/{sid}/export/eligibility", headers=_auth(_token(sid)))
    assert ok.status_code == 200
    body = ok.json()
    assert body["can_export"] is True
    assert body["repo"] == "o/r"

    _enable_github(monkeypatch, linked=False)
    ng = client.get(f"/api/sessions/{sid}/export/eligibility", headers=_auth(_token(sid)))
    assert ng.json()["can_export"] is False
    assert ng.json()["reason"] == "github not linked"


def test_my_export_eligibility_uses_login_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _enable_github(monkeypatch)
    ok = client.get(f"/api/sessions/mine/{sid}/export/eligibility")
    assert ok.status_code == 200
    assert ok.json()["can_export"] is True
    assert ok.json()["repo"] == "o/r"


def test_my_export_creates_issue_via_login(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/mine/{sid}/export")
    assert res.json()["exported"] is True
    assert captured["repo"] == "o/r"
    assert "export by dev" in str(captured["body"])


def test_my_export_blocked_when_not_linked(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    captured = _enable_github(monkeypatch, linked=False)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/mine/{sid}/export")
    assert res.json()["exported"] is False
    assert res.json()["reason"] == "github not linked"
    assert "repo" not in captured


def test_my_export_hidden_from_non_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    app.dependency_overrides[require_user] = lambda: AuthUser(
        sub="intruder-000", email="x@example.com", email_verified=True, name="X"
    )
    try:
        elig = client.get(f"/api/sessions/mine/{sid}/export/eligibility")
        exp = client.post(f"/api/sessions/mine/{sid}/export")
    finally:
        app.dependency_overrides[require_user] = _fake_user
    assert elig.status_code == 404
    assert exp.status_code == 404


def test_export_uses_only_confirmed_requirements(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {
            "id": "c1",
            "statement": "確定",
            "category": "functional",
            "priority": "must",
            "status": "approved",
        },
    )
    _read_repo._seed_requirement(
        sid,
        {
            "id": "d1",
            "statement": "却下",
            "category": "scope",
            "priority": "should",
            "status": "rejected",
        },
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is True
    assert body["count"] == 1
    assert "却下" not in str(captured["body"])


def test_export_uses_finalized_snapshot_not_recomputed(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定済み", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    fin = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert fin.json()["confirmed_count"] == 1

    _read_repo._seed_requirement(
        sid,
        {"id": "c2", "statement": "後から追加", "category": "scope", "priority": "should"},
    )
    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is True
    assert body["count"] == 1
    assert "確定済み" in str(captured["body"])
    assert "後から追加" not in str(captured["body"])


def test_export_keeps_finalized_requirement_even_if_later_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定要件", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    _read_repo._mem_requirements[sid][0]["status"] = "rejected"
    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["count"] == 1
    assert "確定要件" in str(captured["body"])


def test_export_falls_back_for_legacy_finalized_without_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "旧確定要件", "category": "functional", "priority": "must"},
    )
    meta = _repo.get_session(sid)
    assert meta is not None
    _repo._mem_sessions[sid] = meta.model_copy(
        update={"status": "finalized", "finalized_count": 1, "finalized_requirement_ids": []}
    )
    captured = _enable_github(monkeypatch)
    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is True
    assert body["count"] == 1
    assert "旧確定要件" in str(captured["body"])


def test_finalize_then_export_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"},
    )
    _enable_github(monkeypatch)
    first_fin = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    _read_repo._seed_requirement(
        sid,
        {"id": "c2", "statement": "後から", "category": "scope", "priority": "should"},
    )
    second_fin = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert first_fin.json()["confirmed_count"] == second_fin.json()["confirmed_count"] == 1
    assert _repo.get_session(sid).finalized_requirement_ids == ["c1"]

    first_exp = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    second_exp = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    assert first_exp.json()["count"] == second_exp.json()["count"] == 1
