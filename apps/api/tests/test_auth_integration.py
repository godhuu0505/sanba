"""認証の結線テスト (ADR-0012): API がログインを要求し無効トークンを拒否する。

ここでは `require_user` をオーバーライドせず実依存性を通す。`settings` を monkeypatch
して本番相当 / dev bypass / 設定漏れ の各経路を検証する。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sanba_api import auth_google
from sanba_api.main import app

client = TestClient(app)

_CREATE_BODY = {"roles": ["pm"], "consent_acknowledged": True}


def test_create_requires_login_when_configured(monkeypatch) -> None:
    """client_id 設定済み・bypass off で未ログインなら 401。"""
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)

    res = client.post("/api/sessions", json=_CREATE_BODY)
    assert res.status_code == 401


def test_invalid_bearer_token_is_rejected(monkeypatch) -> None:
    """壊れた ID トークンはサーバ検証で 401 になる。"""
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)

    res = client.post(
        "/api/sessions",
        json=_CREATE_BODY,
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert res.status_code == 401


def test_missing_client_id_fails_closed(monkeypatch) -> None:
    """client_id 未設定 (本番の設定漏れ) は無検証で開かず 503。"""
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)

    res = client.post("/api/sessions", json=_CREATE_BODY)
    assert res.status_code == 503


def test_dev_bypass_allows_local_flow(monkeypatch) -> None:
    """auth_dev_bypass=true (ローカル限定) は未ログインでも通り、just up を壊さない。"""
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", True, raising=True)

    res = client.post("/api/sessions", json=_CREATE_BODY)
    assert res.status_code == 200
    assert res.json()["session_id"].startswith("sess-")
