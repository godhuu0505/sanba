"""Server-side auth session (ADR-0060).

Google ID トークンを 1 度だけ受け取って検証し、以後は不透明 SID を格納した HttpOnly Cookie
（`sanba_sid`）で認証する経路を提供する。ブラウザから見た identity は Cookie に閉じる。

エンドポイント:
  POST /api/session/exchange   ID トークン + nonce → SID + Cookie 発行
  DELETE /api/session          現セッションを revoke（Cookie 削除）
  GET /api/session/me          Cookie 由来のプロフィール返却（AuthProvider hydrate 用）

`X-Auth-Nonce` の束縛（ADR-0047）は exchange の 1 回だけで検証する。以降の Cookie 経路では
SID そのものが identity 束縛の役目を果たすため nonce を要求しない。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Annotated, NoReturn

import structlog
from fastapi import APIRouter, Cookie, Header, HTTPException, Request, Response
from pydantic import BaseModel

from ..auth_google import (
    GoogleTokenError,
    enforce_login_nonce,
    verify_google_id_token,
)
from ..config import settings
from ..observability import record_auth_event
from ..session_store import (
    AuthSession,
    SessionStore,
    build_default_store,
    hash_metadata,
    new_sid,
)

log = structlog.get_logger(__name__)

router = APIRouter()

SESSION_COOKIE_NAME = "sanba_sid"


@dataclass
class _StoreHolder:
    """テストが差し替えられるようモジュール単位で保持する。"""

    store: SessionStore | None = None


_holder = _StoreHolder()


def get_session_store() -> SessionStore:
    """Session store のシングルトン。`configure_session_store` でテスト差し替え可能。"""
    if _holder.store is None:
        _holder.store = build_default_store()
    return _holder.store


def configure_session_store(store: SessionStore | None) -> None:
    """テスト・DI 用の差し替え口。"""
    _holder.store = store


class SessionExchangeRequest(BaseModel):
    """POST /api/session/exchange のリクエスト。"""

    id_token: str


class SessionMeResponse(BaseModel):
    """GET /api/session/me / POST /api/session/exchange の応答。"""

    sub: str
    email: str
    email_verified: bool
    name: str
    picture: str = ""
    expires_at: int
    idle_expires_at: int


def _to_me(session: AuthSession) -> SessionMeResponse:
    return SessionMeResponse(
        sub=session.google_sub,
        email=session.email,
        email_verified=session.email_verified,
        name=session.name,
        picture=session.picture,
        expires_at=session.expires_at,
        idle_expires_at=session.idle_expires_at,
    )


def _cookie_domain() -> str | None:
    return settings.session_cookie_domain or None


def _issue_cookie(response: Response, sid: str, max_age: int) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=sid,
        max_age=max_age,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        domain=_cookie_domain(),
    )


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        domain=_cookie_domain(),
    )


def _record_and_raise(status: int, detail: str, event: str) -> NoReturn:
    record_auth_event(event)
    raise HTTPException(status_code=status, detail=detail)


@router.post("/api/session/exchange", response_model=SessionMeResponse)
def exchange_session(
    body: SessionExchangeRequest,
    request: Request,
    response: Response,
    x_auth_nonce: Annotated[str | None, Header()] = None,
) -> SessionMeResponse:
    """ID トークンを検証し、不透明 SID を発行して HttpOnly Cookie にセットする。"""
    if settings.auth_dev_bypass:
        return _issue_dev_session(response, request)

    if not settings.google_oauth_client_id:
        log.error("auth_misconfigured", reason="GOOGLE_OAUTH_CLIENT_ID 未設定")
        _record_and_raise(503, "authentication not configured", "misconfigured")

    try:
        user = verify_google_id_token(body.id_token, settings.google_oauth_client_id)
    except GoogleTokenError as exc:
        log.warning("session_exchange_rejected", reason=str(exc))
        _record_and_raise(401, "invalid id token", "session_exchange_rejected")

    enforce_login_nonce(user, x_auth_nonce)

    now = int(time.time())
    idle_ttl = settings.session_cookie_ttl_seconds
    absolute_ttl = settings.session_absolute_ttl_seconds
    session = AuthSession(
        sid=new_sid(),
        google_sub=user.sub,
        email=user.email,
        email_verified=user.email_verified,
        name=user.name,
        created_at=now,
        last_seen_at=now,
        idle_expires_at=now + idle_ttl,
        expires_at=now + absolute_ttl,
        ua_hash=hash_metadata(request.headers.get("user-agent", "")),
        ip_hash=hash_metadata(request.client.host if request.client else ""),
        picture=user.picture,
    )
    get_session_store().create(session)

    _issue_cookie(response, session.sid, idle_ttl)
    log.info("session_exchanged", sub=user.sub, sid_prefix=session.sid[:8])
    record_auth_event("session_exchanged")
    return _to_me(session)


def _issue_dev_session(response: Response, request: Request) -> SessionMeResponse:
    now = int(time.time())
    idle_ttl = settings.session_cookie_ttl_seconds
    absolute_ttl = settings.session_absolute_ttl_seconds
    session = AuthSession(
        sid=new_sid(),
        google_sub="dev-user",
        email="dev@sanba.local",
        email_verified=True,
        name="Dev User",
        created_at=now,
        last_seen_at=now,
        idle_expires_at=now + idle_ttl,
        expires_at=now + absolute_ttl,
        ua_hash=hash_metadata(request.headers.get("user-agent", "")),
        ip_hash=hash_metadata(request.client.host if request.client else ""),
    )
    get_session_store().create(session)
    _issue_cookie(response, session.sid, idle_ttl)
    record_auth_event("session_exchanged_dev")
    return _to_me(session)


@router.get("/api/session/me", response_model=SessionMeResponse)
def get_me(
    response: Response,
    sanba_sid: Annotated[str | None, Cookie()] = None,
) -> SessionMeResponse:
    """Cookie 由来のプロフィールを返す。ついでに idle TTL を延長する。"""
    if not sanba_sid:
        _record_and_raise(401, "no session", "session_me_missing")

    store = get_session_store()
    session = store.get(sanba_sid)
    if session is None:
        _clear_cookie(response)
        record_auth_event("session_me_expired")
        raise HTTPException(status_code=401, detail="session expired")

    now = int(time.time())
    idle_ttl = settings.session_cookie_ttl_seconds
    new_idle = min(now + idle_ttl, session.expires_at)
    touched = store.touch(session.sid, now, new_idle) or session
    _issue_cookie(response, touched.sid, max(1, touched.idle_expires_at - now))
    record_auth_event("session_me")
    return _to_me(touched)


@router.delete("/api/session", status_code=204)
def revoke_session(
    response: Response,
    sanba_sid: Annotated[str | None, Cookie()] = None,
) -> Response:
    """現セッションを revoke し Cookie を削除する。"""
    if sanba_sid:
        get_session_store().revoke(sanba_sid, int(time.time()))
        record_auth_event("session_revoked")
    _clear_cookie(response)
    response.status_code = 204
    return response


def resolve_cookie_user(sid: str | None) -> AuthSession | None:
    """require_session_or_bearer から呼ばれる: SID から生きたセッションを解決する。"""
    if not sid:
        return None
    session = get_session_store().get(sid)
    if session is None:
        return None
    now = int(time.time())
    idle_ttl = settings.session_cookie_ttl_seconds
    new_idle = min(now + idle_ttl, session.expires_at)
    return get_session_store().touch(session.sid, now, new_idle) or session


__all__ = [
    "SESSION_COOKIE_NAME",
    "configure_session_store",
    "get_session_store",
    "resolve_cookie_user",
    "router",
]
