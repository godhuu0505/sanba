"""product メンバー管理・メンバー招待 API (ADR-0036) のテスト。

- 認可: _require_product_access の member 対応（閲覧/セッション作成は可・管理は 403）。
- 招待: owner のみ発行・宛先検証・重複 409・メール背景送信・アプリ内通知（mine）。
- 応答: 宛先 email 照合（不一致 404/403）・承諾でメンバー化・二重応答 409・取り消し。
すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import MemberInviteStatus, Product, ProductMember, ProductMemberInvite

from sanba_api import main
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import app
from sanba_api.routers import members

client = TestClient(app)
OWNER = "owner-sub"
OWNER_EMAIL = "owner@example.com"
MEMBER = "member-sub"
MEMBER_EMAIL = "member@example.com"
STRANGER = "stranger-sub"


def _user(sub: str, email: str = "u@example.com") -> AuthUser:
    return AuthUser(sub=sub, email=email, email_verified=True, name=email)


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    main._repo._mem_products.clear()
    main._repo._mem_invites.clear()
    main._repo._mem_members.clear()
    main._repo._mem_member_invites.clear()
    main._repo._mem_sessions.clear()
    assert main._repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    monkeypatch.setattr(members, "send_member_invite_email", lambda **kwargs: True)
    yield
    app.dependency_overrides.pop(require_user, None)


def _login(sub: str, email: str = "u@example.com") -> None:
    app.dependency_overrides[require_user] = lambda: _user(sub, email)


def _seed_product(pid: str = "prod-1", owner: str = OWNER, name: str = "請求アプリ") -> None:
    main._repo.create_product(Product(id=pid, name=name, owner_sub=owner))


def _seed_member(pid: str = "prod-1", sub: str = MEMBER, email: str = MEMBER_EMAIL) -> None:
    main._repo.add_product_member(ProductMember(product_id=pid, sub=sub, email=email))


def _seed_invite(
    invite_id: str = "minv-1",
    pid: str = "prod-1",
    email: str = MEMBER_EMAIL,
    status: MemberInviteStatus = MemberInviteStatus.PENDING,
    expires_at: datetime | None = None,
) -> None:
    main._repo.create_member_invite(
        ProductMemberInvite(
            id=invite_id,
            product_id=pid,
            email=email,
            invited_by_sub=OWNER,
            invited_by_email=OWNER_EMAIL,
            status=status,
            expires_at=expires_at,
        )
    )


def _invite_via_api(email: str = MEMBER_EMAIL, pid: str = "prod-1") -> dict[str, Any]:
    _login(OWNER, OWNER_EMAIL)
    res = client.post(f"/api/products/{pid}/member-invites", json={"email": email})
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def test_member_can_view_product_with_member_role() -> None:
    _seed_product()
    _seed_member()
    _login(MEMBER, MEMBER_EMAIL)
    res = client.get("/api/products/prod-1")
    assert res.status_code == 200
    assert res.json()["role"] == "member"
    _login(OWNER, OWNER_EMAIL)
    assert client.get("/api/products/prod-1").json()["role"] == "owner"


def test_non_member_still_gets_404() -> None:
    _seed_product()
    _login(STRANGER)
    assert client.get("/api/products/prod-1").status_code == 404


def test_member_can_create_session_for_product() -> None:
    """メンバーは product 従属セッション（要件サンバ）を開始できる（ADR-0036 決定1）。"""
    _seed_product()
    _seed_member()
    _login(MEMBER, MEMBER_EMAIL)
    res = client.post(
        "/api/sessions",
        json={"product_id": "prod-1", "consent_acknowledged": True},
    )
    assert res.status_code == 200, res.text
    session_id = res.json()["session_id"]
    meta = main._repo.get_session(session_id)
    assert meta is not None and meta.product_id == "prod-1"


def test_member_cannot_manage_product() -> None:
    """管理操作（更新/削除/repo/リンク/招待管理）はメンバーには 403。"""
    _seed_product()
    _seed_member()
    _login(MEMBER, MEMBER_EMAIL)
    assert client.patch("/api/products/prod-1", json={"name": "x"}).status_code == 403
    assert client.delete("/api/products/prod-1").status_code == 403
    assert client.get("/api/products/prod-1/invites").status_code == 403
    assert (
        client.post("/api/products/prod-1/member-invites", json={"email": "a@b.co"}).status_code
        == 403
    )
    assert client.get("/api/products/prod-1/member-invites").status_code == 403


def test_my_products_merges_owned_and_membered() -> None:
    main._repo.create_product(
        Product(
            id="prod-own", name="own", owner_sub=MEMBER, created_at=datetime(2026, 1, 1, tzinfo=UTC)
        )
    )
    main._repo.create_product(
        Product(
            id="prod-1", name="joined", owner_sub=OWNER, created_at=datetime(2026, 6, 1, tzinfo=UTC)
        )
    )
    _seed_member()
    _login(MEMBER, MEMBER_EMAIL)
    res = client.get("/api/products/mine")
    assert res.status_code == 200
    rows = {r["id"]: r["role"] for r in res.json()}
    assert rows == {"prod-own": "owner", "prod-1": "member"}


def test_member_list_visible_to_members_and_owner() -> None:
    _seed_product()
    _seed_member()
    for sub, email in ((MEMBER, MEMBER_EMAIL), (OWNER, OWNER_EMAIL)):
        _login(sub, email)
        res = client.get("/api/products/prod-1/members")
        assert res.status_code == 200
        assert [m["sub"] for m in res.json()] == [MEMBER]
    _login(STRANGER)
    assert client.get("/api/products/prod-1/members").status_code == 404


def test_owner_can_remove_member_and_access_is_lost() -> None:
    _seed_product()
    _seed_member()
    _login(OWNER, OWNER_EMAIL)
    res = client.delete(f"/api/products/prod-1/members/{MEMBER}")
    assert res.status_code == 200 and res.json()["removed"] is True
    _login(MEMBER, MEMBER_EMAIL)
    assert client.get("/api/products/prod-1").status_code == 404
    _login(OWNER, OWNER_EMAIL)
    assert client.delete(f"/api/products/prod-1/members/{MEMBER}").status_code == 404


def test_member_can_leave_but_not_remove_others() -> None:
    _seed_product()
    _seed_member()
    _seed_member(sub="member-2", email="m2@example.com")
    _login(MEMBER, MEMBER_EMAIL)
    assert client.delete("/api/products/prod-1/members/member-2").status_code == 403
    assert client.delete(f"/api/products/prod-1/members/{MEMBER}").status_code == 200
    assert client.get("/api/products/prod-1").status_code == 404


def test_owner_issues_invite_and_email_task_is_queued(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_product()
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(members, "send_member_invite_email", lambda **kw: sent.append(kw) or True)
    body = _invite_via_api(email="  Member@Example.com  ")
    assert body["email"] == MEMBER_EMAIL
    assert body["status"] == "pending"
    assert body["invited_by_email"] == OWNER_EMAIL
    assert body["token"]
    assert body["expires_at"] is not None
    assert len(sent) == 1
    assert sent[0]["to"] == MEMBER_EMAIL
    assert sent[0]["product_name"] == "請求アプリ"
    assert sent[0]["invite_url"].endswith(f"/member-invites/{body['token']}")


def test_invite_validation_rejects_bad_and_duplicate_targets() -> None:
    _seed_product()
    _login(OWNER, OWNER_EMAIL)
    assert (
        client.post("/api/products/prod-1/member-invites", json={"email": "not-an-email"})
    ).status_code == 400
    assert (
        client.post("/api/products/prod-1/member-invites", json={"email": OWNER_EMAIL})
    ).status_code == 400
    _seed_member()
    assert (
        client.post("/api/products/prod-1/member-invites", json={"email": MEMBER_EMAIL})
    ).status_code == 409
    res = client.post("/api/products/prod-1/member-invites", json={"email": "new@example.com"})
    assert res.status_code == 200
    assert (
        client.post("/api/products/prod-1/member-invites", json={"email": "new@example.com"})
    ).status_code == 409


def test_expired_or_responded_invite_allows_reinvite() -> None:
    _seed_product()
    _seed_invite(expires_at=datetime.now(UTC) - timedelta(seconds=1))
    _seed_invite(invite_id="minv-2", email="x@example.com", status=MemberInviteStatus.DECLINED)
    _login(OWNER, OWNER_EMAIL)
    assert (
        client.post("/api/products/prod-1/member-invites", json={"email": MEMBER_EMAIL})
    ).status_code == 200
    assert (
        client.post("/api/products/prod-1/member-invites", json={"email": "x@example.com"})
    ).status_code == 200


def test_invite_creation_is_capped_by_pending_count(monkeypatch: pytest.MonkeyPatch) -> None:
    """保留中招待の総量ガード（bulk メール送信の乱用防止）。取り消せば再発行できる。"""
    _seed_product()
    monkeypatch.setattr(main.settings, "member_invite_max_pending_per_product", 2)
    _login(OWNER, OWNER_EMAIL)
    for i in range(2):
        res = client.post(
            "/api/products/prod-1/member-invites", json={"email": f"user{i}@example.com"}
        )
        assert res.status_code == 200
    res = client.post("/api/products/prod-1/member-invites", json={"email": "u3@example.com"})
    assert res.status_code == 429
    first = main._repo.list_member_invites("prod-1")[-1]
    client.post(f"/api/products/prod-1/member-invites/{first.id}/revoke")
    res = client.post("/api/products/prod-1/member-invites", json={"email": "u3@example.com"})
    assert res.status_code == 200


def test_invite_list_is_owner_only_and_marks_expired() -> None:
    _seed_product()
    _seed_invite(expires_at=datetime.now(UTC) - timedelta(seconds=1))
    _login(OWNER, OWNER_EMAIL)
    res = client.get("/api/products/prod-1/member-invites")
    assert res.status_code == 200
    assert res.json()[0]["status"] == "expired"


def test_my_invites_lists_only_my_pending() -> None:
    _seed_product()
    _seed_product(pid="prod-2", name="別アプリ")
    _seed_invite()
    _seed_invite(invite_id="minv-2", pid="prod-2")
    _seed_invite(invite_id="minv-3", email="other@example.com")
    _seed_invite(
        invite_id="minv-4", email=MEMBER_EMAIL, status=MemberInviteStatus.DECLINED, pid="prod-2"
    )
    _seed_invite(
        invite_id="minv-5", email=MEMBER_EMAIL, expires_at=datetime.now(UTC) - timedelta(seconds=1)
    )
    _login(MEMBER, MEMBER_EMAIL)
    res = client.get("/api/member-invites/mine")
    assert res.status_code == 200
    rows = res.json()
    assert {r["id"] for r in rows} == {"minv-1", "minv-2"}
    assert {r["product_name"] for r in rows} == {"請求アプリ", "別アプリ"}
    assert all(r["invited_by_email"] == OWNER_EMAIL for r in rows)


def test_accept_invite_grants_membership() -> None:
    _seed_product()
    _seed_invite()
    _login(MEMBER, MEMBER_EMAIL)
    res = client.post("/api/member-invites/minv-1/respond", json={"action": "accept"})
    assert res.status_code == 200
    assert res.json() == {"status": "accepted", "product_id": "prod-1"}
    assert client.get("/api/products/prod-1").status_code == 200
    assert client.get("/api/member-invites/mine").json() == []
    member = main._repo.get_product_member("prod-1", MEMBER)
    assert member is not None and member.email == MEMBER_EMAIL
    res = client.post("/api/member-invites/minv-1/respond", json={"action": "accept"})
    assert res.status_code == 409


def test_decline_invite_does_not_grant_membership() -> None:
    _seed_product()
    _seed_invite()
    _login(MEMBER, MEMBER_EMAIL)
    res = client.post("/api/member-invites/minv-1/respond", json={"action": "decline"})
    assert res.status_code == 200 and res.json()["status"] == "declined"
    assert client.get("/api/products/prod-1").status_code == 404


def test_respond_hides_invites_addressed_to_others() -> None:
    _seed_product()
    _seed_invite()
    _login(STRANGER, "stranger@example.com")
    res = client.post("/api/member-invites/minv-1/respond", json={"action": "accept"})
    assert res.status_code == 404
    _login(MEMBER, "Member@Example.com")
    assert (
        client.post("/api/member-invites/minv-1/respond", json={"action": "accept"}).status_code
        == 200
    )


def test_revoke_blocks_response_and_is_idempotent() -> None:
    _seed_product()
    _seed_invite()
    _login(OWNER, OWNER_EMAIL)
    assert client.post("/api/products/prod-1/member-invites/minv-1/revoke").status_code == 200
    assert client.post("/api/products/prod-1/member-invites/minv-1/revoke").status_code == 200
    _login(MEMBER, MEMBER_EMAIL)
    res = client.post("/api/member-invites/minv-1/respond", json={"action": "accept"})
    assert res.status_code == 409
    _seed_invite(invite_id="minv-2")
    client.post("/api/member-invites/minv-2/respond", json={"action": "accept"})
    _login(OWNER, OWNER_EMAIL)
    assert client.post("/api/products/prod-1/member-invites/minv-2/revoke").status_code == 409
    _seed_product(pid="prod-2")
    assert client.post("/api/products/prod-2/member-invites/minv-2/revoke").status_code == 404


def test_resolve_and_respond_by_token() -> None:
    _seed_product()
    body = _invite_via_api()
    token = body["token"]
    _login(MEMBER, MEMBER_EMAIL)
    res = client.post("/api/member-invites/resolve", json={"token": token})
    assert res.status_code == 200
    resolved = res.json()
    assert resolved["product_name"] == "請求アプリ"
    assert resolved["email_match"] is True
    assert resolved["status"] == "pending"
    assert MEMBER_EMAIL not in resolved["masked_email"]
    res = client.post(
        "/api/member-invites/respond-by-token", json={"token": token, "action": "accept"}
    )
    assert res.status_code == 200 and res.json()["status"] == "accepted"
    assert main._repo.get_product_member("prod-1", MEMBER) is not None


def test_respond_by_token_rejects_other_email_and_tampered_token() -> None:
    _seed_product()
    token = _invite_via_api()["token"]
    _login(STRANGER, "stranger@example.com")
    res = client.post("/api/member-invites/resolve", json={"token": token})
    assert res.status_code == 200
    resolved = res.json()
    assert resolved["email_match"] is False
    assert resolved["product_name"] == ""
    assert resolved["invited_by_email"] != OWNER_EMAIL
    assert "***" in resolved["invited_by_email"]
    res = client.post(
        "/api/member-invites/respond-by-token", json={"token": token, "action": "accept"}
    )
    assert res.status_code == 403
    res = client.post(
        "/api/member-invites/respond-by-token", json={"token": token + "x", "action": "accept"}
    )
    assert res.status_code == 403


def test_product_delete_cascades_membership_and_invites() -> None:
    _seed_product()
    _seed_member()
    _seed_invite()
    _login(OWNER, OWNER_EMAIL)
    assert client.delete("/api/products/prod-1").status_code == 200
    _login(MEMBER, MEMBER_EMAIL)
    assert client.get("/api/member-invites/mine").json() == []
    assert client.get("/api/products/mine").json() == []
