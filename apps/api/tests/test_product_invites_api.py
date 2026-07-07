"""深掘りリンク API (ADR-0031 決定3) のテスト。

- 発行は owner のみ（admin は一覧・失効のみ）。非所有・不存在は 404 に平す。
- 検証は二段: HMAC 署名（本物のリンクか）→ invite 文書（失効・期限・回数の消費）。
- join は product 従属セッションを作成し repo 設定を継承する（FR-1.4/1.6）。
すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import GitHubIndexStatus, Product, ProductInvite

from sanba_api import auth_google, main
from sanba_api.auth import (
    InvalidInvite,
    InvalidProductInvite,
    create_invite,
    create_product_invite_token,
    verify_invite,
    verify_product_invite_token,
)
from sanba_api.auth_google import AuthUser, maybe_user, require_user
from sanba_api.main import app

client = TestClient(app)
OWNER = "owner-sub"
ADMIN_EMAIL = "boss@example.com"
SECRET = main.settings.session_signing_secret


def _user(sub: str, email: str = "u@example.com") -> AuthUser:
    return AuthUser(sub=sub, email=email, email_verified=True, name=email)


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    main._repo._mem_products.clear()
    main._repo._mem_invites.clear()
    main._repo._mem_sessions.clear()
    main._repo._mem_github_links.clear()
    main._join_hits.clear()
    assert main._repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield
    app.dependency_overrides.pop(require_user, None)
    app.dependency_overrides.pop(maybe_user, None)


def _login(sub: str, email: str = "u@example.com") -> None:
    app.dependency_overrides[require_user] = lambda: _user(sub, email)
    app.dependency_overrides[maybe_user] = lambda: _user(sub, email)


def _seed_product(pid: str = "prod-1", owner: str = OWNER, **kwargs: Any) -> None:
    main._repo.create_product(Product(id=pid, name="請求アプリ", owner_sub=owner, **kwargs))


def _issue(pid: str = "prod-1", **body: Any) -> dict[str, Any]:
    res = client.post(f"/api/products/{pid}/invites", json=body)
    assert res.status_code == 200, res.text
    issued: dict[str, Any] = res.json()
    return issued


def _join(token: str, consent: bool = True) -> Any:
    return client.post("/api/products/join", json={"token": token, "consent_acknowledged": consent})


def test_product_invite_token_roundtrip_and_kind_separation() -> None:
    token = create_product_invite_token("prod-1", "inv-1", SECRET, None)
    claim = verify_product_invite_token(token, SECRET)
    assert (claim.product_id, claim.invite_id) == ("prod-1", "inv-1")

    expired = create_product_invite_token("prod-1", "inv-1", SECRET, int(time.time()) - 10)
    with pytest.raises(InvalidProductInvite, match="expired"):
        verify_product_invite_token(expired, SECRET)

    with pytest.raises(InvalidProductInvite, match="scope"):
        verify_product_invite_token(create_invite("sess-1", "pm", SECRET), SECRET)
    with pytest.raises(InvalidInvite):
        verify_invite(token, SECRET)


def test_issue_invite_is_owner_only() -> None:
    _seed_product()
    _login(OWNER)
    body = _issue(scope="end_user", ttl_seconds=3600, max_uses=5)
    assert body["token"]
    assert body["scope"] == "end_user"
    assert body["max_uses"] == 5

    saved = main._repo.get_invite("prod-1", body["id"])
    assert saved is not None
    assert saved.scope.value == "end_user"
    assert saved.max_uses == 5
    assert saved.expires_at is not None
    assert saved.expires_at > datetime.now(UTC) + timedelta(minutes=55)

    _login("intruder")
    assert client.post("/api/products/prod-1/invites", json={}).status_code == 404


def test_admin_can_list_and_revoke_but_not_issue(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_google.settings, "admin_emails", ADMIN_EMAIL, raising=True)
    _seed_product()
    _login(OWNER)
    invite_id = _issue()["id"]

    _login("admin-sub", ADMIN_EMAIL)
    assert client.post("/api/products/prod-1/invites", json={}).status_code == 403
    listed = client.get("/api/products/prod-1/invites").json()
    assert [i["id"] for i in listed] == [invite_id]
    res = client.post(f"/api/products/prod-1/invites/{invite_id}/revoke")
    assert res.status_code == 200
    assert res.json()["revoked"] is True


def test_revoke_unknown_invite_is_404() -> None:
    _seed_product()
    _login(OWNER)
    assert client.post("/api/products/prod-1/invites/inv-none/revoke").status_code == 404


def test_join_creates_session_inheriting_product_settings() -> None:
    _seed_product(
        github_repo="octo/demo",
        github_branch="main",
        github_commit_sha="sha-abc",
        github_index_status=GitHubIndexStatus.READY,
        github_summary="repo 要約",
    )
    _login(OWNER)
    token = _issue()["token"]

    _login("joiner-sub", "joiner@example.com")
    res = _join(token)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["product_id"] == "prod-1"
    assert body["product_name"] == "請求アプリ"
    assert body["interview_mode"] == "developer"

    meta = main._repo.get_session(body["session_id"])
    assert meta is not None
    assert meta.product_id == "prod-1"
    assert meta.interview_mode.value == "developer"
    assert meta.owner_sub == "joiner-sub"
    assert meta.roles == ["pm"]
    assert meta.github_repo == "octo/demo"
    assert meta.github_commit_sha == "sha-abc"
    assert meta.github_index_status is GitHubIndexStatus.READY
    assert meta.github_summary == "repo 要約"

    res2 = client.post(
        "/api/sessions/join", json={"invite": body["invite"], "participant_name": "話し手"}
    )
    assert res2.status_code == 200, res2.text
    assert res2.json()["session_id"] == body["session_id"]


def test_join_end_user_scope_maps_to_customer_role() -> None:
    _seed_product()
    _login(OWNER)
    token = _issue(scope="end_user")["token"]
    res = _join(token)
    assert res.status_code == 200
    meta = main._repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.interview_mode.value == "end_user"
    assert meta.roles == ["customer"]


def test_join_requires_consent_and_login(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_product()
    _login(OWNER)
    token = _issue()["token"]
    assert _join(token, consent=False).status_code == 400
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    app.dependency_overrides.pop(require_user, None)
    app.dependency_overrides.pop(maybe_user, None)
    assert _join(token).status_code == 401


def test_join_rejects_tampered_token() -> None:
    _seed_product()
    _login(OWNER)
    token = _issue()["token"]
    payload_b64, _sig = token.split(".", 1)
    assert _join(f"{payload_b64}.forged").status_code == 403


def test_join_rejects_unusable_invite_with_reason() -> None:
    _seed_product()
    _login(OWNER)

    revoked = _issue()
    client.post(f"/api/products/prod-1/invites/{revoked['id']}/revoke")
    res = _join(revoked["token"])
    assert res.status_code == 403
    assert "revoked" in res.json()["detail"]

    main._repo.create_invite(
        ProductInvite(
            id="inv-expired",
            product_id="prod-1",
            expires_at=datetime.now(UTC) - timedelta(seconds=1),
        )
    )
    doc_expired_token = create_product_invite_token("prod-1", "inv-expired", SECRET, None)
    res = _join(doc_expired_token)
    assert res.status_code == 403
    assert "expired" in res.json()["detail"]

    limited = _issue(max_uses=1)
    assert _join(limited["token"]).status_code == 200
    res = _join(limited["token"])
    assert res.status_code == 403
    assert "exhausted" in res.json()["detail"]


def test_join_use_count_is_capped_under_concurrency() -> None:
    _seed_product()
    _login(OWNER)
    token = _issue(max_uses=3)["token"]

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(lambda _: _join(token).status_code, range(6)))
    assert sorted(codes) == [200, 200, 200, 403, 403, 403]
    invites = main._repo.list_invites("prod-1")
    assert invites[0].use_count == 3


def test_join_after_product_deleted_is_404() -> None:
    _seed_product()
    _login(OWNER)
    token = _issue()["token"]
    client.delete("/api/products/prod-1")
    assert _join(token).status_code == 404


def test_join_is_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    """/api/products/join も既存 join と同じミドルウェア枠で 429 になる。"""
    monkeypatch.setattr(main.settings, "join_rate_per_minute", 2, raising=True)
    _seed_product()
    _login(OWNER)
    token = _issue()["token"]
    assert _join(token).status_code == 200
    assert _join(token).status_code == 200
    assert _join(token).status_code == 429
