from types import SimpleNamespace

import pytest

from sanba_shared.analytics import (
    COMPONENT_LIVE_AUDIO,
    EVENT_AI_USAGE,
    EVENT_SESSION_SUMMARY,
    TokenUsage,
    UsageRecorder,
    build_ai_usage_payload,
    build_event,
    build_session_summary_payload,
    estimate_livekit_usd,
    estimate_usd,
    estimated_embedding_tokens,
    normalize_model,
    usage_delta,
    usage_from_genai,
    usage_from_model_usage,
    usd_to_jpy,
    vertex_billing_labels,
)
from sanba_shared.analytics_sink import AnalyticsConfig, AnalyticsSink


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def emit(self, event: dict) -> None:
        self.events.append(event)


class ExplodingSink:
    def emit(self, event: dict) -> None:
        raise RuntimeError("boom")


def test_normalize_model_strips_prefix_and_case() -> None:
    assert normalize_model("models/Gemini-2.5-Flash") == "gemini-2.5-flash"


def test_estimate_usd_live_audio_dominated() -> None:
    usage = TokenUsage(
        input_tokens=1_000_000,
        input_text_tokens=200_000,
        input_audio_tokens=800_000,
        output_tokens=500_000,
        output_text_tokens=100_000,
        output_audio_tokens=400_000,
    )
    usd = estimate_usd("gemini-live-2.5-flash-native-audio", usage)
    assert usd == pytest.approx(0.2 * 0.5 + 0.8 * 3.0 + 0.1 * 2.0 + 0.4 * 12.0)


def test_estimate_usd_unclassified_tokens_priced_as_text() -> None:
    usage = TokenUsage(input_tokens=1_000_000, output_tokens=1_000_000)
    usd = estimate_usd("gemini-2.5-flash", usage)
    assert usd == pytest.approx(0.30 + 2.50)


def test_estimate_usd_unknown_model_returns_none() -> None:
    assert estimate_usd("unknown-model", TokenUsage(input_tokens=10)) is None


def test_usd_to_jpy_rounds() -> None:
    assert usd_to_jpy(1.5, 150.0) == 225.0


def test_usage_from_genai_maps_modalities_and_thoughts() -> None:
    metadata = SimpleNamespace(
        prompt_token_count=100,
        tool_use_prompt_token_count=10,
        candidates_token_count=50,
        thoughts_token_count=30,
        cached_content_token_count=5,
        prompt_tokens_details=[
            SimpleNamespace(modality=SimpleNamespace(value="TEXT"), token_count=60),
            SimpleNamespace(modality=SimpleNamespace(value="IMAGE"), token_count=25),
            SimpleNamespace(modality=SimpleNamespace(value="VIDEO"), token_count=15),
        ],
        tool_use_prompt_tokens_details=None,
        candidates_tokens_details=[
            SimpleNamespace(modality=SimpleNamespace(value="TEXT"), token_count=50),
        ],
    )
    usage = usage_from_genai(metadata)
    assert usage.input_tokens == 110
    assert usage.input_text_tokens == 60
    assert usage.input_image_tokens == 40
    assert usage.input_cached_tokens == 5
    assert usage.output_tokens == 80
    assert usage.output_text_tokens == 80


def test_usage_from_genai_none_is_empty() -> None:
    assert usage_from_genai(None).is_empty


def test_usage_from_model_usage_reads_llm_fields() -> None:
    model_usage = SimpleNamespace(
        input_tokens=100,
        input_text_tokens=20,
        input_audio_tokens=80,
        input_image_tokens=0,
        input_cached_tokens=10,
        output_tokens=60,
        output_text_tokens=15,
        output_audio_tokens=45,
    )
    usage = usage_from_model_usage(model_usage)
    assert usage.input_audio_tokens == 80
    assert usage.output_audio_tokens == 45


def test_usage_delta_and_reset_detection() -> None:
    first = TokenUsage(input_tokens=100, output_tokens=50)
    second = TokenUsage(input_tokens=150, output_tokens=70)
    delta = usage_delta(second, first)
    assert delta is not None
    assert delta.input_tokens == 50
    assert delta.output_tokens == 20
    assert usage_delta(first, second) is None


def test_estimated_embedding_tokens() -> None:
    assert estimated_embedding_tokens("") == 0
    assert estimated_embedding_tokens("abcd" * 10) == 10
    assert estimated_embedding_tokens("ab") == 1


def test_vertex_billing_labels_gated_and_sanitized() -> None:
    assert vertex_billing_labels("sess-1", "prod-1", use_vertexai=False) is None
    labels = vertex_billing_labels("Sess-ABC 123", "Prod/X", use_vertexai=True)
    assert labels == {"session_id": "sess-abc-123", "product_id": "prod-x"}


def test_build_ai_usage_payload_marks_unknown_pricing() -> None:
    payload = build_ai_usage_payload(
        component="judge", model="mystery", usage=TokenUsage(input_tokens=10)
    )
    assert payload["estimated_usd"] == 0.0
    assert payload["pricing_known"] is False


