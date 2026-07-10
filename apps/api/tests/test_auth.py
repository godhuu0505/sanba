"""Unit tests for signed session invites."""

from __future__ import annotations

import time

import pytest

from sanba_api.auth import (
    InvalidAuthNonce,
    InvalidInvite,
    create_auth_nonce,
    create_invite,
    create_session_token,
    verify_auth_nonce,
    verify_invite,
)

SECRET = "test-secret"


def test_roundtrip_returns_session_and_role() -> None:
    token = create_invite("sess-abc", "engineer", SECRET)
    invite = verify_invite(token, SECRET)
    assert invite.session_id == "sess-abc"
    assert invite.role == "engineer"


def test_wrong_secret_is_rejected() -> None:
    token = create_invite("sess-abc", "pm", SECRET)
    with pytest.raises(InvalidInvite):
        verify_invite(token, "different-secret")


def test_tampered_payload_is_rejected() -> None:
    token = create_invite("sess-abc", "pm", SECRET)
    payload, sig = token.split(".", 1)
    with pytest.raises(InvalidInvite):
        verify_invite(f"{payload}x.{sig}", SECRET)


def test_expired_invite_is_rejected() -> None:
    token = create_invite("sess-abc", "pm", SECRET, ttl_seconds=-1)
    with pytest.raises(InvalidInvite, match="expired"):
        verify_invite(token, SECRET)


def test_malformed_token_is_rejected() -> None:
    with pytest.raises(InvalidInvite):
        verify_invite("garbage-without-dot", SECRET)


def test_invite_not_yet_expired_passes() -> None:
    token = create_invite("sess-abc", "pm", SECRET, ttl_seconds=60)
    invite = verify_invite(token, SECRET)
    assert invite.session_id == "sess-abc"
    assert int(time.time()) > 0


def test_invite_rejects_other_token_kind() -> None:
    """同一シークレットで署名された session トークンは scope で弾く（トークン混同防止）。"""
    token = create_session_token("sess-x", "sub-1", "pm", SECRET)
    with pytest.raises(InvalidInvite, match="wrong scope"):
        verify_invite(token, SECRET)


def test_auth_nonce_roundtrip_returns_raw() -> None:
    raw, envelope = create_auth_nonce(SECRET, 600)
    assert verify_auth_nonce(envelope, SECRET) == raw


def test_auth_nonce_wrong_secret_is_rejected() -> None:
    _, envelope = create_auth_nonce(SECRET, 600)
    with pytest.raises(InvalidAuthNonce):
        verify_auth_nonce(envelope, "different-secret")


def test_auth_nonce_tampered_is_rejected() -> None:
    _, envelope = create_auth_nonce(SECRET, 600)
    payload, sig = envelope.split(".", 1)
    with pytest.raises(InvalidAuthNonce):
        verify_auth_nonce(f"{payload}x.{sig}", SECRET)


def test_auth_nonce_expired_is_rejected() -> None:
    _, envelope = create_auth_nonce(SECRET, -1)
    with pytest.raises(InvalidAuthNonce, match="expired"):
        verify_auth_nonce(envelope, SECRET)


def test_auth_nonce_rejects_other_token_kind() -> None:
    """同一シークレットで署名された別種トークン（session）は scope で弾く。"""
    token = create_session_token("sess-x", "sub-1", "pm", SECRET)
    with pytest.raises(InvalidAuthNonce, match="wrong scope"):
        verify_auth_nonce(token, SECRET)
