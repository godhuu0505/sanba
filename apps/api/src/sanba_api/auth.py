"""Signed session-invite tokens.

Fixes the open-join vulnerability: previously anyone could join an arbitrary
`session_id`. Now joining requires a short-lived, HMAC-signed invite that binds
a specific session_id + role + expiry. No external IdP needed (self-contained,
testable); can be swapped for Firebase Auth / Identity Platform later.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass


class InvalidInvite(Exception):
    """Raised when an invite token is malformed, tampered, or expired."""


class InvalidSessionToken(Exception):
    """Raised when a session-access token is malformed, tampered, or expired."""


@dataclass(frozen=True)
class Invite:
    session_id: str
    role: str


@dataclass(frozen=True)
class SessionAccess:
    """Proof that the bearer joined a specific session (read-side authorization)."""

    session_id: str
    sub: str
    role: str


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(payload_b64: str, secret: str) -> str:
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    return _b64url_encode(sig)


def create_invite(session_id: str, role: str, secret: str, ttl_seconds: int = 3600) -> str:
    """Mint a signed invite for `session_id` valid for `ttl_seconds`."""
    payload = {"sid": session_id, "role": role, "exp": int(time.time()) + ttl_seconds}
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    return f"{payload_b64}.{_sign(payload_b64, secret)}"


def verify_invite(token: str, secret: str) -> Invite:
    """Validate signature + expiry and return the bound session/role."""
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError as exc:
        raise InvalidInvite("malformed token") from exc

    expected = _sign(payload_b64, secret)
    if not hmac.compare_digest(sig, expected):
        raise InvalidInvite("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise InvalidInvite("malformed payload") from exc

    # exp が欠落・null（例: 無期限の product invite トークン）の別種トークンでも
    # int(None) の 500 にせず弾く。セッション invite は常に int の exp を持つ。
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < int(time.time()):
        raise InvalidInvite("expired")

    # 同一シークレットで署名された別種トークン（product invite / session token）を
    # 誤って渡されても KeyError の 500 にせず 403 に落とす。
    if not isinstance(payload.get("sid"), str):
        raise InvalidInvite("wrong token kind")
    return Invite(session_id=payload["sid"], role=payload.get("role", "participant"))


# ── Product-invite tokens（深掘りリンク / ADR-0031 決定3）───────────────────────
# product の再利用可能な入場リンク。セッション invite（1 セッション・短命）と違い、
# 失効・使用回数・期限の「正」は Firestore の invite 文書側にあり、このトークンは
# 「owner が発行した本物のリンクである」ことだけを証明する（二段検証の 1 段目）。
# そのため exp は invite 文書の expires_at を写した任意項目で、None（無期限リンク）を許す。
# 検証側は必ず consume_invite（文書照合＋トランザクション消費）を併用すること。


class InvalidProductInvite(Exception):
    """Raised when a product-invite token is malformed, tampered, or expired."""


@dataclass(frozen=True)
class ProductInviteClaim:
    """署名検証済みトークンが指す (product_id, invite_id)。文書照合の鍵。"""

    product_id: str
    invite_id: str


def create_product_invite_token(
    product_id: str, invite_id: str, secret: str, expires_at_epoch: int | None
) -> str:
    """Mint a signed standing link token for a product invite.

    `expires_at_epoch` は invite 文書の expires_at（UNIX 秒）。None = 無期限リンク
    （失効・max_uses で止める運用）。scope で他トークン種との取り違えを防ぐ。
    """
    payload = {
        "pid": product_id,
        "iid": invite_id,
        "scope": "product_invite",
        "exp": expires_at_epoch,
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    return f"{payload_b64}.{_sign(payload_b64, secret)}"


def verify_product_invite_token(token: str, secret: str) -> ProductInviteClaim:
    """Validate signature + scope (+ expiry when set) and return the claim.

    ここを通っても入場可否はまだ確定しない: 失効・使用回数・期限の正は
    Firestore の invite 文書（consume_invite）が持つ（ADR-0031 決定3 の二段検証）。
    """
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError as exc:
        raise InvalidProductInvite("malformed token") from exc

    expected = _sign(payload_b64, secret)
    if not hmac.compare_digest(sig, expected):
        raise InvalidProductInvite("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise InvalidProductInvite("malformed payload") from exc

    if payload.get("scope") != "product_invite":
        raise InvalidProductInvite("wrong scope")
    exp = payload.get("exp")
    if exp is not None and int(exp) < int(time.time()):
        raise InvalidProductInvite("expired")
    product_id = payload.get("pid")
    invite_id = payload.get("iid")
    if not isinstance(product_id, str) or not isinstance(invite_id, str):
        raise InvalidProductInvite("malformed claim")
    return ProductInviteClaim(product_id=product_id, invite_id=invite_id)


# ── Member-invite tokens（メンバー招待 / ADR-0036）──────────────────────────────
# メールで配る招待 URL のトークン。product invite（深掘りリンク）と同じ二段検証:
# このトークンは「owner が発行した本物の招待である」ことだけを証明し、状態
# （pending/accepted/declined/revoked・期限）の正は Firestore の member_invites 文書側。
# 検証側は必ず respond_member_invite（文書照合＋トランザクション遷移）と宛先 email の
# 照合を併用すること（URL の転送だけでは第三者は承諾できない）。


class InvalidMemberInvite(Exception):
    """Raised when a member-invite token is malformed, tampered, or expired."""


@dataclass(frozen=True)
class MemberInviteClaim:
    """署名検証済みトークンが指す (product_id, invite_id)。文書照合の鍵。"""

    product_id: str
    invite_id: str


def create_member_invite_token(
    product_id: str, invite_id: str, secret: str, expires_at_epoch: int | None
) -> str:
    """Mint a signed member-invite token for the invite URL.

    `expires_at_epoch` は invite 文書の expires_at（UNIX 秒）。scope で
    他トークン種（product_invite / session）との取り違えを防ぐ。
    """
    payload = {
        "pid": product_id,
        "mid": invite_id,
        "scope": "member_invite",
        "exp": expires_at_epoch,
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    return f"{payload_b64}.{_sign(payload_b64, secret)}"


def verify_member_invite_token(token: str, secret: str) -> MemberInviteClaim:
    """Validate signature + scope (+ expiry when set) and return the claim.

    ここを通っても承諾可否はまだ確定しない: 状態・宛先の正は Firestore の
    member_invites 文書と検証済み identity の email 照合が持つ（ADR-0036 決定2）。
    """
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError as exc:
        raise InvalidMemberInvite("malformed token") from exc

    expected = _sign(payload_b64, secret)
    if not hmac.compare_digest(sig, expected):
        raise InvalidMemberInvite("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise InvalidMemberInvite("malformed payload") from exc

    if payload.get("scope") != "member_invite":
        raise InvalidMemberInvite("wrong scope")
    exp = payload.get("exp")
    if exp is not None and int(exp) < int(time.time()):
        raise InvalidMemberInvite("expired")
    product_id = payload.get("pid")
    invite_id = payload.get("mid")
    if not isinstance(product_id, str) or not isinstance(invite_id, str):
        raise InvalidMemberInvite("malformed claim")
    return MemberInviteClaim(product_id=product_id, invite_id=invite_id)


# ── Session-access tokens（契約 §4 / Issue #100）─────────────────────────────
# ハイドレーション・起票 API は「join 済みトークン」で保護する。join 時に発行し、
# web は Bearer として GET /requirements 等に付与する。`session_id` をパスに含むだけ
# では参加者以外に要件・検知が漏洩するため、必ずこの署名トークンを検証する。


def create_session_token(
    session_id: str, sub: str, role: str, secret: str, ttl_seconds: int = 3600
) -> str:
    """Mint a signed session-access token bound to session_id + verified sub."""
    payload = {
        "sid": session_id,
        "sub": sub,
        "role": role,
        "scope": "session",
        "exp": int(time.time()) + ttl_seconds,
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    return f"{payload_b64}.{_sign(payload_b64, secret)}"


def verify_session_token(token: str, secret: str) -> SessionAccess:
    """Validate signature + expiry + scope and return the bound session/sub."""
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError as exc:
        raise InvalidSessionToken("malformed token") from exc

    expected = _sign(payload_b64, secret)
    if not hmac.compare_digest(sig, expected):
        raise InvalidSessionToken("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise InvalidSessionToken("malformed payload") from exc

    if payload.get("scope") != "session":
        raise InvalidSessionToken("wrong scope")
    if int(payload.get("exp", 0)) < int(time.time()):
        raise InvalidSessionToken("expired")

    return SessionAccess(
        session_id=payload["sid"],
        sub=payload.get("sub", ""),
        role=payload.get("role", "participant"),
    )


# ── ログイン nonce チャレンジ（ADR-0046）──────────────────────────────────────
# ID トークン注入（aud だけ合う、別文脈で得た Google ID トークンの使い回し）を防ぐ。
# サーバが nonce を発行 → web が GIS の initialize({nonce}) に渡す → Google が ID トークンの
# `nonce` claim に埋める → create/join でサーバが claim と照合する。invite/session token と
# 同じステートレス HMAC 方式で、サーバ側に nonce を保存しない（多インスタンスでも整合）。
# 生 nonce をそのまま header で送り返すだけだと「トークンを盗めば nonce も送れる」ため無力
# だが、ここでは **サーバ署名エンベロープ** を返させることで、claim と一致する nonce を持つ
# エンベロープをサーバの署名なしには作れなくしている（照合の正がサーバの HMAC 鍵側にある）。


class InvalidAuthNonce(Exception):
    """Raised when an auth-nonce envelope is malformed, tampered, or expired."""


def create_auth_nonce(secret: str, ttl_seconds: int) -> tuple[str, str]:
    """ログイン nonce を発行する。戻り値は (raw_nonce, envelope)。

    `raw_nonce` は GIS の `id.initialize({nonce})` に渡す生値（ID トークンの `nonce` claim に
    入る）。`envelope` は「この nonce をサーバが発行した」ことを証す HMAC 署名付き短命トークン
    で、web は `X-Auth-Nonce` として返す。サーバは envelope から raw_nonce を再導出して
    claim と照合する（保存不要）。
    """
    raw = secrets.token_urlsafe(32)
    payload = {"nonce": raw, "scope": "auth_nonce", "exp": int(time.time()) + ttl_seconds}
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    return raw, f"{payload_b64}.{_sign(payload_b64, secret)}"


def verify_auth_nonce(envelope: str, secret: str) -> str:
    """envelope の署名・scope・期限を検証し、埋め込まれた raw nonce を返す。"""
    try:
        payload_b64, sig = envelope.split(".", 1)
    except ValueError as exc:
        raise InvalidAuthNonce("malformed token") from exc

    expected = _sign(payload_b64, secret)
    if not hmac.compare_digest(sig, expected):
        raise InvalidAuthNonce("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise InvalidAuthNonce("malformed payload") from exc

    if payload.get("scope") != "auth_nonce":
        raise InvalidAuthNonce("wrong scope")
    if int(payload.get("exp", 0)) < int(time.time()):
        raise InvalidAuthNonce("expired")
    nonce = payload.get("nonce")
    if not isinstance(nonce, str) or not nonce:
        raise InvalidAuthNonce("malformed claim")
    return nonce
