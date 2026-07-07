"""メンバー管理・メンバー招待（main.py から分割 / 挙動不変）。

/api/products/{id}/members* と /api/member-invites/* を持つ。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sanba_shared.models import (
    MemberInviteStatus,
    ProductMemberInvite,
    new_member_invite_id,
)
from sanba_shared.repository import (
    MemberInviteNotFound,
    MemberInviteNotPending,
    ProductNotFound,
)

from ..auth import (
    InvalidMemberInvite,
    create_member_invite_token,
    verify_member_invite_token,
)
from ..auth_google import AuthUser, is_admin, require_user
from ..config import settings
from ..deps import _repo, _require_product_access
from ..mailer import send_member_invite_email
from ..observability import record_member_event, record_rate_limited

log = structlog.get_logger(__name__)

router = APIRouter()


def _is_valid_invite_email(email: str) -> bool:
    """招待宛先の形式検証（厳密な RFC 準拠ではなく明らかな入力ミスを弾く）。

    正の検証は「そのアドレスに届いたメールから承諾できるか」= email 照合が担う。
    正規表現は使わない（`[^@\\s]+@[^@\\s]+\\.[^@\\s]+` 型は入力次第で多項式時間の
    バックトラッキングが起きる / CodeQL ReDoS 指摘）。判定は線形: 空白なし・@ が
    ちょうど 1 つ・local 非空・ドメインに非空の区切り . がある、のみを見る。
    """
    if any(c.isspace() for c in email):
        return False
    local, sep, domain = email.partition("@")
    if not sep or not local or "@" in domain:
        return False
    host, dot, tld = domain.rpartition(".")
    return bool(dot and host and tld)


class ProductMemberDisplay(BaseModel):
    """メンバー 1 件の応答形。sub は削除操作のキーとして必要（それ以外の識別子は返さない）。"""

    sub: str
    email: str
    display_name: str
    created_at: datetime


class RemoveMemberResponse(BaseModel):
    removed: bool


class CreateMemberInviteRequest(BaseModel):
    """`POST /api/products/{id}/member-invites`。宛先はハンドラ側で小文字正規化する。"""

    email: str = Field(max_length=320)


class MemberInviteDisplay(BaseModel):
    """発行済みメンバー招待 1 件（管理 UI 用）。web は token から招待 URL を組める。"""

    id: str
    email: str
    status: str
    created_at: datetime
    expires_at: datetime | None
    invited_by_email: str
    token: str


class MyMemberInviteDisplay(BaseModel):
    """自分宛の保留中招待 1 件（アプリ内通知用 / ADR-0036 決定3）。

    応答は invite id で行うため token は載せない（メール URL 経由と同じ承諾に合流する）。
    """

    id: str
    product_id: str
    product_name: str
    invited_by_email: str
    created_at: datetime
    expires_at: datetime | None


class RespondMemberInviteRequest(BaseModel):
    """承諾 / 辞退。action は列挙のみ（他の値は 422）。"""

    action: str = Field(pattern="^(accept|decline)$")


class MemberInviteActionResponse(BaseModel):
    status: str
    product_id: str


class ResolveMemberInviteRequest(BaseModel):
    """招待 URL のトークンを検証して表示用情報を得る（承諾前の確認画面用）。

    トークンは URL パスに現れるが API へは body で渡す（アクセスログに残さない。
    products/join と同方針）。
    """

    token: str


class RespondMemberInviteByTokenRequest(BaseModel):
    token: str
    action: str = Field(pattern="^(accept|decline)$")


class MemberInviteResolution(BaseModel):
    """招待 URL を開いた人へ見せる情報。宛先 email はマスクして返す（本人確認前のため）。"""

    id: str
    product_name: str
    invited_by_email: str
    masked_email: str
    status: str
    email_match: bool


def _member_invite_display(invite: ProductMemberInvite) -> MemberInviteDisplay:
    token = create_member_invite_token(
        invite.product_id,
        invite.id,
        settings.session_signing_secret,
        int(invite.expires_at.timestamp()) if invite.expires_at else None,
    )
    return MemberInviteDisplay(
        id=invite.id,
        email=invite.email,
        status=_invite_effective_status(invite),
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        invited_by_email=invite.invited_by_email,
        token=token,
    )


def _invite_effective_status(invite: ProductMemberInvite) -> str:
    """表示用の状態。pending でも期限切れなら expired に平す（文書は書き換えない）。"""
    if (
        invite.status is MemberInviteStatus.PENDING
        and invite.expires_at is not None
        and invite.expires_at <= datetime.now(UTC)
    ):
        return "expired"
    return invite.status.value


def _mask_email(email: str) -> str:
    """宛先 email の伏せ字（例: godai***@leverages.jp）。本人確認前の画面に出すため。"""
    local, _, domain = email.partition("@")
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}***@{domain}"


def _member_invite_url(token: str) -> str:
    """招待メールに載せる web の承諾ページ URL。"""
    return f"{settings.web_base_url.rstrip('/')}/member-invites/{token}"


@router.get("/api/products/{product_id}/members", response_model=list[ProductMemberDisplay])
def list_product_members(
    product_id: str, user: AuthUser = Depends(require_user)
) -> list[ProductMemberDisplay]:
    """メンバー一覧（owner / admin / メンバー本人たち）。owner はここに含まれない
    （owner_sub が単一の正のまま / ADR-0036 決定1）。"""
    _require_product_access(product_id, user)
    return [
        ProductMemberDisplay(
            sub=m.sub, email=m.email, display_name=m.display_name, created_at=m.created_at
        )
        for m in _repo.list_product_members(product_id)
    ]


@router.delete(
    "/api/products/{product_id}/members/{member_sub}", response_model=RemoveMemberResponse
)
def remove_product_member(
    product_id: str, member_sub: str, user: AuthUser = Depends(require_user)
) -> RemoveMemberResponse:
    """メンバーを外す（owner / admin、またはメンバー本人の離脱）。

    過去に作られたセッションはそのまま残す（出所メタであり権限の器ではない）。
    以後の product 閲覧・product 従属セッションの新規作成ができなくなる。
    """
    product = _require_product_access(product_id, user)
    if user.sub != member_sub and user.sub != product.owner_sub and not is_admin(user):
        raise HTTPException(status_code=403, detail="owner or admin only")
    removed = _repo.remove_product_member(product_id, member_sub)
    if not removed:
        raise HTTPException(status_code=404, detail="member not found")
    record_member_event("member_removed")
    log.info(
        "product_member_removed",
        product=product_id,
        member=member_sub,
        by=user.sub,
        self_leave=user.sub == member_sub,
    )
    return RemoveMemberResponse(removed=True)


@router.post("/api/products/{product_id}/member-invites", response_model=MemberInviteDisplay)
def create_product_member_invite(
    product_id: str,
    req: CreateMemberInviteRequest,
    background: BackgroundTasks,
    user: AuthUser = Depends(require_user),
) -> MemberInviteDisplay:
    """メンバー招待を発行し、招待メールを送る（ADR-0036 決定2/3）。

    発行は owner のみ（深掘りリンクと同じく所有者の意思で発行する）。メール送信は
    背景タスク（応答をブロックしない）。SMTP 未設定でも招待は成立し、宛先の人が
    ログインすればアプリ内通知（GET /api/member-invites/mine）に出る。
    """
    product = _require_product_access(product_id, user, manage=True)
    if user.sub != product.owner_sub:
        raise HTTPException(status_code=403, detail="owner only")
    email = req.email.strip().lower()
    if not _is_valid_invite_email(email):
        raise HTTPException(status_code=400, detail="invalid email address")
    if email == user.email.lower():
        raise HTTPException(status_code=400, detail="cannot invite yourself")
    if any(m.email.lower() == email for m in _repo.list_product_members(product_id)):
        raise HTTPException(status_code=409, detail="already a member")
    pending = [
        i for i in _repo.list_member_invites(product_id) if _invite_effective_status(i) == "pending"
    ]
    if any(i.email == email for i in pending):
        raise HTTPException(status_code=409, detail="already invited")
    if len(pending) >= settings.member_invite_max_pending_per_product:
        record_rate_limited(limiter="member_invite")
        log.warning(
            "member_invite_rate_limited",
            product=product_id,
            owner=user.sub,
            pending=len(pending),
        )
        raise HTTPException(status_code=429, detail="too many pending invites")
    invite = ProductMemberInvite(
        id=new_member_invite_id(),
        product_id=product_id,
        email=email,
        invited_by_sub=user.sub,
        invited_by_email=user.email,
        expires_at=datetime.now(UTC) + timedelta(seconds=settings.member_invite_ttl_seconds),
    )
    try:
        _repo.create_member_invite(invite)
    except ProductNotFound as exc:
        raise HTTPException(status_code=404, detail="product not found") from exc
    display = _member_invite_display(invite)
    background.add_task(
        send_member_invite_email,
        to=email,
        product_name=product.name,
        inviter_email=user.email,
        invite_url=_member_invite_url(display.token),
        expires_at=invite.expires_at,
    )
    record_member_event("invite_created")
    log.info(
        "member_invite_created",
        product=product_id,
        invite=invite.id,
        owner=user.sub,
    )
    return display


@router.get("/api/products/{product_id}/member-invites", response_model=list[MemberInviteDisplay])
def list_product_member_invites(
    product_id: str, user: AuthUser = Depends(require_user)
) -> list[MemberInviteDisplay]:
    """発行済みメンバー招待の一覧（owner / admin。管理 UI 用）。"""
    _require_product_access(product_id, user, manage=True)
    return [_member_invite_display(i) for i in _repo.list_member_invites(product_id)]


@router.post(
    "/api/products/{product_id}/member-invites/{invite_id}/revoke",
    response_model=MemberInviteDisplay,
)
def revoke_product_member_invite(
    product_id: str, invite_id: str, user: AuthUser = Depends(require_user)
) -> MemberInviteDisplay:
    """メンバー招待を取り消す（owner / admin）。冪等（既取り消しでも 200）。

    応答済み（accepted / declined）は取り消せない（409。メンバーを外すのは
    DELETE members の役割で、招待履歴は書き換えない）。
    """
    _require_product_access(product_id, user, manage=True)
    invite = _repo.get_member_invite(invite_id)
    if invite is None or invite.product_id != product_id:
        raise HTTPException(status_code=404, detail="invite not found")
    try:
        revoked = _repo.revoke_member_invite(invite_id)
    except MemberInviteNotFound as exc:
        raise HTTPException(status_code=404, detail="invite not found") from exc
    except MemberInviteNotPending as exc:
        raise HTTPException(
            status_code=409, detail=f"invite already responded: {exc.reason}"
        ) from exc
    record_member_event("invite_revoked")
    log.info("member_invite_revoked", product=product_id, invite=invite_id, by=user.sub)
    return _member_invite_display(revoked)


@router.get("/api/member-invites/mine", response_model=list[MyMemberInviteDisplay])
def list_my_member_invites(user: AuthUser = Depends(require_user)) -> list[MyMemberInviteDisplay]:
    """自分宛の保留中招待（アプリ内通知 / ADR-0036 決定3）。

    検証済み identity の email（require_user が email_verified を保証）と宛先の
    小文字照合で絞る。期限切れ・応答済みは出さない。招待元 product が消えていれば
    スキップする（カスケード削除の競合窓）。ページングは持たない（list_sessions と同じ
    MVP 方針。宛先ごとの保留中招待はごく少数で、product の追加 read もその件数に比例）。
    """
    invites = _repo.list_member_invites_by_email(user.email.lower())
    rows: list[MyMemberInviteDisplay] = []
    for invite in invites:
        if _invite_effective_status(invite) != "pending":
            continue
        product = _repo.get_product(invite.product_id)
        if product is None:
            continue
        rows.append(
            MyMemberInviteDisplay(
                id=invite.id,
                product_id=invite.product_id,
                product_name=product.name,
                invited_by_email=invite.invited_by_email,
                created_at=invite.created_at,
                expires_at=invite.expires_at,
            )
        )
    log.info("my_member_invites_listed", sub=user.sub, count=len(rows))
    return rows


def _respond_member_invite(
    invite: ProductMemberInvite, action: str, user: AuthUser
) -> MemberInviteActionResponse:
    """承諾/辞退の共通処理（id 経由・token 経由の両方が合流する）。

    宛先照合は呼び出し側で済ませていること。状態遷移とメンバー作成の原子性は
    repository（トランザクション/ロック）が担う。
    """
    accept = action == "accept"
    try:
        updated, _member = _repo.respond_member_invite(
            invite.id,
            accept=accept,
            sub=user.sub,
            email=user.email,
            display_name=user.name,
        )
    except MemberInviteNotFound as exc:
        raise HTTPException(status_code=404, detail="invite not found") from exc
    except ProductNotFound as exc:
        raise HTTPException(status_code=404, detail="invite not found") from exc
    except MemberInviteNotPending as exc:
        raise HTTPException(status_code=409, detail=f"invite not pending: {exc.reason}") from exc
    event = "invite_accepted" if accept else "invite_declined"
    record_member_event(event)
    log.info(
        "member_invite_responded",
        product=invite.product_id,
        invite=invite.id,
        action=action,
        sub=user.sub,
    )
    return MemberInviteActionResponse(status=updated.status.value, product_id=invite.product_id)


@router.post("/api/member-invites/{invite_id}/respond", response_model=MemberInviteActionResponse)
def respond_member_invite(
    invite_id: str, req: RespondMemberInviteRequest, user: AuthUser = Depends(require_user)
) -> MemberInviteActionResponse:
    """アプリ内通知からの承諾 / 辞退（ADR-0036 決定2）。

    宛先 email と一致しない呼び出しは不存在と同じ 404 に平す（自分宛でない招待の
    存在を応答差で漏らさない）。
    """
    invite = _repo.get_member_invite(invite_id)
    if invite is None or invite.email != user.email.lower():
        raise HTTPException(status_code=404, detail="invite not found")
    return _respond_member_invite(invite, req.action, user)


@router.post("/api/member-invites/resolve", response_model=MemberInviteResolution)
def resolve_member_invite(
    req: ResolveMemberInviteRequest, user: AuthUser = Depends(require_user)
) -> MemberInviteResolution:
    """招待 URL のトークンを検証し、承諾前の確認画面用の情報を返す（ADR-0036 決定2）。

    署名検証（owner 発行の本物か）→ 文書照合の二段。トークン保持がこの情報の閲覧
    権限（URL を受け取った人が内容を確認できないと承諾判断ができない）。宛先 email は
    マスクして返し、email_match=false のときに「どのアカウントでログインし直すべきか」の
    手がかりだけを与える。
    """
    try:
        claim = verify_member_invite_token(req.token, settings.session_signing_secret)
    except InvalidMemberInvite as exc:
        log.warning("member_invite_token_rejected", reason=str(exc))
        raise HTTPException(status_code=403, detail=f"invalid invite link: {exc}") from exc
    invite = _repo.get_member_invite(claim.invite_id)
    if invite is None or invite.product_id != claim.product_id:
        raise HTTPException(status_code=404, detail="invite not found")
    product = _repo.get_product(invite.product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="invite not found")
    return MemberInviteResolution(
        id=invite.id,
        product_name=product.name,
        invited_by_email=invite.invited_by_email,
        masked_email=_mask_email(invite.email),
        status=_invite_effective_status(invite),
        email_match=invite.email == user.email.lower(),
    )


@router.post("/api/member-invites/respond-by-token", response_model=MemberInviteActionResponse)
def respond_member_invite_by_token(
    req: RespondMemberInviteByTokenRequest, user: AuthUser = Depends(require_user)
) -> MemberInviteActionResponse:
    """招待メールの URL からの承諾 / 辞退（ADR-0036 決定2）。

    署名検証 → 文書照合 → 宛先 email 照合の三段。トークンを持っていても宛先本人で
    なければ承諾できない（403。resolve が masked_email で誘導する）。
    """
    try:
        claim = verify_member_invite_token(req.token, settings.session_signing_secret)
    except InvalidMemberInvite as exc:
        log.warning("member_invite_token_rejected", reason=str(exc))
        raise HTTPException(status_code=403, detail=f"invalid invite link: {exc}") from exc
    invite = _repo.get_member_invite(claim.invite_id)
    if invite is None or invite.product_id != claim.product_id:
        raise HTTPException(status_code=404, detail="invite not found")
    if invite.email != user.email.lower():
        raise HTTPException(status_code=403, detail="invite addressed to another email")
    return _respond_member_invite(invite, req.action, user)
