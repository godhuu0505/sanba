from __future__ import annotations

import pytest
from pydantic import ValidationError

from sanba_api.config import (
    INSECURE_LIVEKIT_KEY_DEFAULT,
    INSECURE_LIVEKIT_SECRET_DEFAULT,
    INSECURE_SIGNING_SECRET_DEFAULT,
    Settings,
)

_SECURE = {
    "session_signing_secret": "a-strong-random-production-secret",
    "livekit_api_key": "prod-key",
    "livekit_api_secret": "prod-secret",
}


def test_development_allows_insecure_defaults() -> None:
    settings = Settings(
        environment="development",
        session_signing_secret=INSECURE_SIGNING_SECRET_DEFAULT,
        livekit_api_key=INSECURE_LIVEKIT_KEY_DEFAULT,
        livekit_api_secret=INSECURE_LIVEKIT_SECRET_DEFAULT,
        auth_dev_bypass=True,
        local_direct_dispatch=True,
    )
    assert settings.is_production is False


def test_production_with_secure_values_ok() -> None:
    settings = Settings(environment="production", **_SECURE)
    assert settings.is_production is True


def test_production_rejects_default_signing_secret() -> None:
    with pytest.raises(ValidationError, match="SESSION_SIGNING_SECRET"):
        Settings(
            environment="production",
            session_signing_secret=INSECURE_SIGNING_SECRET_DEFAULT,
            livekit_api_key="prod-key",
            livekit_api_secret="prod-secret",
        )


def test_production_rejects_default_livekit_credentials() -> None:
    with pytest.raises(ValidationError, match="LIVEKIT_API_KEY"):
        Settings(
            environment="production",
            session_signing_secret="a-strong-random-production-secret",
            livekit_api_key=INSECURE_LIVEKIT_KEY_DEFAULT,
            livekit_api_secret=INSECURE_LIVEKIT_SECRET_DEFAULT,
        )


def test_production_rejects_auth_dev_bypass() -> None:
    with pytest.raises(ValidationError, match="AUTH_DEV_BYPASS"):
        Settings(environment="production", auth_dev_bypass=True, **_SECURE)


def test_production_rejects_local_direct_dispatch() -> None:
    with pytest.raises(ValidationError, match="LOCAL_DIRECT_DISPATCH"):
        Settings(environment="production", local_direct_dispatch=True, **_SECURE)
