from __future__ import annotations

import pytest

from sanba_external_agents.holmesgpt.contract import (
    a2a_agent_card_url,
    a2a_message_url,
    require_http_url,
    root_url,
)


def test_root_url_strips_trailing_slash():
    assert root_url("https://facade.example.com/") == "https://facade.example.com"


def test_agent_card_url():
    assert (
        a2a_agent_card_url("https://facade.example.com")
        == "https://facade.example.com/.well-known/agent-card.json"
    )


def test_message_url_includes_agent_id():
    assert (
        a2a_message_url("https://facade.example.com/", "sanba-sre-scout")
        == "https://facade.example.com/a2a/sanba-sre-scout"
    )


def test_require_http_url_accepts_https():
    assert require_http_url("https://facade.example.com") == "https://facade.example.com"


def test_require_http_url_rejects_file_scheme():
    with pytest.raises(ValueError):
        require_http_url("file:///etc/passwd")
