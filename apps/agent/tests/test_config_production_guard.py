from __future__ import annotations

import pytest
from pydantic import ValidationError

from sanba_agent.config import (
    INSECURE_LIVEKIT_KEY_DEFAULT,
    INSECURE_LIVEKIT_SECRET_DEFAULT,
    Settings,
)


def test_development_allows_insecure_livekit_defaults() -> None:
    settings = Settings(
        environment="development",
        livekit_api_key=INSECURE_LIVEKIT_KEY_DEFAULT,
        livekit_api_secret=INSECURE_LIVEKIT_SECRET_DEFAULT,
    )
    assert settings.is_production is False


def test_production_with_secure_livekit_ok() -> None:
    settings = Settings(
        environment="production",
        livekit_api_key="prod-key",
        livekit_api_secret="prod-secret",
    )
    assert settings.is_production is True


def test_production_rejects_default_livekit_credentials() -> None:
    with pytest.raises(ValidationError, match="LIVEKIT_API_KEY"):
        Settings(
            environment="production",
            livekit_api_key=INSECURE_LIVEKIT_KEY_DEFAULT,
            livekit_api_secret=INSECURE_LIVEKIT_SECRET_DEFAULT,
        )
