"""Tools must degrade gracefully when Elasticsearch is not configured, so the
agent runs locally and in CI without a backend (and without network)."""

import os
from unittest import mock

from interviewer.config import get_config
from interviewer.tools import ground_question, search_past_sessions


def _clear_es_env():
    get_config.cache_clear()
    return mock.patch.dict(os.environ, {"ELASTICSEARCH_URL": ""}, clear=False)


def test_ground_question_without_backend():
    with _clear_es_env():
        result = ground_question("expense tool", "approval routing")
    assert result["status"] == "no_knowledge_base"
    assert result["snippets"] == []


def test_search_past_sessions_without_backend():
    with _clear_es_env():
        result = search_past_sessions("approval tools with SSO")
    assert result["status"] == "no_session_index"
    assert result["sessions"] == []
