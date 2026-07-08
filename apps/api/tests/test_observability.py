"""Unit tests for api exporter selection (純関数・ネットワーク不要 / ADR-0051)。"""

from __future__ import annotations

import pytest

from sanba_api import observability


@pytest.fixture(autouse=True)
def _reset_otel_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(observability.settings, "otel_exporter_otlp_endpoint", "", raising=False)
    monkeypatch.setattr(observability.settings, "otel_traces_to_cloud_trace", True, raising=False)
    monkeypatch.setattr(observability.settings, "google_genai_use_vertexai", False, raising=False)


def test_otlp_endpoint_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        observability.settings, "otel_exporter_otlp_endpoint", "http://collector:4317"
    )
    monkeypatch.setattr(observability.settings, "google_genai_use_vertexai", True)
    assert observability.select_exporter_kind() == "otlp"


def test_cloud_trace_on_vertex(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(observability.settings, "google_genai_use_vertexai", True)
    assert observability.select_exporter_kind() == "cloud_trace"


def test_disabled_when_local(monkeypatch: pytest.MonkeyPatch) -> None:
    assert observability.select_exporter_kind() == "disabled"


def test_disabled_when_cloud_trace_flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(observability.settings, "google_genai_use_vertexai", True)
    monkeypatch.setattr(observability.settings, "otel_traces_to_cloud_trace", False)
    assert observability.select_exporter_kind() == "disabled"
