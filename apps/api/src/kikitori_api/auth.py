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
import time
from dataclasses import dataclass


class InvalidInvite(Exception):
    """Raised when an invite token is malformed, tampered, or expired."""


@dataclass(frozen=True)
class Invite:
    session_id: str
    role: str


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(payload_b64: str, secret: str) -> str:
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    return _b64url_encode(sig)


def create_invite(
    session_id: str, role: str, secret: str, ttl_seconds: int = 3600
) -> str:
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

    if int(payload.get("exp", 0)) < int(time.time()):
        raise InvalidInvite("expired")

    return Invite(session_id=payload["sid"], role=payload.get("role", "participant"))
