"""Google ID トークン検証の単体テスト (ADR-0012)。

テスト内で生成した RSA 鍵で **実署名・実検証** する。署名検証・`aud`・`exp` は
`google.auth.jwt` に通すので「正常 / 期限切れ / 改ざん / aud 不一致」は本物の暗号で
担保される。`iss` / `email_verified` は `_validate_claims` のロジックを検証する。
"""

from __future__ import annotations

import time
from collections.abc import Callable

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from google.auth import crypt
from google.auth import jwt as google_jwt

from sanba_api.auth_google import (
    AuthUser,
    GoogleTokenError,
    can_create_room,
    verify_google_id_token,
)
from sanba_api.config import settings

CLIENT_ID = "test-client-id.apps.googleusercontent.com"
KID = "test-kid"


@pytest.fixture(scope="module")
def keypair() -> tuple[str, str]:
    """(private_pem, public_pem) を一度だけ生成する。"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem


@pytest.fixture
def mint(keypair: tuple[str, str]) -> Callable[..., str]:
    """テスト用の ID トークン発行関数。**実鍵で署名する**。"""
    private_pem, _ = keypair
    signer = crypt.RSASigner.from_string(private_pem, KID)

    def _mint(**overrides: object) -> str:
        now = int(time.time())
        payload: dict[str, object] = {
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "sub": "1234567890",
            "email": "user@example.com",
            "email_verified": True,
            "name": "Test User",
            "iat": now,
            "exp": now + 3600,
        }
        payload.update(overrides)
        return google_jwt.encode(signer, payload).decode()

    return _mint


@pytest.fixture
def verifier(keypair: tuple[str, str]) -> Callable[[str, str], dict[str, object]]:
    """実証明書 (公開鍵) で署名・aud・exp を検証する verifier。"""
    _, public_pem = keypair
    certs = {KID: public_pem}

    def _verify(token: str, client_id: str) -> dict[str, object]:
        return google_jwt.decode(token, certs=certs, audience=client_id)

    return _verify


def test_valid_token_returns_user(mint, verifier) -> None:
    user = verify_google_id_token(mint(), CLIENT_ID, verifier=verifier)
    assert user.sub == "1234567890"
    assert user.email == "user@example.com"
    assert user.email_verified is True
    assert user.name == "Test User"
    assert user.dev is False


def test_expired_token_is_rejected(mint, verifier) -> None:
    token = mint(exp=int(time.time()) - 3600, iat=int(time.time()) - 7200)
    with pytest.raises(GoogleTokenError):
        verify_google_id_token(token, CLIENT_ID, verifier=verifier)


def test_tampered_token_is_rejected(mint, verifier) -> None:
    token = mint()
    header, payload, sig = token.split(".")
    # ペイロードを 1 文字書き換えると署名が一致しなくなる。
    tampered = f"{header}.{payload[:-2] + ('A' if payload[-1] != 'A' else 'B')}.{sig}"
    with pytest.raises(GoogleTokenError):
        verify_google_id_token(tampered, CLIENT_ID, verifier=verifier)


def test_audience_mismatch_is_rejected(mint, verifier) -> None:
    token = mint(aud="some-other-client.apps.googleusercontent.com")
    with pytest.raises(GoogleTokenError):
        verify_google_id_token(token, CLIENT_ID, verifier=verifier)


def test_wrong_issuer_is_rejected(mint, verifier) -> None:
    # 署名・aud・exp は通るが iss が Google でない → _validate_claims が弾く。
    token = mint(iss="https://evil.example.com")
    with pytest.raises(GoogleTokenError, match="issuer"):
        verify_google_id_token(token, CLIENT_ID, verifier=verifier)


def test_unverified_email_is_rejected(mint, verifier) -> None:
    token = mint(email_verified=False)
    with pytest.raises(GoogleTokenError, match="email"):
        verify_google_id_token(token, CLIENT_ID, verifier=verifier)


def test_email_verified_as_string_is_accepted(mint, verifier) -> None:
    # Google は email_verified を文字列 "true" で返すことがある。
    user = verify_google_id_token(mint(email_verified="true"), CLIENT_ID, verifier=verifier)
    assert user.email_verified is True


def test_missing_sub_is_rejected(mint, verifier) -> None:
    token = mint(sub="")
    with pytest.raises(GoogleTokenError, match="sub"):
        verify_google_id_token(token, CLIENT_ID, verifier=verifier)


# ── nonce claim の取り出し (ADR-0046) ─────────────────────────────────────────


def test_nonce_claim_is_extracted(mint, verifier) -> None:
    user = verify_google_id_token(mint(nonce="n-abc123"), CLIENT_ID, verifier=verifier)
    assert user.nonce == "n-abc123"


def test_missing_nonce_claim_is_none(mint, verifier) -> None:
    # nonce を渡さない ID トークンでは nonce は None（require_login_nonce=off では検証しない）。
    assert verify_google_id_token(mint(), CLIENT_ID, verifier=verifier).nonce is None


# ── ルーム作成の許可リスト (ADR-0012 §3) ───────────────────────────────────────


def _user(email: str) -> AuthUser:
    return AuthUser(sub="s", email=email, email_verified=True, name="u")


def test_can_create_room_allows_everyone_when_list_empty(monkeypatch) -> None:
    monkeypatch.setattr(settings, "room_creator_allowlist", "", raising=True)
    monkeypatch.setattr(settings, "admin_emails", "", raising=True)
    assert can_create_room(_user("anyone@example.com")) is True


def test_can_create_room_matches_email(monkeypatch) -> None:
    monkeypatch.setattr(settings, "room_creator_allowlist", "ok@example.com", raising=True)
    monkeypatch.setattr(settings, "admin_emails", "", raising=True)
    assert can_create_room(_user("ok@example.com")) is True
    assert can_create_room(_user("no@example.com")) is False


def test_can_create_room_matches_domain(monkeypatch) -> None:
    monkeypatch.setattr(settings, "room_creator_allowlist", "leverages.jp", raising=True)
    monkeypatch.setattr(settings, "admin_emails", "", raising=True)
    assert can_create_room(_user("someone@leverages.jp")) is True
    assert can_create_room(_user("someone@gmail.com")) is False


def test_can_create_room_admin_always_allowed(monkeypatch) -> None:
    # allowlist に無くても admin は作成可（is_admin 経由）。
    monkeypatch.setattr(settings, "room_creator_allowlist", "other@example.com", raising=True)
    monkeypatch.setattr(settings, "admin_emails", "boss@example.com", raising=True)
    assert can_create_room(_user("boss@example.com")) is True
