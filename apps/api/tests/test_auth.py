"""Unit tests for signed session invites."""

from __future__ import annotations

import time

import pytest

from kikitori_api.auth import InvalidInvite, create_invite, verify_invite

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
    assert int(time.time()) > 0  # sanity
