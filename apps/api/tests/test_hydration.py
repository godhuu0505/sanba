"""Tests for hydration & export APIs (Issue #100, contract §4).

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
    # 各テストはインメモリ読み出しを使う（Firestore 無し環境）。
    _read_repo._mem_requirements.clear()
    _read_repo._mem_detections.clear()
    yield
    app.dependency_overrides.pop(require_user, None)


def _token(session_id: str, role: str = "pm") -> str:
    return create_session_token(
        session_id, "owner-123456789", role, settings.session_signing_secret, 3600
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── 要件 status の軸マッピング（Codex P1）───────────────────────────────────
def test_requirement_status_maps_admin_axis_to_conversation_axis() -> None:
    from sanba_api.repository import requirement_doc_to_contract

    def status_of(admin: str | None) -> str:
        doc = {"id": "r", "statement": "x", "category": "functional", "priority": "must"}
        if admin is not None:
            doc["status"] = admin
        return requirement_doc_to_contract(doc)["status"]

    # save_requirement 由来（管理軸 draft 既定）や approved は会話上「確定」。
    assert status_of("draft") == "confirmed"
    assert status_of("approved") == "confirmed"
    assert status_of(None) == "confirmed"
    # 管理画面で却下されたものだけ会話上も未確定（起票/確定の対象外）。
    assert status_of("rejected") == "draft"


# ── 認可 ──────────────────────────────────────────────────────────────────
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


# ── GET /requirements（P0）────────────────────────────────────────────────
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
    # 契約 §3 の requirement 形（citations / status 補完）。
    assert item["id"] == "r1"
    assert item["priority"] == "must"
    assert item["citations"] == []
    assert item["status"] == "confirmed"


# ── GET /detections?open=1（P1）───────────────────────────────────────────
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
    # 適用済み最大 seq をハイドレーション境界として返す（seq=0 固定にしない）。
    _read_repo._seed_requirement(
        "sess-seq",
        {"id": "r1", "statement": "x", "category": "functional", "priority": "must"},
    )
    _read_repo._seed_seq("sess-seq", 42)
    res = client.get("/api/sessions/sess-seq/requirements", headers=_auth(_token("sess-seq")))
    assert res.json()["seq"] == 42


# ── POST /finalize（#186）──────────────────────────────────────────────────
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
            # 管理画面で却下された要件は会話上の確定からも外れる（contract: draft）。
            "status": "rejected",
        },
    )
    res = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert res.status_code == 200
    body = res.json()
    assert body["finalized"] is True
    assert body["confirmed_count"] == 1  # 却下を除く確定要件のみ数える
    # セッションが finalized に遷移し、確定件数が刻まれる（不可逆マーカ）。
    meta = _repo.get_session(sid)
    assert meta is not None
    assert meta.status == "finalized"
    assert meta.finalized_count == 1
    assert meta.finalized_at is not None
    # 確定時の要件 ID スナップショット（#213）。却下を除く確定要件のみ。
    assert meta.finalized_requirement_ids == ["c1"]


def test_finalize_rejects_when_unresolved_detections_remain() -> None:
    # 07 判定の「未解消 0 件で確定可」をサーバ側でも担保（Codex P2）。
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_detection(
        sid, {"id": "d1", "kind": "gap", "summary": "性能未確認", "resolved": False}
    )
    res = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert res.status_code == 409
    # 拒否されたのでセッションは finalized にならない。
    meta = _repo.get_session(sid)
    assert meta is not None
    assert meta.status != "finalized"


def test_finalize_is_idempotent_and_keeps_first_snapshot() -> None:
    # 再確定/二重 POST しても最初のスナップショット件数を保つ（上書きしない / Codex P2）。
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

    # 確定後に要件が増えても、再 finalize は最初の件数・刻を変えない。
    _read_repo._seed_requirement(
        sid, {"id": "c2", "statement": "後から追加", "category": "scope", "priority": "should"}
    )
    second = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert second.status_code == 200
    assert second.json()["confirmed_count"] == 1  # 1 のまま（2 にならない）
    meta2 = _repo.get_session(sid)
    assert meta2 is not None
    assert meta2.finalized_count == 1
    assert meta2.finalized_at == first_at  # 刻も保持


def test_finalize_idempotent_even_with_late_open_detection() -> None:
    # 既 finalized なら、後から open 検知が付いても再 POST は 409 にならず保存値を返す（Codex P2）。
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid, {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"}
    )
    first = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert first.status_code == 200
    # 確定後に遅延した agent が未解消検知を保存しても、再 POST は冪等に成功する。
    _read_repo._seed_detection(
        sid, {"id": "d-late", "kind": "gap", "summary": "後追い", "resolved": False}
    )
    again = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert again.status_code == 200
    assert again.json()["confirmed_count"] == 1


# ── POST /export（P1）──────────────────────────────────────────────────────
def test_export_disabled_by_default() -> None:
    res = client.post("/api/sessions/sess-3/export", headers=_auth(_token("sess-3")))
    assert res.status_code == 200
    body = res.json()
    assert body["exported"] is False
    assert body["reason"]


def _enable_github(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """GitHub connector を有効化し、create_issue を捕捉スタブに差し替える。"""
    from sanba_api import github_export, main

    monkeypatch.setattr(settings, "github_connector_enabled", True)
    monkeypatch.setattr(settings, "github_token", "t")
    monkeypatch.setattr(settings, "github_repo", "o/r")
    captured: dict[str, object] = {}

    def fake_create_issue(token: str, repo: str, title: str, body: str) -> str:
        captured["body"] = body
        return "https://github.com/o/r/issues/1"

    monkeypatch.setattr(github_export, "create_issue", fake_create_issue)
    monkeypatch.setattr(main.github_export, "create_issue", fake_create_issue)
    return captured


def test_export_uses_only_confirmed_requirements(monkeypatch: pytest.MonkeyPatch) -> None:
    # 却下(rejected)を Issue 化せず、count は確定要件数に一致する（会話確定軸 / Codex P1）。
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {
            "id": "c1",
            "statement": "確定",
            "category": "functional",
            "priority": "must",
            # 管理軸 approved も会話上は確定（contract: confirmed）。
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
    # export は finalize 時に凍結した集合を起票する（#213）。まず確定する。
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is True
    assert body["count"] == 1  # 却下を除く確定のみ
    assert "却下" not in str(captured["body"])


def test_export_uses_finalized_snapshot_not_recomputed(monkeypatch: pytest.MonkeyPatch) -> None:
    # 受け入れ基準: finalize 後に要件が増えても export は確定時集合のみ起票する（#213）。
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定済み", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    fin = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert fin.json()["confirmed_count"] == 1

    # 確定後に遅延 agent が新しい確定要件を追加しても、export には現れない。
    _read_repo._seed_requirement(
        sid,
        {"id": "c2", "statement": "後から追加", "category": "scope", "priority": "should"},
    )
    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is True
    assert body["count"] == 1  # 確定時集合（c1）のみ。c2 は含めない。
    assert "確定済み" in str(captured["body"])
    assert "後から追加" not in str(captured["body"])


def test_export_keeps_finalized_requirement_even_if_later_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 確定時集合は不可逆。finalize 後に却下されても確定時に含まれていれば起票され続ける（#213）。
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定要件", "category": "functional", "priority": "must"},
    )
    captured = _enable_github(monkeypatch)
    client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))

    # 確定後に管理画面で却下しても、確定時スナップショットに含まれるので起票対象に残る。
    _read_repo._mem_requirements[sid][0]["status"] = "rejected"
    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["count"] == 1
    assert "確定要件" in str(captured["body"])


def test_export_falls_back_for_legacy_finalized_without_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 後方互換: 本機能デプロイ前に finalized（snapshot 欠落・count>0）だったセッションは、
    # 空 Issue ではなく確定要件を再計算して起票する（Codex P1）。
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "旧確定要件", "category": "functional", "priority": "must"},
    )
    # 旧データを模す: finalized だが finalized_requirement_ids は空、count は確定時の値。
    meta = _repo.get_session(sid)
    assert meta is not None
    _repo._mem_sessions[sid] = meta.model_copy(
        update={"status": "finalized", "finalized_count": 1, "finalized_requirement_ids": []}
    )
    captured = _enable_github(monkeypatch)
    res = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    body = res.json()
    assert body["exported"] is True
    assert body["count"] == 1  # 空 Issue にせず確定要件を起票
    assert "旧確定要件" in str(captured["body"])


def test_finalize_then_export_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    # 二重 finalize / finalize 後の複数回 export が同じ確定時集合を返す（冪等 / #213）。
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    sid = created.json()["session_id"]
    _read_repo._seed_requirement(
        sid,
        {"id": "c1", "statement": "確定", "category": "functional", "priority": "must"},
    )
    _enable_github(monkeypatch)
    first_fin = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    # 二重 finalize しても確定時集合（ID）は変わらない。
    _read_repo._seed_requirement(
        sid,
        {"id": "c2", "statement": "後から", "category": "scope", "priority": "should"},
    )
    second_fin = client.post(f"/api/sessions/{sid}/finalize", headers=_auth(_token(sid)))
    assert first_fin.json()["confirmed_count"] == second_fin.json()["confirmed_count"] == 1
    assert _repo.get_session(sid).finalized_requirement_ids == ["c1"]

    # export を複数回叩いても同じ件数（確定時集合）を返す。
    first_exp = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    second_exp = client.post(f"/api/sessions/{sid}/export", headers=_auth(_token(sid)))
    assert first_exp.json()["count"] == second_exp.json()["count"] == 1
