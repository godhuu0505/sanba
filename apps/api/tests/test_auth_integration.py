"""認証の結線テスト (ADR-0012): API がログインを要求し無効トークンを拒否する。

ここでは `require_user` をオーバーライドせず実依存性を通す。`settings` を monkeypatch
して本番相当 / dev bypass / 設定漏れ の各経路を検証する。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sanba_api import auth_google, main
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


def test_unauthenticated_join_spam_is_rate_limited(monkeypatch) -> None:
    """未認証スパムは認証検証より先にレートリミットされる (#80)。

    `_require_rate_limit` を `require_user` より前の依存性に置いたため、
    Authorization 無し/壊れた Bearer でも上限到達後は 401 ではなく 429 を返す
    （壊れた Bearer 連打で認証経路だけを叩き続けられる穴が塞がれている）。
    """
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    monkeypatch.setattr(main.settings, "join_rate_per_minute", 2, raising=True)
    main._join_hits.clear()

    body = {"invite": "broken", "participant_name": "x"}
    # 上限内は認証で 401（レートリミット自体には未到達）。
    for _ in range(2):
        assert client.post("/api/sessions/join", json=body).status_code == 401
    # 上限超過は認証へ到達する前に 429。
    assert client.post("/api/sessions/join", json=body).status_code == 429


def test_rate_limit_emits_observability(monkeypatch) -> None:
    """429 短絡時に観測メトリクスを必ず通す (#257 Codex / CLAUDE.md 原則3)。

    認証より前にレートリミットが発動すると `record_auth_event` には現れないため、
    DoS 緩和の発火を `record_rate_limited` で計測できることを固定する。
    """
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    monkeypatch.setattr(main.settings, "join_rate_per_minute", 1, raising=True)
    main._join_hits.clear()

    calls: list[int] = []
    monkeypatch.setattr(main, "record_rate_limited", lambda: calls.append(1), raising=True)

    body = {"invite": "broken", "participant_name": "x"}
    # 上限内（1回目）は未発火、上限超過（2回目）で 429 とともに計上される。
    assert client.post("/api/sessions/join", json=body).status_code == 401
    assert calls == []
    assert client.post("/api/sessions/join", json=body).status_code == 429
    assert calls == [1]
