"""Google ID トークンのサーバ側検証と認証依存性。

本人確認 (identity) を司る層。ブラウザ (Next.js) が Google Identity Services で
取得した OIDC の ID トークンを `Authorization: Bearer <id_token>` で受け取り、
**サーバ側で** 署名・`aud`(client_id)・`iss`・`exp`・`email_verified` を検証する
検証済み identity をセッション作成/参加 (LiveKit トークン発行) に束ねる。

設計メモ:
  - クライアント任せにしない。検証は必ずこのサーバで行う (セキュリティ必須事項)。
  - 検証本体は `verifier` に注入可能。本番は `google.oauth2.id_token` で Google の
    公開鍵を取得して検証し、テストは自前 RSA 鍵で実署名・実検証する (claims dict を返す
    点で両者は同形なので分岐が無い)。
  - `auth_dev_bypass` (ローカル限定) のときは固定 dev identity を返し、`just up` を壊さない。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

import structlog
from fastapi import Depends, Header, HTTPException

from .auth import InvalidAuthNonce, verify_auth_nonce
from .config import settings
from .observability import record_auth_event

log = structlog.get_logger(__name__)

_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})

Verifier = Callable[[str, str], dict[str, object]]


class GoogleTokenError(Exception):
    """ID トークンが不正 (署名/aud/iss/exp/claims のいずれか) なときに送出。"""


@dataclass(frozen=True)
class AuthUser:
    """検証済みの本人。`dev=True` はローカル bypass 由来 (本番では出現しない)。"""

    sub: str
    email: str
    email_verified: bool
    name: str
    dev: bool = False
    nonce: str | None = None


def _default_verifier(token: str, client_id: str) -> dict[str, object]:
    """本番経路: Google の公開鍵で署名・aud・exp を検証する。

    `google.oauth2.id_token.verify_oauth2_token` は証明書の取得・キャッシュ・署名検証・
    `aud`/`exp` 検証までを行い、検証済み claims を返す (失敗時は ValueError)。
    """
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    request = google_requests.Request()
    claims: dict[str, object] = id_token.verify_oauth2_token(token, request, client_id)
    return claims


def _validate_claims(claims: dict[str, object]) -> AuthUser:
    """`iss` / `email_verified` / 必須フィールドを検証して AuthUser を組み立てる。

    署名・`aud`・`exp` は verifier 側で検証済み。ここでは Google 固有の追加制約を見る。
    """
    iss = str(claims.get("iss", ""))
    if iss not in _GOOGLE_ISSUERS:
        raise GoogleTokenError(f"unexpected issuer: {iss!r}")

    sub = claims.get("sub")
    if not sub:
        raise GoogleTokenError("missing sub")

    email = str(claims.get("email", ""))
    raw_verified = claims.get("email_verified", False)
    email_verified = raw_verified is True or str(raw_verified).lower() == "true"
    if not email_verified:
        raise GoogleTokenError("email not verified")

    raw_nonce = claims.get("nonce")
    return AuthUser(
        sub=str(sub),
        email=email,
        email_verified=True,
        name=str(claims.get("name", "") or email),
        nonce=str(raw_nonce) if raw_nonce else None,
    )


def verify_google_id_token(
    token: str, client_id: str, *, verifier: Verifier | None = None
) -> AuthUser:
    """ID トークンを検証し、検証済み AuthUser を返す。

    失敗 (署名不正/期限切れ/aud 不一致/iss 不正/未検証 email/改ざん) はすべて
    `GoogleTokenError` に正規化する。
    """
    verify = verifier or _default_verifier
    try:
        claims = verify(token, client_id)
    except GoogleTokenError:
        raise
    except ValueError as exc:
        raise GoogleTokenError(str(exc)) from exc
    except Exception as exc:  # pragma: no cover - 想定外の検証器エラー
        raise GoogleTokenError(f"verification failed: {exc}") from exc
    return _validate_claims(claims)


def require_user(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthUser:
    """FastAPI 依存性: 検証済みの本人を返す。無効/未提示なら 401。

    - `auth_dev_bypass` (ローカル限定): 固定 dev identity を返し検証を素通し。
    - `google_oauth_client_id` 未設定 (本番で設定漏れ): フェイルクローズ (503)。
      「設定漏れで無検証に開く」事故を防ぐ。
    """
    if settings.auth_dev_bypass:
        record_auth_event("dev_bypass")
        return AuthUser(
            sub="dev-user",
            email="dev@sanba.local",
            email_verified=True,
            name="Dev User",
            dev=True,
        )

    if not settings.google_oauth_client_id:
        log.error("auth_misconfigured", reason="GOOGLE_OAUTH_CLIENT_ID 未設定")
        record_auth_event("misconfigured")
        raise HTTPException(status_code=503, detail="authentication not configured")

    if not authorization or not authorization.startswith("Bearer "):
        record_auth_event("missing_bearer")
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = authorization[len("Bearer ") :].strip()
    try:
        user = verify_google_id_token(token, settings.google_oauth_client_id)
    except GoogleTokenError as exc:
        log.warning("auth_rejected", reason=str(exc))
        record_auth_event("rejected")
        raise HTTPException(status_code=401, detail="invalid id token") from exc

    log.info("auth_verified", sub=user.sub)
    record_auth_event("verified")
    return user


CurrentUser = Annotated[AuthUser, Depends(require_user)]


def enforce_login_nonce(user: AuthUser, x_auth_nonce: str | None) -> None:
    """ログイン nonce の束縛を検証する（ADR-0047 §2 の検証本体）。

    ID トークンの `nonce` claim が、サーバが発行した nonce（`X-Auth-Nonce` の署名
    エンベロープ）と一致することを要求し、別文脈で得た ID トークンの注入を弾く。
    トークン発行・管理に直結する identity クリティカルな依存性
    （`require_user_bound` / `maybe_user_bound`）から呼ぶ。

    `require_login_nonce=false`（既定 / 段階リリース）と `auth_dev_bypass`（ローカル）では
    検証せず素通しする。前者は「実環境で on にするまで挙動を変えない」ため、後者は
    dev bypass トークンが nonce を持たないため。いずれの場合も ID トークン自体の検証
    （署名・aud・iss・exp・email_verified）は require_user が済ませている。
    """
    if not settings.require_login_nonce or settings.auth_dev_bypass:
        return

    if not x_auth_nonce:
        log.warning("auth_nonce_missing", sub=user.sub)
        record_auth_event("nonce_missing")
        raise HTTPException(status_code=401, detail="missing auth nonce")

    try:
        expected = verify_auth_nonce(x_auth_nonce, settings.session_signing_secret)
    except InvalidAuthNonce as exc:
        log.warning("auth_nonce_rejected", reason=str(exc))
        record_auth_event("nonce_rejected")
        raise HTTPException(status_code=401, detail="invalid auth nonce") from exc

    if user.nonce != expected:
        log.warning("auth_nonce_mismatch", sub=user.sub)
        record_auth_event("nonce_mismatch")
        raise HTTPException(status_code=401, detail="auth nonce mismatch")

    record_auth_event("nonce_verified")


def require_user_bound(
    user: Annotated[AuthUser, Depends(require_user)],
    x_auth_nonce: Annotated[str | None, Header()] = None,
) -> AuthUser:
    """`require_user` + ログイン nonce の束縛（ADR-0047 §2）。create/join が結線する。"""
    enforce_login_nonce(user, x_auth_nonce)
    return user


CurrentUserBound = Annotated[AuthUser, Depends(require_user_bound)]


def can_create_room(user: AuthUser) -> bool:
    """ルーム(セッション)作成を許可されているか（ADR-0012 §3 / ROOM_CREATOR_ALLOWLIST）。

    admin は常に可。allowlist が空なら誰でも可（現行の「ログイン済みなら誰でも」を維持 /
    GITHUB_REPO_ALLOWLIST と同じ「空=無制限」）。非空なら email 完全一致か、その email の
    ドメイン一致のときだけ可。`is_admin` と同じく dev bypass でも allowlist を照合する
    （素通しの特別扱いをしない。空既定なので `just up` は影響を受けない）。
    """
    if is_admin(user):
        return True
    allow = settings.room_creator_allow_set
    if not allow:
        return True
    email = user.email.lower()
    if email in allow:
        return True
    domain = email.rpartition("@")[2]
    return bool(domain) and domain in allow


def ensure_room_creator(user: AuthUser, operation: str) -> None:
    """ルーム作成 allowlist を強制する（403 / 観測付き）。

    ルームを自発的に開ける経路は create_session と create_product の 2 つ
    （product は自分で深掘りリンクを発行してルームを量産できる入り口なので、
    create_session だけ縛っても product 経由で全バイパスできてしまう）。
    深掘りリンクからの join_product は縛らない: 入場者は owner が発行した招待の
    権限で入るのであって、自発的な開設ではない（ADR-0047 §3）。
    """
    if can_create_room(user):
        return
    log.warning("room_create_denied", sub=user.sub, email=user.email, operation=operation)
    record_auth_event("room_create_denied")
    raise HTTPException(status_code=403, detail="not allowed to create rooms")


def maybe_user(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthUser | None:
    """FastAPI 依存性: ゲスト候補を許す本人確認（1 経路専用）。

    Authorization ヘッダが無ければ None（＝ゲスト候補。許可するかはエンドポイント側が
    `guest_join_enabled` と invite の scope で判定する）。ヘッダが有れば `require_user` と
    完全に同じ検証（フェイルクローズ / 401 を含む）: 「無効なトークンを付けたら
    ゲスト扱いに落ちる」という認可のすり抜けを作らない。
    例外: `auth_dev_bypass`（ローカル限定）はヘッダ無しでも dev identity を返す。
    dev モードの web は Authorization を付けず bypass に委ねるため（lib/api.ts）、
    ここで None にするとローカルのログイン経路が壊れる。ローカルでゲスト経路を通したい
    ときは AUTH_DEV_BYPASS=false + GUEST_JOIN_ENABLED=true にする（Google 設定は不要）。
    ここ以外のエンドポイントで使わないこと（例外面を 1 経路に閉じる）。
    """
    if authorization is None and not settings.auth_dev_bypass:
        return None
    return require_user(authorization)


def maybe_user_bound(
    user: Annotated[AuthUser | None, Depends(maybe_user)],
    x_auth_nonce: Annotated[str | None, Header()] = None,
) -> AuthUser | None:
    """`maybe_user` + ログイン nonce の束縛（ADR-0047 §2）。join_product 専用。

    ゲスト候補（None）は素通し（束縛すべきトークンが無い）。ログイン済みは
    create/join と同じ束縛を掛ける: join_product はセッション作成と LiveKit 入場
    invite の発行に直結するため、ここだけ未束縛だと注入トークンの抜け道になる。
    依存性の内側で `maybe_user` を Depends 解決するのは、テストの
    dependency_overrides[maybe_user] を束縛ごしにも効かせるため。
    """
    if user is not None:
        enforce_login_nonce(user, x_auth_nonce)
    return user


def is_admin(user: AuthUser) -> bool:
    """ADMIN_EMAILS 許可リストに含まれるか。

    任意箇所での認可判定に使う真偽値ヘルパー（例: product の owner or admin 判定・
    can_create_room の常時許可）。`auth_dev_bypass` でも許可リストを照合する。
    未設定（空リスト）は False = フェイルクローズ。
    """
    return user.email.lower() in settings.admin_email_set
