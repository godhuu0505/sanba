"""product メンバー / メンバー招待 (ADR-0036) の単体テスト。

モデル検証（ランダム ID・小文字正規化は api 層の責務のため範囲外）と、
SessionRepository のメモリ fallback での CRUD・招待応答（正常/異常/同時実行で
二重承諾しない）・delete_product のカスケードを検証する。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from sanba_shared.models import (
    MemberInviteStatus,
    Product,
    ProductMember,
    ProductMemberInvite,
    new_member_invite_id,
)
from sanba_shared.repository import (
    MemberInviteNotFound,
    MemberInviteNotPending,
    ProductNotFound,
    SessionRepository,
)


def _repo() -> SessionRepository:
    repo = SessionRepository(data_retention_days=30)
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback で走る前提"
    return repo


def _seed_product(repo: SessionRepository, pid: str = "prod-1", owner: str = "owner-1") -> Product:
    product = Product(id=pid, name="請求アプリ", owner_sub=owner)
    repo.create_product(product)
    return product


def _member(pid: str = "prod-1", sub: str = "sub-1", email: str = "m@example.com") -> ProductMember:
    return ProductMember(product_id=pid, sub=sub, email=email)


def _invite(
    repo: SessionRepository,
    *,
    invite_id: str = "minv-1",
    product_id: str = "prod-1",
    email: str = "invitee@example.com",
    status: MemberInviteStatus = MemberInviteStatus.PENDING,
    expires_at: datetime | None = None,
) -> ProductMemberInvite:
    invite = ProductMemberInvite(
        id=invite_id,
        product_id=product_id,
        email=email,
        invited_by_sub="owner-1",
        invited_by_email="owner@example.com",
        status=status,
        expires_at=expires_at,
    )
    repo.create_member_invite(invite)
    return invite


def test_new_member_invite_id_is_random_and_prefixed() -> None:
    a, b = new_member_invite_id(), new_member_invite_id()
    assert a.startswith("minv-") and b.startswith("minv-")
    assert a != b


# ---- メンバー CRUD -----------------------------------------------------------
def test_member_crud_roundtrip() -> None:
    repo = _repo()
    _seed_product(repo)
    repo.add_product_member(_member())
    got = repo.get_product_member("prod-1", "sub-1")
    assert got is not None and got.email == "m@example.com"
    assert [m.sub for m in repo.list_product_members("prod-1")] == ["sub-1"]
    assert repo.remove_product_member("prod-1", "sub-1") is True
    assert repo.get_product_member("prod-1", "sub-1") is None
    # 冪等: 既に居ない sub の削除は False で安全に返る。
    assert repo.remove_product_member("prod-1", "sub-1") is False


def test_add_member_requires_parent_product() -> None:
    repo = _repo()
    with pytest.raises(ProductNotFound):
        repo.add_product_member(_member(pid="prod-missing"))


def test_list_products_by_member_returns_membership_products_newest_first() -> None:
    repo = _repo()
    old = Product(
        id="prod-old",
        name="old",
        owner_sub="o",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    new = Product(
        id="prod-new",
        name="new",
        owner_sub="o",
        created_at=datetime(2026, 6, 1, tzinfo=UTC),
    )
    repo.create_product(old)
    repo.create_product(new)
    repo.add_product_member(_member(pid="prod-old", sub="sub-1"))
    repo.add_product_member(_member(pid="prod-new", sub="sub-1"))
    repo.add_product_member(_member(pid="prod-new", sub="sub-2"))
    assert [p.id for p in repo.list_products_by_member("sub-1")] == ["prod-new", "prod-old"]
    # メンバーシップが指す product が消えた行はスキップされる（delete との競合）。
    repo.delete_product("prod-new")
    assert [p.id for p in repo.list_products_by_member("sub-1")] == ["prod-old"]


# ---- メンバー招待: 作成・一覧 --------------------------------------------------
def test_create_member_invite_requires_parent_product() -> None:
    repo = _repo()
    with pytest.raises(ProductNotFound):
        _invite(repo, product_id="prod-missing")


def test_list_member_invites_by_product_and_email() -> None:
    repo = _repo()
    _seed_product(repo)
    _seed_product(repo, pid="prod-2")
    _invite(repo, invite_id="minv-1", email="a@example.com")
    _invite(repo, invite_id="minv-2", email="b@example.com")
    _invite(repo, invite_id="minv-3", product_id="prod-2", email="a@example.com")
    assert {i.id for i in repo.list_member_invites("prod-1")} == {"minv-1", "minv-2"}
    assert {i.id for i in repo.list_member_invites_by_email("a@example.com")} == {
        "minv-1",
        "minv-3",
    }


# ---- メンバー招待: 応答 --------------------------------------------------------
def test_accept_invite_creates_member_atomically() -> None:
    repo = _repo()
    _seed_product(repo)
    _invite(repo)
    updated, member = repo.respond_member_invite(
        "minv-1", accept=True, sub="sub-9", email="invitee@example.com", display_name="招待 太郎"
    )
    assert updated.status is MemberInviteStatus.ACCEPTED
    assert updated.accepted_sub == "sub-9"
    assert updated.responded_at is not None
    assert member is not None and member.sub == "sub-9"
    got = repo.get_product_member("prod-1", "sub-9")
    assert got is not None and got.invited_by_sub == "owner-1"


def test_decline_invite_does_not_create_member() -> None:
    repo = _repo()
    _seed_product(repo)
    _invite(repo)
    updated, member = repo.respond_member_invite(
        "minv-1", accept=False, sub="sub-9", email="invitee@example.com"
    )
    assert updated.status is MemberInviteStatus.DECLINED
    assert updated.accepted_sub is None
    assert member is None
    assert repo.get_product_member("prod-1", "sub-9") is None


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (MemberInviteStatus.ACCEPTED, "accepted"),
        (MemberInviteStatus.DECLINED, "declined"),
        (MemberInviteStatus.REVOKED, "revoked"),
    ],
)
def test_respond_rejects_non_pending(status: MemberInviteStatus, reason: str) -> None:
    repo = _repo()
    _seed_product(repo)
    _invite(repo, status=status)
    with pytest.raises(MemberInviteNotPending) as exc:
        repo.respond_member_invite("minv-1", accept=True, sub="sub-9", email="invitee@example.com")
    assert exc.value.reason == reason


def test_respond_rejects_expired_and_missing() -> None:
    repo = _repo()
    _seed_product(repo)
    _invite(repo, expires_at=datetime.now(UTC) - timedelta(seconds=1))
    with pytest.raises(MemberInviteNotPending) as exc:
        repo.respond_member_invite("minv-1", accept=True, sub="sub-9", email="invitee@example.com")
    assert exc.value.reason == "expired"
    with pytest.raises(MemberInviteNotFound):
        repo.respond_member_invite(
            "minv-missing", accept=True, sub="sub-9", email="invitee@example.com"
        )


def test_respond_rejects_when_product_deleted() -> None:
    """delete_product との競合: 親なしメンバーを作らない。"""
    repo = _repo()
    _seed_product(repo)
    _invite(repo)
    # カスケード削除で招待自体が消える経路が正だが、競合の窓（read 後の削除）を模す。
    del repo._mem_products["prod-1"]
    with pytest.raises(ProductNotFound):
        repo.respond_member_invite("minv-1", accept=True, sub="sub-9", email="invitee@example.com")


def test_concurrent_accept_only_transitions_once() -> None:
    """並行応答でも pending → accepted の遷移は 1 回だけ成立する。"""
    repo = _repo()
    _seed_product(repo)
    _invite(repo)

    def _try(i: int) -> bool:
        try:
            repo.respond_member_invite(
                "minv-1", accept=True, sub=f"sub-{i}", email="invitee@example.com"
            )
            return True
        except MemberInviteNotPending:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(_try, range(8)))
    assert sum(results) == 1
    assert len(repo.list_product_members("prod-1")) == 1


# ---- メンバー招待: 取り消し ----------------------------------------------------
def test_revoke_member_invite_is_idempotent_and_blocks_response() -> None:
    repo = _repo()
    _seed_product(repo)
    _invite(repo)
    revoked = repo.revoke_member_invite("minv-1")
    assert revoked.status is MemberInviteStatus.REVOKED
    # 冪等: 既 revoked でも例外にしない。
    assert repo.revoke_member_invite("minv-1").status is MemberInviteStatus.REVOKED
    with pytest.raises(MemberInviteNotPending) as exc:
        repo.respond_member_invite("minv-1", accept=True, sub="sub-9", email="invitee@example.com")
    assert exc.value.reason == "revoked"


def test_revoke_rejects_responded_and_missing() -> None:
    repo = _repo()
    _seed_product(repo)
    _invite(repo, status=MemberInviteStatus.ACCEPTED)
    with pytest.raises(MemberInviteNotPending):
        repo.revoke_member_invite("minv-1")
    with pytest.raises(MemberInviteNotFound):
        repo.revoke_member_invite("minv-missing")


# ---- delete_product のカスケード -----------------------------------------------
def test_delete_product_cascades_members_and_member_invites() -> None:
    repo = _repo()
    _seed_product(repo)
    _seed_product(repo, pid="prod-2")
    repo.add_product_member(_member())
    repo.add_product_member(_member(pid="prod-2", sub="sub-2"))
    _invite(repo, invite_id="minv-1")
    _invite(repo, invite_id="minv-2", product_id="prod-2")
    assert repo.delete_product("prod-1") is True
    assert repo.list_product_members("prod-1") == []
    assert repo.list_member_invites("prod-1") == []
    assert repo.get_member_invite("minv-1") is None
    # 他 product は巻き込まない。
    assert [m.sub for m in repo.list_product_members("prod-2")] == ["sub-2"]
    assert repo.get_member_invite("minv-2") is not None
