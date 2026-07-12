"""本人セッション一覧 API (GET /api/sessions/mine) のテスト。

- 認可は本人限定: 呼び出しユーザーの owner_sub と一致するものだけ返る (他人のは出ない)。
- idToken 必須: require_user をオーバーライドせず、本番相当構成で未ログインなら 401。
- 並びは created_at 降順、PII (owner_email) はレスポンスに含めない。
すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import InquiryKind, InquiryNode, InquiryStatus, SessionMeta, Utterance

from sanba_api import auth_google
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import _read_repo, _repo, app

client = TestClient(app)


def _user(sub: str, email: str) -> AuthUser:
    return AuthUser(sub=sub, email=email, email_verified=True, name=email)


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    _repo._mem_sessions.clear()
    _repo._mem_utterances.clear()
    _repo._mem_materials.clear()
    _repo._mem_inquiry.clear()
    _read_repo._mem_requirements.clear()
    assert _repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield
    app.dependency_overrides.pop(require_user, None)


def _login(sub: str, email: str = "u@example.com") -> None:
    app.dependency_overrides[require_user] = lambda: _user(sub, email)


def _seed(sid: str, owner_sub: str, *, created: datetime, title: str = "t") -> None:
    _repo.create_session_doc(
        SessionMeta(
            id=sid,
            title=title,
            owner_sub=owner_sub,
            owner_email=f"{owner_sub}@example.com",
            roles=["pm"],
            created_at=created,
        )
    )


def test_returns_only_callers_sessions() -> None:
    _seed("sess-mine-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _seed("sess-other", "bob", created=datetime(2024, 6, 21, tzinfo=UTC))
    _login("alice")

    res = client.get("/api/sessions/mine")
    assert res.status_code == 200
    body = res.json()
    assert {s["id"] for s in body} == {"sess-mine-1"}


def test_empty_when_no_sessions() -> None:
    _seed("sess-other", "bob", created=datetime(2024, 6, 21, tzinfo=UTC))
    _login("alice")
    assert client.get("/api/sessions/mine").json() == []


def test_sorted_by_created_at_desc() -> None:
    _seed("old", "alice", created=datetime(2024, 1, 1, tzinfo=UTC))
    _seed("new", "alice", created=datetime(2024, 12, 31, tzinfo=UTC))
    _seed("mid", "alice", created=datetime(2024, 6, 15, tzinfo=UTC))
    _login("alice")

    body = client.get("/api/sessions/mine").json()
    assert [s["id"] for s in body] == ["new", "mid", "old"]


def test_response_omits_pii_and_exposes_finalized() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC), title="新機能要件定義")
    _login("alice")

    row = client.get("/api/sessions/mine").json()[0]
    assert row["title"] == "新機能要件定義"
    assert row["finalized"] is False
    assert "owner_email" not in row
    assert "owner_sub" not in row


def test_finalized_flag_reflects_status() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _repo.finalize_session("sess-1", confirmed_count=2, finalized_requirement_ids=["r1", "r2"])
    _login("alice")

    row = client.get("/api/sessions/mine").json()[0]
    assert row["status"] == "finalized"
    assert row["finalized"] is True


def test_exposes_labels_and_issue_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """AI が付けたラベルと起票済み Issue URL を一覧に載せる（P1-c）。"""
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _repo.finalize_session(
        "sess-1",
        confirmed_count=1,
        finalized_requirement_ids=["r1"],
        labels=["sanba", "priority:must", "functional"],
    )
    _repo.set_exported_issue_url("sess-1", "https://github.com/acme/app/issues/7")
    _login("alice")

    row = client.get("/api/sessions/mine").json()[0]
    assert row["labels"] == ["sanba", "priority:must", "functional"]
    assert row["issue_url"] == "https://github.com/acme/app/issues/7"


def test_labels_default_empty_when_not_finalized() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _login("alice")
    row = client.get("/api/sessions/mine").json()[0]
    assert row["labels"] == []
    assert row["issue_url"] is None


def test_requires_login_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """client_id 設定済み・bypass off で未ログイン (Bearer 無し) なら 401。"""
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    assert client.get("/api/sessions/mine").status_code == 401


def test_invalid_bearer_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """壊れた ID トークンはサーバ検証で 401 になる。"""
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    res = client.get("/api/sessions/mine", headers={"Authorization": "Bearer not-a-real-token"})
    assert res.status_code == 401


def _seed_requirement(sid: str, rid: str = "r1") -> None:
    _read_repo._seed_requirement(
        sid,
        {
            "id": rid,
            "statement": "キーワード検索を新設する",
            "category": "functional",
            "priority": "must",
            "confidence": 0.9,
            "source_speaker": "顧客",
        },
    )


def test_my_requirements_returns_meta_and_items() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC), title="新機能要件定義")
    _seed_requirement("sess-1")
    _login("alice")

    res = client.get("/api/sessions/mine/sess-1/requirements")
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == "sess-1"
    assert body["title"] == "新機能要件定義"
    assert body["finalized"] is False
    assert "owner_email" not in body
    assert "owner_sub" not in body
    item = body["items"][0]
    assert item["id"] == "r1"
    assert item["priority"] == "must"
    assert item["citations"] == []
    assert item["status"] == "confirmed"


def test_my_requirements_returns_goal_materials_and_open_inquiries() -> None:
    _repo.create_session_doc(
        SessionMeta(
            id="sess-1",
            title="新機能要件定義",
            owner_sub="alice",
            owner_email="alice@example.com",
            roles=["pm"],
            created_at=datetime(2024, 6, 20, tzinfo=UTC),
            goal="検索機能を改善する",
            goal_detail="現状は検索が遅い。まず商品検索だけ対象にしたい。",
        )
    )
    _repo.save_material(
        "sess-1", {"id": "a1", "name": "画面設計.pdf", "kind": "doc", "status": "done"}
    )
    _repo.save_inquiry_node(
        "sess-1",
        InquiryNode(id="n1", kind=InquiryKind.GAP, text="検索対象に管理画面を含めるか未確認"),
    )
    _repo.save_inquiry_node(
        "sess-1",
        InquiryNode(
            id="n2",
            kind=InquiryKind.CHECK,
            text="解決済みの確認",
            status=InquiryStatus.RESOLVED,
        ),
    )
    _login("alice")

    body = client.get("/api/sessions/mine/sess-1/requirements").json()
    assert body["goal"] == "検索機能を改善する"
    assert body["goal_detail"] == "現状は検索が遅い。まず商品検索だけ対象にしたい。"
    assert body["materials"] == [
        {"id": "a1", "name": "画面設計.pdf", "kind": "doc", "status": "done"}
    ]
    assert body["open_inquiries"] == [
        {"id": "n1", "kind": "gap", "text": "検索対象に管理画面を含めるか未確認"}
    ]


def test_my_requirements_goal_and_extras_default_empty() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _login("alice")

    body = client.get("/api/sessions/mine/sess-1/requirements").json()
    assert body["goal"] is None
    assert body["goal_detail"] is None
    assert body["materials"] == []
    assert body["open_inquiries"] == []


def test_my_requirements_empty_items_when_none_recorded() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _login("alice")
    body = client.get("/api/sessions/mine/sess-1/requirements").json()
    assert body["items"] == []


def test_my_requirements_finalized_returns_frozen_snapshot_only() -> None:
    """確定済みは finalize 時の凍結スナップショットだけを見せる。

    確定後に遅延 agent が追加した要件は、export と同様に過去要件閲覧にも混ぜない。
    """
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _seed_requirement("sess-1", "r1")
    _repo.finalize_session("sess-1", confirmed_count=1, finalized_requirement_ids=["r1"])
    _seed_requirement("sess-1", "r2")
    _login("alice")

    body = client.get("/api/sessions/mine/sess-1/requirements").json()
    assert body["finalized"] is True
    assert [i["id"] for i in body["items"]] == ["r1"]


def test_my_requirements_legacy_finalized_without_snapshot_falls_back() -> None:
    """旧データ（ID スナップショット無しの finalized）は export と同じ再計算フォールバック。"""
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _seed_requirement("sess-1", "r1")
    _repo.finalize_session("sess-1", confirmed_count=1, finalized_requirement_ids=[])
    _login("alice")

    body = client.get("/api/sessions/mine/sess-1/requirements").json()
    assert body["finalized"] is True
    assert [i["id"] for i in body["items"]] == ["r1"]


def test_my_requirements_hides_other_owners_session_as_404() -> None:
    """非所有は 404 (403 ではない): 応答差で他人のセッション ID の存在を漏らさない。"""
    _seed("sess-bob", "bob", created=datetime(2024, 6, 20, tzinfo=UTC))
    _seed_requirement("sess-bob")
    _login("alice")
    assert client.get("/api/sessions/mine/sess-bob/requirements").status_code == 404


def test_my_requirements_unknown_session_is_404() -> None:
    _login("alice")
    assert client.get("/api/sessions/mine/no-such/requirements").status_code == 404


def _seed_product_session(sid: str, owner_sub: str, product_owner: str, product_id: str) -> None:
    from sanba_shared.models import Product

    _repo.create_product(Product(id=product_id, name="請求アプリ", owner_sub=product_owner))
    _repo.create_session_doc(
        SessionMeta(
            id=sid,
            title="t",
            owner_sub=owner_sub,
            owner_email=f"{owner_sub}@example.com",
            roles=["pm"],
            created_at=datetime(2024, 6, 20, tzinfo=UTC),
            product_id=product_id,
        )
    )


def test_my_requirements_product_owner_can_view_member_session() -> None:
    _seed_product_session("sess-po-1", "member-1", "prod-owner-1", "prod-view-1")
    _seed_requirement("sess-po-1")
    _login("prod-owner-1")
    assert client.get("/api/sessions/mine/sess-po-1/requirements").status_code == 200


def test_my_requirements_product_session_still_404_for_unrelated_user() -> None:
    _seed_product_session("sess-po-2", "member-1", "prod-owner-2", "prod-view-2")
    _login("stranger")
    assert client.get("/api/sessions/mine/sess-po-2/requirements").status_code == 404


def test_my_transcript_product_owner_can_view_member_session() -> None:
    _seed_product_session("sess-po-3", "member-1", "prod-owner-3", "prod-view-3")
    _login("prod-owner-3")
    assert client.get("/api/sessions/mine/sess-po-3/transcript").status_code == 200


def _seed_utterance(sid: str, speaker: str, text: str, *, ts: datetime) -> None:
    _repo.add_utterance(sid, Utterance(speaker=speaker, text=text, ts=ts))


def test_my_transcript_returns_utterances_in_time_order() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _seed_utterance(
        "sess-1", "SANBA", "何を規矩としましょう", ts=datetime(2024, 6, 20, 0, 0, tzinfo=UTC)
    )
    _seed_utterance("sess-1", "participant", "価格順で", ts=datetime(2024, 6, 20, 0, 1, tzinfo=UTC))
    _login("alice")

    res = client.get("/api/sessions/mine/sess-1/transcript")
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == "sess-1"
    assert [(u["speaker"], u["text"]) for u in body["utterances"]] == [
        ("SANBA", "何を規矩としましょう"),
        ("participant", "価格順で"),
    ]


def test_my_transcript_empty_when_none_recorded() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _login("alice")

    body = client.get("/api/sessions/mine/sess-1/transcript").json()
    assert body["utterances"] == []


def test_my_transcript_hides_other_owners_session_as_404() -> None:
    _seed("sess-bob", "bob", created=datetime(2024, 6, 20, tzinfo=UTC))
    _seed_utterance("sess-bob", "participant", "秘密", ts=datetime(2024, 6, 20, tzinfo=UTC))
    _login("alice")

    assert client.get("/api/sessions/mine/sess-bob/transcript").status_code == 404


def test_my_transcript_unknown_session_is_404() -> None:
    _login("alice")
    assert client.get("/api/sessions/mine/no-such/transcript").status_code == 404


def test_my_transcript_requires_login(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    assert client.get("/api/sessions/mine/sess-1/transcript").status_code == 401


def test_my_requirements_requires_login(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    assert client.get("/api/sessions/mine/sess-1/requirements").status_code == 401
