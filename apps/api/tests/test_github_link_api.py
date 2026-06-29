"""API tests for GitHub repo linking endpoints (ADR-0025).

require_user / require_session_access are overridden (a verified owner is
assumed), and the GitHub App client is replaced by a fake (no network).
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api import main
from sanba_api.auth import SessionAccess
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.github_app import IndexFile, create_link_state
from sanba_api.main import app, require_session_access

client = TestClient(app)
OWNER = "owner-123456789"


def _fake_user() -> AuthUser:
    return AuthUser(sub=OWNER, email="owner@example.com", email_verified=True, name="Owner")


class FakeClient:
    def installation_login(self, installation_id: int) -> str:
        return "octocat"

    def list_repos(self, installation_id: int):  # type: ignore[no-untyped-def]
        from sanba_api.github_app import RepoRef

        return [RepoRef(full_name="octo/demo", default_branch="main", private=True)]

    def list_branches(self, installation_id: int, repo: str):  # type: ignore[no-untyped-def]
        return [{"name": "main", "sha": "sha-main"}, {"name": "dev", "sha": "sha-dev"}]

    def repo_meta(self, installation_id: int, repo: str):  # type: ignore[no-untyped-def]
        return {"description": "demo", "language": "Python", "default_branch": "main"}

    def branch_head_sha(self, installation_id: int, repo: str, branch: str) -> str:
        return f"sha-{branch}"

    def list_tree(self, installation_id: int, repo: str, sha: str):  # type: ignore[no-untyped-def]
        from sanba_api.github_app import TreeListing

        return TreeListing(files=[IndexFile("README.md", 20), IndexFile("src/main.py", 30)])

    def fetch_file(self, installation_id: int, repo: str, sha: str, path: str) -> str:
        return "print('hi')\n"

    def fetch_readme(self, installation_id: int, repo: str, sha: str) -> str | None:
        return "# Demo"


@pytest.fixture(autouse=True)
def _setup(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    app.dependency_overrides[require_user] = _fake_user
    monkeypatch.setattr(main, "_github_app_client", lambda: FakeClient())
    monkeypatch.setattr(main.settings, "github_app_enabled", True)
    monkeypatch.setattr(main.settings, "github_app_slug", "sanba-app")
    # 各テストで連携状態をクリーンにする。
    main._repo.delete_github_link(OWNER)
    yield
    app.dependency_overrides.pop(require_user, None)
    main._repo.delete_github_link(OWNER)


def _link() -> None:
    state = create_link_state(OWNER, main.settings.session_signing_secret)
    res = client.get("/api/github/link/callback", params={"installation_id": 99, "state": state})
    assert res.status_code == 200


def test_link_status_starts_unlinked() -> None:
    res = client.get("/api/github/link")
    assert res.json() == {"linked": False, "github_login": None}


def test_link_start_returns_install_url_with_state() -> None:
    res = client.post("/api/github/link/start")
    assert res.status_code == 200
    url = res.json()["install_url"]
    assert "sanba-app/installations/new" in url
    assert "state=" in url


def test_callback_links_and_status_reflects_it() -> None:
    _link()
    res = client.get("/api/github/link")
    assert res.json() == {"linked": True, "github_login": "octocat"}


def test_callback_rejects_bad_state() -> None:
    res = client.get(
        "/api/github/link/callback", params={"installation_id": 99, "state": "forged.sig"}
    )
    assert res.status_code == 403


def test_unlink_removes_link() -> None:
    _link()
    res = client.delete("/api/github/link")
    assert res.json()["linked"] is False
    assert client.get("/api/github/link").json()["linked"] is False


def test_list_repos_requires_link() -> None:
    assert client.get("/api/github/repos").status_code == 409
    _link()
    res = client.get("/api/github/repos")
    assert res.status_code == 200
    assert res.json()["items"][0]["full_name"] == "octo/demo"


def test_list_branches() -> None:
    _link()
    res = client.get("/api/github/branches", params={"repo": "octo/demo"})
    names = [b["name"] for b in res.json()["items"]]
    assert names == ["main", "dev"]


# ── session repo selection（owner 固定 + 非同期索引） ─────────────────────────
def _override_session_access(session_id: str, sub: str) -> None:
    def _fake(session_id: str = session_id) -> SessionAccess:  # noqa: B008
        return SessionAccess(session_id=session_id, sub=sub, role="pm")

    app.dependency_overrides[require_session_access] = _fake


def _make_session() -> str:
    body = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True}).json()
    return str(body["session_id"])


def test_select_repo_defaults_to_default_branch_and_indexes() -> None:
    _link()
    sid = _make_session()
    _override_session_access(sid, OWNER)
    try:
        res = client.post(f"/api/sessions/{sid}/github", json={"repo": "octo/demo"})
        assert res.status_code == 200
        body = res.json()
        assert body["repo"] == "octo/demo"
        assert body["branch"] == "main"  # 既定=デフォルトブランチ
        assert body["commit_sha"] == "sha-main"
        # 背景タスク完了後（TestClient は同期実行）、状態は ready。
        got = client.get(f"/api/sessions/{sid}/github").json()
        assert got["status"] == "ready"
    finally:
        app.dependency_overrides.pop(require_session_access, None)


def test_select_repo_rejects_non_owner() -> None:
    _link()
    sid = _make_session()
    _override_session_access(sid, "someone-else")
    try:
        res = client.post(f"/api/sessions/{sid}/github", json={"repo": "octo/demo"})
        assert res.status_code == 403
    finally:
        app.dependency_overrides.pop(require_session_access, None)


def test_select_repo_requires_link() -> None:
    sid = _make_session()
    _override_session_access(sid, OWNER)
    try:
        res = client.post(f"/api/sessions/{sid}/github", json={"repo": "octo/demo"})
        assert res.status_code == 409
    finally:
        app.dependency_overrides.pop(require_session_access, None)
