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

from .config import settings
from .observability import record_auth_event

log = structlog.get_logger(__name__)

# Google が発行する ID トークンの `iss` (どちらの表記も正規)。
_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})

# 検証関数の型: (token, client_id) -> claims dict。失敗時は例外を送出する。
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
    # email_verified は文字列 "true" で来ることがあるため寛容に解釈する。
    raw_verified = claims.get("email_verified", False)
    email_verified = raw_verified is True or str(raw_verified).lower() == "true"
    if not email_verified:
        raise GoogleTokenError("email not verified")

    return AuthUser(
        sub=str(sub),
        email=email,
        email_verified=True,
        name=str(claims.get("name", "") or email),
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
        # google-auth は署名/aud/exp 不正をすべて ValueError で投げる。
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


# create_session / join_session が結線する依存性エイリアス。
CurrentUser = Annotated[AuthUser, Depends(require_user)]


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


def is_admin(user: AuthUser) -> bool:
    """ADMIN_EMAILS 許可リストに含まれるか。

    `require_admin`（依存性・403/503 を返す）と違い、任意箇所での認可判定に使う
    真偽値ヘルパー（例: product の owner or admin 判定）。
    未設定（空リスト）は False = フェイルクローズ。
    """
    return user.email.lower() in settings.admin_email_set


def require_admin(user: Annotated[AuthUser, Depends(require_user)]) -> AuthUser:
    """FastAPI 依存性: 管理者 (ADMIN_EMAILS 許可リスト) のみ通す。それ以外は 403。

    `auth_dev_bypass` でも許可リストを照合する: dev identity (dev@sanba.local) を
    `ADMIN_EMAILS` に入れておけば `just up` で管理画面が開く。本人確認は require_user
    が済ませており、ここは認可 (誰が管理者か) だけを見る。
    """
    allow = settings.admin_email_set
    if not allow:
        # 設定漏れで管理画面が開く事故を防ぐ (フェイルクローズ)。
        # 内部設定状態 (ADMIN_EMAILS 未設定) はクライアントに開示せず、ログにのみ残す。
        log.error("admin_misconfigured", reason="ADMIN_EMAILS 未設定")
        record_auth_event("admin_misconfigured")
        raise HTTPException(status_code=503, detail="service temporarily unavailable")

    if user.email.lower() not in allow:
        # 監査時に「誰が」拒否されたか追えるよう email も残す (admin_granted と対称)。
        log.warning("admin_denied", sub=user.sub, email=user.email)
        record_auth_event("admin_denied")
        raise HTTPException(status_code=403, detail="admin privileges required")

    record_auth_event("admin_granted")
    return user


CurrentAdmin = Annotated[AuthUser, Depends(require_admin)]
