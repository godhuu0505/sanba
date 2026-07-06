"""ゲスト入場 (ADR-0032) のテスト。

匿名入口は guest_join_enabled × scope=end_user の 1 経路のみ（決定1）。ここでは
- フェイルクローズ: フラグ off / developer リンクは匿名 401（invite を消費しない）
- 到達性: flag on の end_user リンクは匿名で LiveKit トークン+session_token まで返る
- 権限最小性: ゲスト session_token は他セッションのハイドレーションに使えない
- abuse 対策: リンク単位レート制限の 429（FR-2.6）と max_uses 消費の重ね合わせ
を固定する。すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import Product

from sanba_api import auth_google, main
from sanba_api.auth_google import AuthUser, maybe_user, require_user
from sanba_api.main import app

client = TestClient(app)
OWNER = "product-owner-sub"


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    main._repo._mem_products.clear()
    main._repo._mem_invites.clear()
    main._repo._mem_sessions.clear()
    main._join_hits.clear()
    assert main._repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield
    app.dependency_overrides.pop(require_user, None)
    app.dependency_overrides.pop(maybe_user, None)


@pytest.fixture()
def guest_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main.settings, "guest_join_enabled", True, raising=True)


def _issue_token(scope: str = "end_user", **body: Any) -> str:
    """owner としてリンクを発行し、その後ログアウト（匿名）状態に戻す。"""
    user = AuthUser(sub=OWNER, email="owner@example.com", email_verified=True, name="Owner")
    app.dependency_overrides[require_user] = lambda: user
    main._repo.create_product(Product(id="prod-1", name="請求アプリ", owner_sub=OWNER))
    res = client.post("/api/products/{}/invites".format("prod-1"), json={"scope": scope, **body})
    assert res.status_code == 200, res.text
    app.dependency_overrides.pop(require_user, None)
    token: str = res.json()["token"]
    return token


def _join(token: str, consent: bool = True) -> Any:
    # Authorization ヘッダなし = 匿名（maybe_user が None を返す経路）。
    return client.post("/api/products/join", json={"token": token, "consent_acknowledged": consent})


def _jwt_payload(jwt: str) -> dict[str, Any]:
    seg = jwt.split(".")[1]
    return dict(json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))))


def _use_count() -> int:
    return main._repo.list_invites("prod-1")[0].use_count


# ---- フェイルクローズ（FR-2.1 の裏面） ----------------------------------------
def test_anonymous_join_is_401_when_flag_off() -> None:
    """既定 (guest_join_enabled=false) では匿名 join を 401 で弾き、invite を消費しない。"""
    token = _issue_token(scope="end_user")
    assert main.settings.guest_join_enabled is False
    res = _join(token)
    assert res.status_code == 401
    assert _use_count() == 0


def test_anonymous_join_is_401_for_developer_link(guest_enabled: None) -> None:
    """flag on でも developer リンクは匿名不可（例外は end_user の 1 経路のみ / 決定1）。"""
    token = _issue_token(scope="developer")
    res = _join(token)
    assert res.status_code == 401
    assert _use_count() == 0


def test_guest_consent_gate_is_not_skippable(guest_enabled: None) -> None:
    """同意ゲート（FR-2.2）はゲストでも省略しない。消費もしない。"""
    token = _issue_token(scope="end_user")
    assert _join(token, consent=False).status_code == 400
    assert _use_count() == 0


# ---- FR-2.1: ゲスト到達性と identity / owner ----------------------------------
def test_guest_join_reaches_livekit_token(guest_enabled: None) -> None:
    token = _issue_token(scope="end_user")
    res = _join(token)
    assert res.status_code == 200, res.text
    body = res.json()

    # ログイン経路と違い invite 委譲ではなく、join（トークン一式）を直接返す。
    assert body["invite"] is None
    joined = body["join"]
    assert joined is not None
    assert joined["session_id"] == body["session_id"]
    assert joined["identity"].startswith("guest:")
    assert joined["token"]
    assert joined["session_token"]

    # LiveKit トークンは当該ルーム限定・identity と出所メタ（metadata.sub）がゲスト発番。
    payload = _jwt_payload(joined["token"])
    assert payload["sub"] == joined["identity"]
    assert payload["video"]["room"] == body["session_id"]
    metadata = json.loads(payload["metadata"])
    assert metadata["sub"] == joined["identity"]
    assert metadata["role"] == "customer"
    assert metadata["email"] == ""  # PII 最小化: ゲストに email はない

    # セッションの所有は product owner（管理・履歴閲覧の権限元 / 決定3）。
    meta = main._repo.get_session(body["session_id"])
    assert meta is not None
    assert meta.owner_sub == OWNER
    assert meta.owner_email == ""  # PII 最小化: owner の email も写さない
    assert meta.interview_mode.value == "end_user"
    assert meta.roles == ["customer"]
    assert _use_count() == 1


def test_guest_join_does_not_require_google_config(guest_enabled: None) -> None:
    """ゲスト経路は Google OAuth 未設定でも通る（本人確認を要求しない設計の確認）。"""
    token = _issue_token(scope="end_user")
    assert auth_google.settings.google_oauth_client_id == ""
    assert _join(token).status_code == 200


def test_headerless_join_under_dev_bypass_stays_logged_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """dev bypass（ローカル）はヘッダ無しでも dev identity のログイン経路を保つ。

    dev モードの web は Authorization を付けず AUTH_DEV_BYPASS に委ねるため（lib/api.ts）、
    ここがゲスト扱いに落ちるとローカルの Stage 1 join が壊れる。
    """
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", True, raising=True)
    token = _issue_token(scope="end_user")
    res = _join(token)
    assert res.status_code == 200
    body = res.json()
    assert body["invite"] is not None  # ログイン経路 = invite 委譲のまま
    assert body["join"] is None
    meta = main._repo.get_session(body["session_id"])
    assert meta is not None
    assert meta.owner_sub == "dev-user"


# ---- 権限最小性: ゲスト session_token ------------------------------------------
def test_guest_session_token_cannot_hydrate_other_sessions(guest_enabled: None) -> None:
    token = _issue_token(scope="end_user")
    first = _join(token).json()
    second = _join(token).json()
    session_token = first["join"]["session_token"]

    # 自分のセッションのハイドレーションは通る。
    ok = client.get(
        f"/api/sessions/{first['session_id']}/requirements",
        headers={"Authorization": f"Bearer {session_token}"},
    )
    assert ok.status_code == 200

    # 別セッション（同じリンク由来でも）は session mismatch で 403。
    denied = client.get(
        f"/api/sessions/{second['session_id']}/requirements",
        headers={"Authorization": f"Bearer {session_token}"},
    )
    assert denied.status_code == 403


# ---- FR-2.6: リンク単位レート制限 ----------------------------------------------
def test_invite_rate_limit_returns_429_and_does_not_consume(
    guest_enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main.settings, "invite_join_rate_per_minute", 2, raising=True)
    token = _issue_token(scope="end_user")
    assert _join(token).status_code == 200
    assert _join(token).status_code == 200
    res = _join(token)
    assert res.status_code == 429
    assert res.json()["detail"] == "rate limit exceeded"
    # 429 は use_count を消費しない（ウィンドウが明ければ再入場できる）。
    assert _use_count() == 2


def test_invite_rate_limit_overlaps_with_max_uses(
    guest_enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """max_uses 消費とリンク単位レートの重ね合わせ: 使えないリンクは 403 が先に立つ。"""
    monkeypatch.setattr(main.settings, "invite_join_rate_per_minute", 2, raising=True)
    token = _issue_token(scope="end_user", max_uses=1)
    assert _join(token).status_code == 200
    res = _join(token)  # レート上限(2)より先に max_uses(1) が尽きる
    assert res.status_code == 403
    assert "exhausted" in res.json()["detail"]
    assert _use_count() == 1


def test_invite_rate_limit_applies_to_logged_in_joins_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """リンク単位の制限は入口共通（ゲスト解禁前の Stage 1 経路にも効く abuse 対策）。"""
    monkeypatch.setattr(main.settings, "invite_join_rate_per_minute", 1, raising=True)
    token = _issue_token(scope="developer")
    user = AuthUser(sub="joiner", email="j@example.com", email_verified=True, name="J")
    app.dependency_overrides[maybe_user] = lambda: user
    assert _join(token).status_code == 200
    assert _join(token).status_code == 429


# ---- ADR-0032 決定4: ゲスト token の write 系拒否 ----------------------------
def test_guest_session_token_is_read_only(guest_enabled: None) -> None:
    """ゲスト token はハイドレーション読取と telemetry のみ。write 系は 403。"""
    token = _issue_token(scope="end_user")
    joined = _join(token).json()["join"]
    sid = joined["session_id"]
    headers = {"Authorization": f"Bearer {joined['session_token']}"}

    # 読取（ハイドレーション）と telemetry は通る。
    assert client.get(f"/api/sessions/{sid}/requirements", headers=headers).status_code == 200
    assert client.get(f"/api/sessions/{sid}/detections", headers=headers).status_code == 200
    assert client.get(f"/api/sessions/{sid}/context/files", headers=headers).status_code == 200
    telemetry = client.post(
        f"/api/sessions/{sid}/telemetry",
        headers=headers,
        json={"event": "material.cancel"},
    )
    assert telemetry.status_code == 200
    # ゲストの離脱観測（join.abort）もゲスト token で通る（FR-2.1 の離脱点を追う）。
    join_abort = client.post(
        f"/api/sessions/{sid}/telemetry",
        headers=headers,
        json={"event": "join.abort", "result": "aborted"},
    )
    assert join_abort.status_code == 200

    # 素材投入・削除・確定・起票は 403（ADR-0032 決定4）。
    denied = [
        client.post(
            f"/api/sessions/{sid}/context", headers=headers, json={"text": "x", "source_name": "s"}
        ),
        client.post(
            f"/api/sessions/{sid}/context/file",
            headers=headers,
            files={"file": ("a.txt", b"hello", "text/plain")},
        ),
        client.delete(f"/api/sessions/{sid}/context/file/asset-1", headers=headers),
        client.post(f"/api/sessions/{sid}/finalize", headers=headers),
        client.post(f"/api/sessions/{sid}/export", headers=headers),
    ]
    for res in denied:
        assert res.status_code == 403, res.text
        assert "guests cannot" in res.json()["detail"]


def test_logged_in_session_token_keeps_write_access(guest_enabled: None) -> None:
    """ログイン済み参加者の token は従来どおり write 系が通る（回帰防止）。"""
    token = _issue_token(scope="end_user")
    user = AuthUser(sub="1234567890", email="u@example.com", email_verified=True, name="U")
    app.dependency_overrides[maybe_user] = lambda: user
    app.dependency_overrides[require_user] = lambda: user
    body = client.post(
        "/api/products/join", json={"token": token, "consent_acknowledged": True}
    ).json()
    joined = client.post(
        "/api/sessions/join", json={"invite": body["invite"], "participant_name": "話し手"}
    ).json()
    headers = {"Authorization": f"Bearer {joined['session_token']}"}
    res = client.post(
        f"/api/sessions/{body['session_id']}/context",
        headers=headers,
        json={"text": "参考資料", "source_name": "s"},
    )
    assert res.status_code == 200, res.text
