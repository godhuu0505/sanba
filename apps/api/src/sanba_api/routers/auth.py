"""ログイン nonce チャレンジの発行（ADR-0046）。

GIS の `id.initialize({nonce})` に渡す nonce をサーバが発行し、web はその署名エンベロープを
`X-Auth-Nonce` として create/join に添える。サーバは ID トークンの `nonce` claim と照合して
別文脈で得た ID トークンの注入を弾く（検証本体は auth_google.require_user_bound）。

発行はログイン前に呼ばれるため認証不要。ステートレス（HMAC 署名 + 短命）なので nonce を
サーバ側に保存せず、多インスタンスでも整合する（invite/session token と同じ仕組み）。
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..auth import create_auth_nonce
from ..config import settings
from ..observability import record_auth_event

router = APIRouter()


class AuthNonceResponse(BaseModel):
    """GET /api/auth/nonce の応答。"""

    # GIS の initialize({nonce}) に渡す生 nonce（ID トークンの nonce claim に入る）。
    nonce: str
    # X-Auth-Nonce として create/join に返す HMAC 署名エンベロープ。
    token: str


@router.get("/api/auth/nonce", response_model=AuthNonceResponse)
def issue_auth_nonce() -> AuthNonceResponse:
    """ログイン nonce を発行する。"""
    raw, envelope = create_auth_nonce(
        settings.session_signing_secret, settings.auth_nonce_ttl_seconds
    )
    record_auth_event("nonce_issued")
    return AuthNonceResponse(nonce=raw, token=envelope)
