"""Cloud Tasks OIDC token verification for the push handler (defence in depth).

一次防御は Cloud Run IAM invoker 限定（ADR-0040）で、Cloud Tasks 用 SA からの invoke のみ
到達させる。本モジュールはアプリ層の二次防御として、Cloud Tasks が付与する OIDC ID トークン
（`Authorization: Bearer <id_token>`）の署名・issuer・audience をサーバ側で検証する。
本番（`ENVIRONMENT=production`）では検証必須でフェイルクローズし、dev/local では未整備の env を
壊さないため検証しない。
"""

from __future__ import annotations

from collections.abc import Callable

import structlog
from fastapi import HTTPException, Request

from .config import settings

log = structlog.get_logger(__name__)

_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})

OidcVerifier = Callable[[str, str], dict[str, object]]

_verifier: OidcVerifier | None = None


def _default_verifier(token: str, audience: str) -> dict[str, object]:  # pragma: no cover
    """Google の公開鍵で署名・aud・exp を検証し、検証済み claims を返す（失敗時 ValueError）。"""
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    request = google_requests.Request()
    claims: dict[str, object] = id_token.verify_oauth2_token(token, request, audience or None)
    return claims


def verify_oidc_token(
    authorization: str | None,
    *,
    audience: str,
    required: bool,
    verifier: OidcVerifier | None = None,
) -> None:
    """`Authorization: Bearer` の OIDC トークンを検証する。`required=False` なら素通しする。"""
    if not required:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer ") :].strip()
    verify = verifier or _default_verifier
    try:
        claims = verify(token, audience)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("oidc_verification_failed", error=str(exc))
        raise HTTPException(status_code=401, detail="invalid oidc token") from exc
    iss = str(claims.get("iss", ""))
    if iss not in _GOOGLE_ISSUERS:
        raise HTTPException(status_code=401, detail="unexpected issuer")


def require_cloud_tasks_auth(request: Request) -> None:
    """FastAPI 依存: 本番のみ Cloud Tasks の OIDC トークンを検証する（多層防御・一次は IAM）。"""
    verify_oidc_token(
        request.headers.get("Authorization"),
        audience=settings.oidc_audience,
        required=settings.is_production,
        verifier=_verifier,
    )
