"""API tests for the invite-gated session flow.

These exercise the invite/authorization logic; the Google identity layer
is stubbed via a dependency override so a verified user is assumed.
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


# ── セッション単位の連携リポジトリ ─────────────────────────────
def test_create_session_accepts_github_repo() -> None:
    res = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "acme/product-a"},
    )
    assert res.status_code == 200
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
    # 空文字は明示的な「連携しない」。None（未指定=フォールバック）と区別して保存する。
    res = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "github_repo": "  "},
    )
    assert res.status_code == 200
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.github_repo == ""


# ── セッション準備情報 ───────────────────────────────────────
def test_create_session_persists_prep_goal() -> None:
    # 準備フォームのゴール・詳細は SessionMeta に保存され、agent が起動時に
    # 初期 instructions へシードする（join 後の RAG 投入と違い起動に確実に間に合う）。
    res = client.post(
        "/api/sessions",
        json={
            "roles": ["pm"],
            "consent_acknowledged": True,
            "goal": "検索を速くしたい",
            "goal_detail": "現状は検索が遅い。まず商品検索だけ対象にしたい。",
        },
    )
    assert res.status_code == 200
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.goal == "検索を速くしたい"
    assert meta.goal_detail == "現状は検索が遅い。まず商品検索だけ対象にしたい。"


def test_create_session_normalizes_blank_goal_to_none() -> None:
    # 空白のみは未入力扱い（premise を無駄に付けない）。未指定も None。
    res = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "goal": "  ", "goal_detail": "\n"},
    )
    assert res.status_code == 200
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.goal is None
    assert meta.goal_detail is None


def test_create_session_rejects_oversized_goal() -> None:
    # premise の肥大を上限で防ぐ（goal 2000 / goal_detail 8000）。
    res = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "goal": "あ" * 2001},
    )
    assert res.status_code == 422


def test_create_session_omitted_github_repo_stays_none() -> None:
    # 未指定は None のまま = 環境変数フォールバックの挙動。
    res = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.github_repo is None


# ── 対象プロダクトへの従属 ─────────────────────────────────────
def _seed_owned_product(**kwargs: object) -> str:
    """`_fake_user`（owner-123456789）が所有する product をメモリ repo に用意する。"""
    from datetime import UTC, datetime

    from sanba_shared.models import Product

    from sanba_api.main import _repo

    _repo._mem_products.clear()
    pid = "prod-owned"
    _repo.create_product(
        Product(
            id=pid,
            name="検索アプリ",
            owner_sub="owner-123456789",
            created_at=datetime(2024, 6, 20, tzinfo=UTC),
            **kwargs,  # type: ignore[arg-type]
        )
    )
    return pid


def test_create_session_links_product_and_inherits_repo() -> None:
    # product に紐づけると SessionMeta.product_id が入り、索引済み repo を継承する。
    pid = _seed_owned_product(
        github_repo="acme/search",
        github_branch="main",
        github_index_status="ready",
    )
    res = client.post(
        "/api/sessions",
        json={"roles": ["customer"], "consent_acknowledged": True, "product_id": pid},
    )
    assert res.status_code == 200, res.text
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.product_id == pid
    # repo 未指定なので product の索引済み repo を継承（resolution: セッション明示 > product）。
    assert meta.github_repo == "acme/search"
    assert meta.github_branch == "main"
    assert meta.github_index_status == "ready"


def test_create_session_explicit_repo_wins_over_product() -> None:
    # セッションで明示 repo を送ったら product 継承より優先する。
    pid = _seed_owned_product(github_repo="acme/search", github_index_status="ready")
    res = client.post(
        "/api/sessions",
        json={
            "roles": ["customer"],
            "consent_acknowledged": True,
            "product_id": pid,
            "github_repo": "acme/other",
        },
    )
    assert res.status_code == 200, res.text
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.product_id == pid
    assert meta.github_repo == "acme/other"


def test_create_session_explicit_opt_out_not_overridden_by_product() -> None:
    # 空文字（明示的な「連携しない」）は product repo で上書きしない。
    pid = _seed_owned_product(github_repo="acme/search", github_index_status="ready")
    res = client.post(
        "/api/sessions",
        json={
            "roles": ["customer"],
            "consent_acknowledged": True,
            "product_id": pid,
            "github_repo": "",
        },
    )
    assert res.status_code == 200, res.text
    from sanba_api.main import _repo

    meta = _repo.get_session(res.json()["session_id"])
    assert meta is not None
    assert meta.product_id == pid
    assert meta.github_repo == ""


def test_create_session_rejects_unauthorized_product_as_404() -> None:
    # 他人所有・不存在の product は 404 に平す（存在秘匿）。
    from datetime import UTC, datetime

    from sanba_shared.models import Product

    from sanba_api.main import _repo

    _repo._mem_products.clear()
    _repo.create_product(
        Product(
            id="prod-foreign",
            name="他人アプリ",
            owner_sub="someone-else",
            created_at=datetime(2024, 6, 20, tzinfo=UTC),
        )
    )
    foreign = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "product_id": "prod-foreign"},
    )
    assert foreign.status_code == 404
    missing = client.post(
        "/api/sessions",
        json={"roles": ["pm"], "consent_acknowledged": True, "product_id": "prod-nope"},
    )
    assert missing.status_code == 404


def test_create_session_rejects_repo_outside_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    # 許可リスト設定時は一覧に出ないリポを直接 POST で保存する抜け道も塞ぐ。
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
    # 共有トークンが読める private リポ名を許可リスト外のユーザー環境へ漏らさない。
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


def test_github_repos_default_outside_allowlist_is_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    # 既定リポジトリも許可リストを通す（許可外の既定はリポ名の露出になり、
    # UI が候補外の既定値を選択肢として補ってしまう）。
    from sanba_api import github_export, main
    from sanba_api.config import settings

    monkeypatch.setattr(settings, "github_connector_enabled", True)
    monkeypatch.setattr(settings, "github_token", "t")
    monkeypatch.setattr(settings, "github_repo", "secretorg/hidden")
    monkeypatch.setattr(settings, "github_repo_allowlist", "acme")
    monkeypatch.setattr(github_export, "list_repos", lambda token, per_page=100: ["acme/a"])
    monkeypatch.setattr(main.github_export, "list_repos", lambda token, per_page=100: ["acme/a"])
    body = client.get("/api/github/repos").json()
    assert body["repos"] == ["acme/a"]
    assert body["default"] is None


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