def test_build_session_summary_payload_totals_and_efficiency() -> None:
    payload = build_session_summary_payload(
        components={
            "live_audio": {"usd": 1.0, "input_tokens": 10, "output_tokens": 5, "requests": 3},
            "judge": {"usd": 0.5, "input_tokens": 4, "output_tokens": 2, "requests": 1},
        },
        livekit={"estimated_usd": 0.5},
        kpi={"finalized_count": 4, "inquiry": {"resolved_total": 8}},
        usd_jpy_rate=150.0,
    )
    assert payload["ai_usd"] == pytest.approx(1.5)
    assert payload["total_usd"] == pytest.approx(2.0)
    assert payload["total_jpy"] == pytest.approx(300.0)
    assert payload["efficiency"]["usd_per_finalized_requirement"] == pytest.approx(0.5)
    assert payload["efficiency"]["usd_per_resolved_inquiry"] == pytest.approx(0.25)


def test_build_session_summary_payload_skips_efficiency_without_denominator() -> None:
    payload = build_session_summary_payload(
        components={}, livekit=None, kpi={"finalized_count": 0}, usd_jpy_rate=150.0
    )
    assert payload["efficiency"] == {}
    assert payload["livekit"] is None


def test_estimate_livekit_usd_breakdown() -> None:
    estimate = estimate_livekit_usd(30.0, participants=2, noise_cancellation=True)
    assert estimate["connection_usd"] == pytest.approx(30 * 2 * 0.0005)
    assert estimate["agent_session_usd"] == pytest.approx(30 * 0.01)
    assert estimate["noise_cancellation_usd"] == pytest.approx(30 * 0.005)
    assert estimate["estimated_usd"] == pytest.approx(0.03 + 0.3 + 0.15)
    without_krisp = estimate_livekit_usd(30.0, noise_cancellation=False)
    assert without_krisp["noise_cancellation_usd"] == 0.0


def test_usage_recorder_emits_envelope_and_on_record() -> None:
    sink = RecordingSink()
    recorded: list[tuple[str, dict]] = []
    recorder = UsageRecorder(
        sink,
        "sess-1",
        product_id="prod-1",
        interview_mode="developer",
        on_record=lambda component, payload: recorded.append((component, payload)),
    )
    recorder.record("judge", "gemini-2.5-flash", TokenUsage(input_tokens=100, output_tokens=10))
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event["event_type"] == EVENT_AI_USAGE
    assert event["session_id"] == "sess-1"
    assert event["product_id"] == "prod-1"
    assert event["interview_mode"] == "developer"
    assert event["payload"]["component"] == "judge"
    assert recorded[0][0] == "judge"


def test_usage_recorder_skips_empty_and_survives_sink_failure() -> None:
    sink = RecordingSink()
    recorder = UsageRecorder(sink, "sess-1")
    recorder.record("judge", "gemini-2.5-flash", TokenUsage())
    assert sink.events == []
    exploding = UsageRecorder(ExplodingSink(), "sess-1")
    exploding.record("judge", "gemini-2.5-flash", TokenUsage(input_tokens=1))


def test_usage_recorder_set_context_late_binding() -> None:
    sink = RecordingSink()
    recorder = UsageRecorder(sink, "sess-1")
    recorder.set_context(product_id="prod-9", interview_mode="end_user")
    recorder.record("embedding", "gemini-embedding-001", TokenUsage(input_tokens=8))
    assert sink.events[0]["product_id"] == "prod-9"
    assert sink.events[0]["interview_mode"] == "end_user"


def test_analytics_sink_memory_mode_accumulates_and_flushes() -> None:
    sink = AnalyticsSink(AnalyticsConfig())
    assert sink.is_memory
    event = build_event(
        event_type=EVENT_AI_USAGE,
        session_id="sess-1",
        product_id=None,
        interview_mode=None,
        payload=build_ai_usage_payload(
            component=COMPONENT_LIVE_AUDIO,
            model="gemini-live-2.5-flash-native-audio",
            usage=TokenUsage(input_tokens=100, input_audio_tokens=100, output_tokens=10),
        ),
    )
    sink.emit(event)
    sink.emit(event)
    sink.flush()
    totals = sink.totals()
    assert totals[COMPONENT_LIVE_AUDIO]["requests"] == 2
    assert totals[COMPONENT_LIVE_AUDIO]["input_tokens"] == 200
    assert totals[COMPONENT_LIVE_AUDIO]["usd"] > 0
    assert len(sink._mem) == 2
    assert sink._mem[0]["@timestamp"] == sink._mem[0]["occurred_at"]


def test_analytics_sink_session_summary_not_in_totals() -> None:
    sink = AnalyticsSink()
    sink.emit(
        build_event(
            event_type=EVENT_SESSION_SUMMARY,
            session_id="sess-1",
            product_id=None,
            interview_mode=None,
            payload=build_session_summary_payload(
                components={}, livekit=None, kpi={}, usd_jpy_rate=150.0
            ),
        )
    )
    sink.flush()
    assert sink.totals() == {}
    assert len(sink._mem) == 1
