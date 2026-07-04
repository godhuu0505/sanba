"""product / 深掘りリンク (ADR-0031) の単体テスト。

モデル検証（不正値・旧文書互換・ランダム ID）と、SessionRepository のメモリ fallback での
CRUD・invite 消費（正常/異常/同時実行で max_uses を超えない）を検証する。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from sanba_shared.models import (
    GitHubIndexStatus,
    InviteScope,
    Product,
    ProductInvite,
    new_invite_id,
    new_product_id,
)
from sanba_shared.repository import (
    InviteNotFound,
    InviteNotUsable,
    ProductNotFound,
    SessionRepository,
)


def _repo() -> SessionRepository:
    repo = SessionRepository(data_retention_days=30)
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback で走る前提"
    return repo


def _product(pid: str = "prod-1", owner: str = "sub-1") -> Product:
    return Product(id=pid, name="請求アプリ", owner_sub=owner)


def _invite(
    repo: SessionRepository,
    *,
    invite_id: str = "inv-1",
    product_id: str = "prod-1",
    expires_at: datetime | None = None,
    max_uses: int | None = None,
    revoked: bool = False,
) -> ProductInvite:
    invite = ProductInvite(
        id=invite_id,
        product_id=product_id,
        expires_at=expires_at,
        max_uses=max_uses,
        revoked=revoked,
    )
    repo.create_invite(invite)
    return invite


# ---- モデル検証 -------------------------------------------------------------


def test_product_rejects_empty_name() -> None:
    with pytest.raises(ValidationError):
        Product(id="prod-1", name="", owner_sub="sub-1")


def test_invite_rejects_invalid_scope_and_max_uses() -> None:
    with pytest.raises(ValidationError):
        ProductInvite(id="inv-1", product_id="prod-1", scope="admin")  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        ProductInvite(id="inv-1", product_id="prod-1", max_uses=0)


def test_product_roundtrips_through_json_with_defaults() -> None:
    product = _product()
    restored = Product.model_validate(product.model_dump(mode="json"))
    assert restored == product
    assert restored.glossary == []
    assert restored.github_repo is None
    assert restored.github_index_status is GitHubIndexStatus.NONE


def test_invite_defaults_to_developer_scope_and_unlimited() -> None:
    invite = ProductInvite(id="inv-1", product_id="prod-1")
    assert invite.scope is InviteScope.DEVELOPER
    assert invite.expires_at is None
    assert invite.max_uses is None
    assert invite.use_count == 0
    assert invite.revoked is False


def test_random_ids_have_prefix_and_do_not_collide() -> None:
    pids = {new_product_id() for _ in range(100)}
    iids = {new_invite_id() for _ in range(100)}
    assert len(pids) == 100 and all(p.startswith("prod-") for p in pids)
    assert len(iids) == 100 and all(i.startswith("inv-") for i in iids)
    # リンク ID は URL に露出するため product ID より長いエントロピーを持つ。
    assert min(len(i) for i in iids) > max(len(p) for p in pids)


# ---- products CRUD ----------------------------------------------------------


def test_create_get_and_list_products_by_owner() -> None:
    repo = _repo()
    old = Product(
        id="prod-old",
        name="旧",
        owner_sub="alice",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    new = Product(
        id="prod-new",
        name="新",
        owner_sub="alice",
        created_at=datetime(2026, 6, 1, tzinfo=UTC),
    )
    other = Product(id="prod-bob", name="他人", owner_sub="bob")
    for p in (old, new, other):
        repo.create_product(p)

    assert repo.get_product("prod-old") == old
    # owner_sub 一致のみ・created_at 降順（list_sessions_by_owner と同じ意味論）。
    assert [p.id for p in repo.list_products_by_owner("alice")] == ["prod-new", "prod-old"]
    assert repo.list_products_by_owner("carol") == []


def test_update_product_only_touches_editable_fields() -> None:
    repo = _repo()
    repo.create_product(_product())
    updated = repo.update_product("prod-1", name="新名称", glossary=["請求書", "取引先"])
    assert updated.name == "新名称"
    assert updated.glossary == ["請求書", "取引先"]
    # 所有・出所は不変。
    assert updated.owner_sub == "sub-1"
    assert updated.created_at == repo.get_product("prod-1").created_at  # type: ignore[union-attr]

    with pytest.raises(ValidationError):
        repo.update_product("prod-1", name="")
    with pytest.raises(ProductNotFound):
        repo.update_product("prod-none", name="x")


def test_set_product_github_preserves_other_fields() -> None:
    repo = _repo()
    repo.create_product(_product())
    updated = repo.set_product_github(
        "prod-1",
        repo="owner/name",
        branch="main",
        commit_sha="abc123",
        index_status=GitHubIndexStatus.READY,
        summary="要約",
    )
    assert updated is not None
    assert updated.github_repo == "owner/name"
    assert updated.github_index_status is GitHubIndexStatus.READY
    assert updated.name == "請求アプリ"
    assert (
        repo.set_product_github(
            "prod-none",
            repo=None,
            branch=None,
            commit_sha=None,
            index_status=GitHubIndexStatus.NONE,
        )
        is None
    )


def test_delete_product_removes_invites_too() -> None:
    repo = _repo()
    repo.create_product(_product())
    _invite(repo)
    assert repo.delete_product("prod-1") is True
    assert repo.get_product("prod-1") is None
    assert repo.get_invite("prod-1", "inv-1") is None
    # 冪等: 既に無ければ False。
    assert repo.delete_product("prod-1") is False


# ---- invites ----------------------------------------------------------------


def test_create_invite_requires_existing_product() -> None:
    repo = _repo()
    with pytest.raises(ProductNotFound):
        _invite(repo, product_id="prod-none")


def test_list_and_revoke_invites() -> None:
    repo = _repo()
    repo.create_product(_product())
    _invite(repo, invite_id="inv-1")
    _invite(repo, invite_id="inv-2")
    assert {i.id for i in repo.list_invites("prod-1")} == {"inv-1", "inv-2"}

    assert repo.revoke_invite("prod-1", "inv-1") is True
    assert repo.get_invite("prod-1", "inv-1").revoked is True  # type: ignore[union-attr]
    # 冪等: 既失効でも True、存在しなければ False。
    assert repo.revoke_invite("prod-1", "inv-1") is True
    assert repo.revoke_invite("prod-1", "inv-none") is False


def test_consume_invite_increments_use_count() -> None:
    repo = _repo()
    repo.create_product(_product())
    _invite(repo, max_uses=2)
    assert repo.consume_invite("prod-1", "inv-1").use_count == 1
    assert repo.consume_invite("prod-1", "inv-1").use_count == 2
    assert repo.get_invite("prod-1", "inv-1").use_count == 2  # type: ignore[union-attr]


def test_consume_invite_rejects_unusable_without_consuming() -> None:
    repo = _repo()
    repo.create_product(_product())

    _invite(repo, invite_id="inv-revoked", revoked=True)
    with pytest.raises(InviteNotUsable) as exc:
        repo.consume_invite("prod-1", "inv-revoked")
    assert exc.value.reason == "revoked"

    _invite(
        repo,
        invite_id="inv-expired",
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    with pytest.raises(InviteNotUsable) as exc:
        repo.consume_invite("prod-1", "inv-expired")
    assert exc.value.reason == "expired"

    _invite(repo, invite_id="inv-full", max_uses=1)
    repo.consume_invite("prod-1", "inv-full")
    with pytest.raises(InviteNotUsable) as exc:
        repo.consume_invite("prod-1", "inv-full")
    assert exc.value.reason == "exhausted"

    # どの理由でも use_count は消費されない。
    assert repo.get_invite("prod-1", "inv-revoked").use_count == 0  # type: ignore[union-attr]
    assert repo.get_invite("prod-1", "inv-expired").use_count == 0  # type: ignore[union-attr]
    assert repo.get_invite("prod-1", "inv-full").use_count == 1  # type: ignore[union-attr]

    with pytest.raises(InviteNotFound):
        repo.consume_invite("prod-1", "inv-none")


def test_consume_invite_is_atomic_under_concurrency() -> None:
    """並行 join が上限を跨いでも use_count が max_uses を超えない（FR-1.6 AC）。"""
    repo = _repo()
    repo.create_product(_product())
    _invite(repo, max_uses=50)

    def _try_consume(_: int) -> bool:
        try:
            repo.consume_invite("prod-1", "inv-1")
            return True
        except InviteNotUsable as exc:
            assert exc.reason == "exhausted"
            return False

    with ThreadPoolExecutor(max_workers=32) as pool:
        results = list(pool.map(_try_consume, range(100)))

    assert sum(results) == 50
    assert repo.get_invite("prod-1", "inv-1").use_count == 50  # type: ignore[union-attr]
