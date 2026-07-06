"""API tests for GitHub repo linking endpoints (ADR-0028).

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
from sanba_api.routers import github_link

client = TestClient(app)
OWNER = "owner-123456789"


def _fake_user() -> AuthUser:
    return AuthUser(sub=OWNER, email="owner@example.com", email_verified=True, name="Owner")


class FakeClient:
    # OAuth 未構成（dev/local パス）を既定にする。所有権検証テストはサブクラスで上書きする。
    oauth_configured = False

    def user_owns_installation(self, code: str, installation_id: int) -> bool:
        return True

    def close(self) -> None:
        pass

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

    def fetch_issues(self, installation_id: int, repo: str, max_issues: int = 30):  # type: ignore[no-untyped-def]
        return []


@pytest.fixture(autouse=True)
def _setup(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    app.dependency_overrides[require_user] = _fake_user
    monkeypatch.setattr(github_link, "_github_app_client", lambda: FakeClient())
    monkeypatch.setattr(main.settings, "github_app_enabled", True)
    monkeypatch.setattr(main.settings, "github_app_slug", "sanba-app")
    # OAuth 未構成（FakeClient.oauth_configured=False）でも検証を省けるよう dev bypass にする
    # （本番の所有権検証フェイルクローズは別テストで検証する）。
    monkeypatch.setattr(main.settings, "auth_dev_bypass", True)
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


# ── 所有権検証（user-to-server OAuth 構成時）─────────────────────────
class _OAuthClient(FakeClient):
    oauth_configured = True

    def __init__(self, owns: bool) -> None:
        self._owns = owns

    def user_owns_installation(self, code: str, installation_id: int) -> bool:
        return self._owns


def test_callback_requires_code_when_oauth_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_link, "_github_app_client", lambda: _OAuthClient(owns=True))
    state = create_link_state(OWNER, main.settings.session_signing_secret)
    res = client.get("/api/github/link/callback", params={"installation_id": 99, "state": state})
    assert res.status_code == 403  # code 無し → 拒否


def test_callback_rejects_unowned_installation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_link, "_github_app_client", lambda: _OAuthClient(owns=False))
    state = create_link_state(OWNER, main.settings.session_signing_secret)
    res = client.get(
        "/api/github/link/callback",
        params={"installation_id": 99, "state": state, "code": "abc"},
    )
    assert res.status_code == 403
    assert client.get("/api/github/link").json()["linked"] is False


def test_callback_failclosed_when_oauth_unconfigured_and_no_dev_bypass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # OAuth 未構成 かつ dev bypass 無効（本番相当）→ 所有権検証できないので拒否する。
    monkeypatch.setattr(main.settings, "auth_dev_bypass", False)
    state = create_link_state(OWNER, main.settings.session_signing_secret)
    res = client.get("/api/github/link/callback", params={"installation_id": 99, "state": state})
    assert res.status_code == 503
    assert client.get("/api/github/link").json()["linked"] is False


def test_callback_links_when_ownership_verified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_link, "_github_app_client", lambda: _OAuthClient(owns=True))
    state = create_link_state(OWNER, main.settings.session_signing_secret)
    res = client.get(
        "/api/github/link/callback",
        params={"installation_id": 99, "state": state, "code": "abc"},
    )
    assert res.status_code == 200
    assert client.get("/api/github/link").json()["linked"] is True


def test_unlink_removes_link() -> None:
    _link()
    res = client.delete("/api/github/link")
    assert res.json()["linked"] is False
    assert client.get("/api/github/link").json()["linked"] is False


def test_list_repos_unlinked_and_connector_disabled_is_hidden() -> None:
    # 統一エンドポイント（ADR-0027 応答形）: 未連携かつ connector 無効は enabled=False
    # （フィールドごと隠す。409 にはしない）。
    res = client.get("/api/github/repos")
    assert res.status_code == 200
    body = res.json()
    assert body["enabled"] is False
    assert body["repos"] == []
    assert body["linked"] is False


def test_list_repos_uses_app_installation_when_linked() -> None:
    # App 連携済みなら installation 由来の一覧（linked=True + items に default_branch 付き）。
    _link()
    res = client.get("/api/github/repos")
    assert res.status_code == 200
    body = res.json()
    assert body["enabled"] is True
    assert body["linked"] is True
    assert body["repos"] == ["octo/demo"]
    assert body["items"][0]["full_name"] == "octo/demo"
    assert body["items"][0]["default_branch"] == "main"


def test_list_repos_prefers_app_link_over_connector(monkeypatch: pytest.MonkeyPatch) -> None:
    # connector も有効な環境では App 連携（本人の repo）を優先する。未連携なら connector 一覧。
    monkeypatch.setattr(main.settings, "github_connector_enabled", True)
    monkeypatch.setattr(main.settings, "github_token", "t")
    monkeypatch.setattr(main.github_export, "list_repos", lambda token: ["conn/repo"])
    res = client.get("/api/github/repos")
    assert res.json()["repos"] == ["conn/repo"]
    assert res.json()["linked"] is False
    _link()
    res = client.get("/api/github/repos")
    assert res.json()["repos"] == ["octo/demo"]
    assert res.json()["linked"] is True


def test_list_repos_app_candidates_filtered_by_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 許可リスト（GITHUB_REPO_ALLOWLIST）は App 由来の候補一覧にも一貫適用する。
    # 既定リポジトリも同じ判定を通す（許可外の既定はリポ名の露出になる）。
    _link()
    monkeypatch.setattr(main.settings, "github_repo_allowlist", "acme")
    monkeypatch.setattr(main.settings, "github_repo", "octo/demo")
    body = client.get("/api/github/repos").json()
    assert body["linked"] is True
    assert body["repos"] == []  # octo/demo は許可外
    assert body["items"] == []
    assert body["default"] is None


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


def test_select_repo_rejects_repo_outside_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    # 候補一覧を許可リストで絞っても、直接 POST で許可外リポを紐づけ・索引する抜け道を塞ぐ
    # （App 経路の保存にも一貫適用）。
    _link()
    sid = _make_session()
    _override_session_access(sid, OWNER)
    monkeypatch.setattr(main.settings, "github_repo_allowlist", "acme")
    try:
        res = client.post(f"/api/sessions/{sid}/github", json={"repo": "octo/demo"})
        assert res.status_code == 400
        # 索引もキックされない（選択は保存されないまま）。
        meta = main._repo.get_session(sid)
        assert meta is not None and meta.github_repo is None
    finally:
        app.dependency_overrides.pop(require_session_access, None)


def test_stale_index_job_is_skipped() -> None:
    # repo A のジョブが走る前に B を選んだ状態（SessionMeta=B）にして A のジョブを直接呼ぶと、
    # 現在選択と一致しないので索引も書き戻しもしない（stale job guard）。
    from sanba_shared.models import GitHubIndexStatus

    sid = _make_session()
    main._repo.set_session_github(
        sid,
        repo="octo/repoB",
        branch="main",
        commit_sha="shaB",
        index_status=GitHubIndexStatus.INDEXING,
    )
    github_link._index_repo_task(
        session_id=sid,
        installation_id=1,
        repo="octo/repoA",
        branch="main",
        commit_sha="shaA",
    )
    meta = main._repo.get_session(sid)
    assert meta is not None
    # 選択は B のまま（A に巻き戻っていない）。
    assert meta.github_repo == "octo/repoB"
