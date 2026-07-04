"""API tests for the invite-gated session flow (issue #8).

These exercise the invite/authorization logic; the Google identity layer
(ADR-0012) is stubbed via a dependency override so a verified user is assumed.
Authentication enforcement itself is covered in test_auth_integration.py.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import app

client = TestClient(app)


def _fake_user() -> AuthUser:
    return AuthUser(
        sub="owner-123456789",
        email="owner@example.com",
        email_verified=True,
        name="Owner",
    )


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    """全テストで「検証済みユーザーがログイン済み」を仮定する。"""
    app.dependency_overrides[require_user] = _fake_user
    yield
    app.dependency_overrides.pop(require_user, None)


def _create(roles: list[str]) -> dict:
    return client.post("/api/sessions", json={"roles": roles, "consent_acknowledged": True}).json()


def test_healthz() -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_create_session_mints_invites_per_role() -> None:
    res = client.post(
        "/api/sessions", json={"roles": ["pm", "engineer"], "consent_acknowledged": True}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["session_id"].startswith("sess-")
    assert set(body["invites"]) == {"pm", "engineer"}


def test_create_without_consent_is_rejected() -> None:
    res = client.post("/api/sessions", json={"roles": ["pm"]})
    assert res.status_code == 400


# ── セッション単位の連携リポジトリ（ADR-0027）─────────────────────────────
def test_create_session_accepts_github_repo() -> None:
    res = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "acme/product-a"},
    )
    assert res.status_code == 200
    # 保存されたメタに反映される（export / agent がここから解決する）。
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.github_repo == "acme/product-a"


def test_create_session_rejects_malformed_github_repo() -> None:
    for bad in ["not-a-repo", "a/b/c", "owner/", "/name", "own er/name"]:
        res = client.post(
            "/api/sessions",
            json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": bad},
        )
        assert res.status_code == 400, bad


def test_create_session_keeps_empty_github_repo_as_explicit_opt_out() -> None:
    # 空文字は明示的な「連携しない」（Codex P2）。None（未指定=フォールバック）と区別して保存する。
    res = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "  "},
    )
    assert res.status_code == 200
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.github_repo == ""


def test_create_session_omitted_github_repo_stays_none() -> None:
    # 未指定（旧クライアント）は None のまま = 環境変数フォールバックの従来挙動。
    res = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.github_repo is None


def test_create_session_rejects_repo_outside_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    # 許可リスト設定時は一覧に出ないリポを直接 POST で保存する抜け道も塞ぐ（Codex P1）。
    from sanba_api.config import settings

    monkeypatch.setattr(settings, "github_repo_allowlist", "acme, other/repo")
    ok = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "acme/anything"},
    )
    assert ok.status_code == 200
    ok2 = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "other/repo"},
    )
    assert ok2.status_code == 200
    ng = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "intruder/secret"},
    )
    assert ng.status_code == 400


def test_github_repos_disabled_by_default() -> None:
    res = client.get("/api/github/repos")
    assert res.status_code == 200
    body = res.json()
    assert body["enabled"] is False
    assert body["repos"] == []


def test_github_repos_lists_candidates_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from sanba_api import github_export, main
    from sanba_api.config import settings

    monkeypatch.setattr(settings, "github_connector_enabled", True)
    monkeypatch.setattr(settings, "github_token", "t")
    monkeypatch.setattr(settings, "github_repo", "o/r")

    def fake_list_repos(token: str, per_page: int = 100) -> list[str]:
        assert token == "t"
        return ["acme/product-a", "acme/product-b"]

    monkeypatch.setattr(github_export, "list_repos", fake_list_repos)
    monkeypatch.setattr(main.github_export, "list_repos", fake_list_repos)
    res = client.get("/api/github/repos")
    assert res.status_code == 200
    body = res.json()
    assert body["enabled"] is True
    assert body["repos"] == ["acme/product-a", "acme/product-b"]
    assert body["default"] == "o/r"


def test_github_repos_filtered_by_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    # 共有トークンが読める private リポ名を許可リスト外のユーザー環境へ漏らさない（Codex P1）。
    from sanba_api import github_export, main
    from sanba_api.config import settings

    monkeypatch.setattr(settings, "github_connector_enabled", True)
    monkeypatch.setattr(settings, "github_token", "t")
    monkeypatch.setattr(settings, "github_repo_allowlist", "acme")
    monkeypatch.setattr(
        github_export, "list_repos", lambda token, per_page=100: ["acme/a", "intruder/secret"]
    )
    monkeypatch.setattr(
        main.github_export, "list_repos", lambda token, per_page=100: ["acme/a", "intruder/secret"]
    )
    res = client.get("/api/github/repos")
    assert res.json()["repos"] == ["acme/a"]


def test_create_then_join_happy_path() -> None:
    created = _create(["pm"])
    invite = created["invites"]["pm"]

    res = client.post(
        "/api/sessions/join",
        json={"invite": invite, "participant_name": "Alice"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["token"]
    assert body["session_id"] == created["session_id"]
    # identity は検証済み sub 由来 (self-申告名ではない) + ルーム内一意の nonce。
    assert body["identity"].startswith("pm-owner-12-")


def test_join_without_valid_invite_is_rejected() -> None:
    res = client.post(
        "/api/sessions/join",
        json={"invite": "not-a-real-invite", "participant_name": "Mallory"},
    )
    assert res.status_code == 403


def test_join_with_tampered_invite_is_rejected() -> None:
    created = _create(["pm"])
    tampered = created["invites"]["pm"][:-2] + "xx"
    res = client.post(
        "/api/sessions/join",
        json={"invite": tampered, "participant_name": "Mallory"},
    )
    assert res.status_code == 403
