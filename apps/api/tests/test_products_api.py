"""products API (ADR-0031 / PR2) のテスト。

- 認可の一点集約 (_require_product_access): owner / admin のみ。非所有・不存在は 404 に平す。
- name 空 400・未ログイン 401・allowlist・同一 (repo,branch,sha) の再索引スキップ。
すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import GitHubLink, Product, ProductInvite

from sanba_api import auth_google, main
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import app

client = TestClient(app)
OWNER = "owner-sub"
ADMIN_EMAIL = "boss@example.com"


def _user(sub: str, email: str = "u@example.com") -> AuthUser:
    return AuthUser(sub=sub, email=email, email_verified=True, name=email)


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    main._repo._mem_products.clear()
    main._repo._mem_invites.clear()
    main._repo._mem_github_links.clear()
    assert main._repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield
    app.dependency_overrides.pop(require_user, None)


def _login(sub: str, email: str = "u@example.com") -> None:
    app.dependency_overrides[require_user] = lambda: _user(sub, email)


def _create(name: str = "請求アプリ", **kwargs: Any) -> dict[str, Any]:
    # slug は必須（ADR-0040）。指定がなければ既定値で埋める（各テストの関心事を汚さない）。
    payload: dict[str, Any] = {"name": name, "slug": "test-app"}
    payload.update(kwargs)
    res = client.post("/api/products", json=payload)
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _seed(pid: str, owner: str, *, created: datetime, name: str = "t") -> None:
    main._repo.create_product(Product(id=pid, name=name, owner_sub=owner, created_at=created))


# ---- FR-1.1: 登録・一覧 ------------------------------------------------------
def test_create_product_returns_random_id_and_no_owner_pii() -> None:
    _login(OWNER)
    body = _create(name="  請求アプリ  ", description=" 経費精算 ", glossary=[" 請求書 ", ""])
    assert body["id"].startswith("prod-")
    assert body["name"] == "請求アプリ"  # strip される
    assert body["description"] == "経費精算"
    assert body["glossary"] == ["請求書"]  # 空要素は捨てる
    assert body["github_index_status"] == "none"
    assert body["slug"] == "test-app"
    # PII / 内部識別子は返さない (最小権限)。
    assert "owner_sub" not in body


def test_create_product_rejects_empty_name_as_400() -> None:
    _login(OWNER)
    assert client.post("/api/products", json={"name": "   ", "slug": "x-app"}).status_code == 400


def test_create_product_requires_login(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    assert client.post("/api/products", json={"name": "x", "slug": "x-app"}).status_code == 401


# ---- slug（ADR-0040）---------------------------------------------------------
def test_create_product_normalizes_and_validates_slug() -> None:
    _login(OWNER)
    # 前後空白・大文字は正規化して受理する。
    body = _create(slug="  Billing-App  ")
    assert body["slug"] == "billing-app"
    # 形式違反（1 文字・先頭/末尾ハイフン・非 ASCII・空白・記号）は 400。
    for bad in ["a", "-abc", "abc-", "日本語", "has space", "app!"]:
        res = client.post("/api/products", json={"name": "x", "slug": bad})
        assert res.status_code == 400, f"slug={bad!r} は 400 のはず"
    # 予約語（web の既存ルートと衝突する slug）は 400。
    for reserved in ["products", "prepare", "sessions", "results", "login", "api"]:
        res = client.post("/api/products", json={"name": "x", "slug": reserved})
        assert res.status_code == 400, f"slug={reserved!r} は予約語のはず"


def test_create_product_duplicate_slug_is_409() -> None:
    _login(OWNER)
    _create(slug="dup-app")
    # 別ユーザーでもグローバルに一意（テナント 1 つ / ADR-0040）。
    _login("someone-else")
    res = client.post("/api/products", json={"name": "y", "slug": "dup-app"})
    assert res.status_code == 409


def test_update_product_changes_slug_with_conflict_check() -> None:
    _login(OWNER)
    pid = _create(slug="first-app")["id"]
    _create(name="他", slug="other-app")
    # 変更は正規化して受理、使用済みは 409、形式違反は 400。
    res = client.patch(f"/api/products/{pid}", json={"slug": "Renamed-App"})
    assert res.status_code == 200
    assert res.json()["slug"] == "renamed-app"
    assert client.patch(f"/api/products/{pid}", json={"slug": "other-app"}).status_code == 409
    assert client.patch(f"/api/products/{pid}", json={"slug": "bad slug"}).status_code == 400
    # 409/400 後も現値は保たれる。
    assert client.get(f"/api/products/{pid}").json()["slug"] == "renamed-app"


def test_legacy_product_without_slug_is_returned_as_none() -> None:
    """slug 導入前の既存アプリ（未設定）は None のまま返す（web が設定を促す）。"""
    _seed("prod-legacy", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _login(OWNER)
    assert client.get("/api/products/prod-legacy").json()["slug"] is None


def test_mine_returns_only_own_products_sorted_desc() -> None:
    _seed("prod-old", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _seed("prod-new", OWNER, created=datetime(2026, 6, 1, tzinfo=UTC))
    _seed("prod-other", "someone-else", created=datetime(2026, 3, 1, tzinfo=UTC))
    _login(OWNER)
    body = client.get("/api/products/mine").json()
    assert [p["id"] for p in body] == ["prod-new", "prod-old"]


# ---- FR-1.2 / NFR-6: 認可の一点集約 -----------------------------------------
def test_get_product_owner_ok_other_user_404() -> None:
    _seed("prod-1", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _login(OWNER)
    assert client.get("/api/products/prod-1").status_code == 200
    # 非所有は 404 (403 ではない): 応答差で他人の product ID の存在を漏らさない
    # (/api/sessions/mine/{id} と同じ方針)。
    _login("intruder")
    assert client.get("/api/products/prod-1").status_code == 404


def test_admin_can_read_and_update(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_google.settings, "admin_emails", ADMIN_EMAIL, raising=True)
    _seed("prod-1", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _login("admin-sub", ADMIN_EMAIL)
    assert client.get("/api/products/prod-1").status_code == 200
    assert client.patch("/api/products/prod-1", json={"name": "改名"}).status_code == 200


def test_unknown_product_is_404() -> None:
    _login(OWNER)
    assert client.get("/api/products/prod-none").status_code == 404
    assert client.patch("/api/products/prod-none", json={"name": "x"}).status_code == 404
    assert client.delete("/api/products/prod-none").status_code == 404


def test_update_product_edits_allowed_fields_only() -> None:
    _login(OWNER)
    pid = _create()["id"]
    res = client.patch(
        f"/api/products/{pid}", json={"name": "新名称", "glossary": ["検索", "絞り込み"]}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "新名称"
    assert body["glossary"] == ["検索", "絞り込み"]
    # 空 name は 400、過長な語彙は 400。
    assert client.patch(f"/api/products/{pid}", json={"name": "  "}).status_code == 400
    assert client.patch(f"/api/products/{pid}", json={"glossary": ["x" * 101]}).status_code == 400
    # 非所有の更新・削除も 404 に平す。
    _login("intruder")
    assert client.patch(f"/api/products/{pid}", json={"name": "hack"}).status_code == 404
    assert client.delete(f"/api/products/{pid}").status_code == 404


def test_delete_product_cascades_invites() -> None:
    _seed("prod-1", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    main._repo.create_invite(ProductInvite(id="inv-1", product_id="prod-1"))
    _login(OWNER)
    assert client.delete("/api/products/prod-1").json() == {"deleted": True}
    assert main._repo.get_product("prod-1") is None
    assert main._repo.get_invite("prod-1", "inv-1") is None
    # 削除済みは 404 (存在秘匿と同じ応答)。
    assert client.delete("/api/products/prod-1").status_code == 404


# ---- FR-1.3: repo 紐づけと索引 ------------------------------------------------
class FakeClient:
    """GitHubAppClient の最小 fake (test_github_link_api.py と同型・ネットワークなし)。"""

    def close(self) -> None:
        pass

    def repo_meta(self, installation_id: int, repo: str) -> dict[str, object]:
        return {"description": "demo", "language": "Python", "default_branch": "main"}

    def branch_head_sha(self, installation_id: int, repo: str, branch: str) -> str:
        return f"sha-{branch}"

    def list_tree(self, installation_id: int, repo: str, sha: str):  # type: ignore[no-untyped-def]
        from sanba_api.github_app import IndexFile, TreeListing

        return TreeListing(files=[IndexFile("README.md", 20), IndexFile("src/main.py", 30)])

    def fetch_file(self, installation_id: int, repo: str, sha: str, path: str) -> str:
        return "print('hi')\n"

    def fetch_readme(self, installation_id: int, repo: str, sha: str) -> str | None:
        return "# Demo"

    def fetch_issues(self, installation_id: int, repo: str, max_issues: int = 30):  # type: ignore[no-untyped-def]
        return []


def _link_github(sub: str = OWNER) -> None:
    main._repo.set_github_link(GitHubLink(sub=sub, installation_id=99, github_login="octocat"))


@pytest.fixture()
def _github(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "_github_app_client", lambda: FakeClient())


def test_select_repo_requires_owner_even_for_admin(
    monkeypatch: pytest.MonkeyPatch, _github: None
) -> None:
    """紐づけは owner の installation を使うため admin でも 403 (閲覧はできる)。"""
    monkeypatch.setattr(auth_google.settings, "admin_emails", ADMIN_EMAIL, raising=True)
    _seed("prod-1", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _login("admin-sub", ADMIN_EMAIL)
    res = client.post("/api/products/prod-1/github", json={"repo": "octo/demo"})
    assert res.status_code == 403


def test_select_repo_validates_format_and_allowlist(
    monkeypatch: pytest.MonkeyPatch, _github: None
) -> None:
    _seed("prod-1", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _link_github()
    _login(OWNER)
    assert (
        client.post("/api/products/prod-1/github", json={"repo": "not-a-repo"}).status_code == 400
    )
    # NFR-2: GITHUB_REPO_ALLOWLIST は product の紐づけにも一貫適用する。
    monkeypatch.setattr(main.settings, "github_repo_allowlist", "octo", raising=True)
    assert client.post("/api/products/prod-1/github", json={"repo": "evil/x"}).status_code == 400
    assert client.post("/api/products/prod-1/github", json={"repo": "octo/demo"}).status_code == 200


def test_select_repo_409_when_not_linked(_github: None) -> None:
    _seed("prod-1", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _login(OWNER)
    assert client.post("/api/products/prod-1/github", json={"repo": "octo/demo"}).status_code == 409


def test_select_repo_indexes_and_reuses_same_sha(
    monkeypatch: pytest.MonkeyPatch, _github: None
) -> None:
    """索引キック後 ready になり、同一 (repo,branch,sha) の再 POST は再索引しない (FR-1.3 AC)。"""
    _seed("prod-1", OWNER, created=datetime(2026, 1, 1, tzinfo=UTC))
    _link_github()
    _login(OWNER)

    calls: list[str] = []
    original = main._index_product_repo_task

    def _spy(**kwargs: Any) -> None:
        calls.append(kwargs["repo"])
        original(**kwargs)

    monkeypatch.setattr(main, "_index_product_repo_task", _spy)

    res = client.post("/api/products/prod-1/github", json={"repo": "octo/demo"})
    assert res.status_code == 200
    assert res.json()["status"] == "indexing"
    # TestClient は応答後に background task を実行する → fake 索引が完走して ready。
    assert calls == ["octo/demo"]
    body = client.get("/api/products/prod-1").json()
    assert body["github_repo"] == "octo/demo"
    assert body["github_branch"] == "main"
    assert body["github_commit_sha"] == "sha-main"
    assert body["github_index_status"] == "ready"

    # 同一 (repo, branch, sha): 再索引せず現状 (ready) を返す。
    res2 = client.post("/api/products/prod-1/github", json={"repo": "octo/demo"})
    assert res2.status_code == 200
    assert res2.json()["status"] == "ready"
    assert calls == ["octo/demo"]  # 背景タスクは増えない
