"""音声ターン検出のチューニングとセッション安定化のテスト。

`build_turn_detection` が env 設定を Gemini の自動 VAD 設定へ正しく写像すること
（発話途中の被せ発話対策）、`resume_instructions` が再起動後の再開文脈を組み立てる
こと、`build_realtime_model` が安定化設定（context window compression）込みで
モデルを構築できることを、LiveKit ランタイム無しで検証する。
"""

from __future__ import annotations

import pytest
from google.genai import types as genai_types

from sanba_agent.config import settings
from sanba_agent.main import (
    _is_livekit_cloud_url,
    build_input_transcription,
    build_noise_cancellation,
    build_realtime_model,
    build_stt,
    build_turn_detection,
    resume_instructions,
)


class TestBuildTurnDetection:
    def test_maps_sensitivities_and_durations(self) -> None:
        conf = build_turn_detection(
            silence_duration_ms=800,
            end_sensitivity="low",
            start_sensitivity="high",
            prefix_padding_ms=300,
        )
        aad = conf.automatic_activity_detection
        assert aad is not None
        assert aad.disabled is False
        assert aad.end_of_speech_sensitivity is genai_types.EndSensitivity.END_SENSITIVITY_LOW
        assert (
            aad.start_of_speech_sensitivity is genai_types.StartSensitivity.START_SENSITIVITY_HIGH
        )
        assert aad.silence_duration_ms == 800
        assert aad.prefix_padding_ms == 300

    def test_empty_and_nonpositive_fall_back_to_server_defaults(self) -> None:
        conf = build_turn_detection(
            silence_duration_ms=0,
            end_sensitivity="",
            start_sensitivity="",
            prefix_padding_ms=0,
        )
        aad = conf.automatic_activity_detection
        assert aad is not None
        assert aad.end_of_speech_sensitivity is None
        assert aad.start_of_speech_sensitivity is None
        assert aad.silence_duration_ms is None
        assert aad.prefix_padding_ms is None

    def test_unknown_sensitivity_falls_back_instead_of_raising(self) -> None:
        conf = build_turn_detection(
            silence_duration_ms=800,
            end_sensitivity="medium",
            start_sensitivity="LOUD",
            prefix_padding_ms=0,
        )
        aad = conf.automatic_activity_detection
        assert aad is not None
        assert aad.end_of_speech_sensitivity is None
        assert aad.start_of_speech_sensitivity is None

    def test_sensitivity_is_case_insensitive(self) -> None:
        conf = build_turn_detection(
            silence_duration_ms=800,
            end_sensitivity=" LOW ",
            start_sensitivity="Low",
            prefix_padding_ms=0,
        )
        aad = conf.automatic_activity_detection
        assert aad is not None
        assert aad.end_of_speech_sensitivity is genai_types.EndSensitivity.END_SENSITIVITY_LOW
        assert aad.start_of_speech_sensitivity is genai_types.StartSensitivity.START_SENSITIVITY_LOW


class TestDefaultSettings:
    def test_defaults_wait_for_user_to_finish(self) -> None:
        assert settings.turn_end_sensitivity == "low"
        assert settings.turn_silence_duration_ms >= 1000

    def test_defaults_require_sustained_speech_to_start(self) -> None:
        assert settings.turn_prefix_padding_ms >= 100
        assert settings.turn_start_sensitivity == "low"

    def test_language_pinned_by_default(self) -> None:
        assert settings.gemini_language == "ja-JP"

    def test_context_window_compression_enabled_by_default(self) -> None:
        assert settings.gemini_context_window_compression is True
        assert (
            settings.gemini_context_sliding_window_tokens < settings.gemini_context_trigger_tokens
        )

    def test_restart_budget_is_positive(self) -> None:
        assert settings.voice_session_max_restarts >= 1
        assert settings.voice_session_restart_backoff_s > 0

    def test_analysis_timeouts_protect_the_voice_turn(self) -> None:
        assert settings.analysis_ride_along_timeout_seconds <= 10
        assert settings.analysis_ride_along_timeout_seconds <= settings.analysis_timeout_seconds


class TestBuildInputTranscription:
    def test_uses_configured_language_as_hint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "separate_stt_enabled", False)
        monkeypatch.setattr(settings, "gemini_language", "ja-JP")
        conf = build_input_transcription()
        assert conf is not None
        assert conf.language_codes == ["ja-JP"]

    def test_empty_language_falls_back_to_auto_detect(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "separate_stt_enabled", False)
        monkeypatch.setattr(settings, "gemini_language", "")
        conf = build_input_transcription()
        assert conf is not None
        assert conf.language_codes is None

    def test_returns_config_regardless_of_separate_stt_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "separate_stt_enabled", True)
        monkeypatch.setattr(settings, "gemini_language", "ja-JP")
        conf = build_input_transcription()
        assert conf is not None
        assert conf.language_codes == ["ja-JP"]


class TestBuildStt:
    def test_disabled_by_default(self) -> None:
        assert settings.separate_stt_enabled is False

    def test_none_when_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "separate_stt_enabled", False)
        assert build_stt() is None

    def test_created_with_configured_model_and_language_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "separate_stt_enabled", True)
        monkeypatch.setattr(settings, "stt_model", "chirp_2")
        monkeypatch.setattr(settings, "gemini_language", "ja-JP")
        captured: dict[str, object] = {}

        def fake_stt(**kwargs: object) -> str:
            captured.update(kwargs)
            return "stt-instance"

        monkeypatch.setattr("sanba_agent.main.google.STT", fake_stt)
        assert build_stt() == "stt-instance"
        assert captured["model"] == "chirp_2"
        assert captured["languages"] == ["ja-JP"]
        assert captured["location"] == settings.stt_location
        assert captured["detect_language"] is False

    def test_fails_soft_to_none_when_construction_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "separate_stt_enabled", True)

        def boom(**_: object) -> object:
            raise RuntimeError("unsupported location for chirp")

        monkeypatch.setattr("sanba_agent.main.google.STT", boom)
        assert build_stt() is None


class TestBuildRealtimeModel:
    def test_builds_with_turn_detection_and_compression(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test-project")
        monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
        model = build_realtime_model()
        opts = model._opts
        aad = opts.realtime_input_config.automatic_activity_detection
        assert aad is not None
        assert aad.end_of_speech_sensitivity is genai_types.EndSensitivity.END_SENSITIVITY_LOW
        assert aad.silence_duration_ms == settings.turn_silence_duration_ms
        assert (
            opts.context_window_compression.trigger_tokens == settings.gemini_context_trigger_tokens
        )

    def test_pins_language_and_input_transcription(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test-project")
        monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
        monkeypatch.setattr(settings, "gemini_language", "ja-JP")
        opts = build_realtime_model()._opts
        assert str(opts.language) == "ja-JP"
        assert opts.input_audio_transcription is not None
        assert opts.input_audio_transcription.language_codes == ["ja-JP"]

    def test_native_transcription_disabled_omits_input_transcription(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test-project")
        monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
        opts = build_realtime_model(native_transcription=False)._opts
        assert opts.input_audio_transcription is None


class TestResumeInstructions:
    def test_includes_transcript_tail_only(self) -> None:
        transcript = [f"[u{i}] participant: 発話{i}" for i in range(1, 21)]
        text = resume_instructions(transcript, tail=10)
        assert "発話20" in text
        assert "発話11" in text
        assert "発話10" not in text
        assert "復旧" in text

    def test_empty_transcript_still_produces_instructions(self) -> None:
        text = resume_instructions([])
        assert "復旧" in text
        assert "まだ発話はありません" in text


class TestNoiseCancellation:
    def test_livekit_cloud_url_detection(self) -> None:
        assert _is_livekit_cloud_url("wss://my-proj.livekit.cloud")
        assert _is_livekit_cloud_url("wss://livekit.cloud")
        assert not _is_livekit_cloud_url("ws://localhost:7880")
        assert not _is_livekit_cloud_url("wss://livekit.example.com")
        assert not _is_livekit_cloud_url("")

    def test_disabled_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "noise_cancellation_enabled", False)
        assert build_noise_cancellation() is None

    def test_self_host_disables_bvc(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "noise_cancellation_enabled", True)
        monkeypatch.setattr(settings, "livekit_url", "ws://localhost:7880")
        assert build_noise_cancellation() is None


class _FakeSession:
    """generate_reply だけを持つ最小の AgentSession スタブ（観測性ヘルパのテスト用）。"""

    def __init__(self, *, raises: BaseException | None = None) -> None:
        self.calls: list[dict[str, object]] = []
        self._raises = raises

    async def generate_reply(self, **kwargs: object) -> None:
        self.calls.append(kwargs)
        if self._raises is not None:
            raise self._raises


class TestGuardedGenerateReply:
    @pytest.mark.asyncio
    async def test_success_returns_true_and_forwards_kwargs(self) -> None:
        from sanba_agent.main import guarded_generate_reply

        session = _FakeSession()
        ok = await guarded_generate_reply(
            session, session_id="s1", kind="opening", instructions="はじめまして"
        )
        assert ok is True
        assert session.calls == [{"instructions": "はじめまして"}]

    @pytest.mark.asyncio
    async def test_failure_is_swallowed_and_returns_false(self) -> None:
        from sanba_agent.main import guarded_generate_reply

        session = _FakeSession(raises=TimeoutError("generation_created timed out"))
        ok = await guarded_generate_reply(session, session_id="s1", kind="opening")
        assert ok is False


class TestSelectExporterKind:
    def test_otlp_endpoint_takes_precedence(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from sanba_agent.observability import select_exporter_kind

        monkeypatch.setattr(settings, "otel_exporter_otlp_endpoint", "http://collector:4317")
        monkeypatch.setattr(settings, "google_genai_use_vertexai", True)
        assert select_exporter_kind() == "otlp"

    def test_cloud_trace_when_vertex_and_no_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from sanba_agent.observability import select_exporter_kind

        monkeypatch.setattr(settings, "otel_exporter_otlp_endpoint", "")
        monkeypatch.setattr(settings, "otel_traces_to_cloud_trace", True)
        monkeypatch.setattr(settings, "google_genai_use_vertexai", True)
        assert select_exporter_kind() == "cloud_trace"

    def test_disabled_locally_without_vertex(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from sanba_agent.observability import select_exporter_kind

        monkeypatch.setattr(settings, "otel_exporter_otlp_endpoint", "")
        monkeypatch.setattr(settings, "google_genai_use_vertexai", False)
        assert select_exporter_kind() == "disabled"

    def test_cloud_trace_can_be_disabled_by_flag(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from sanba_agent.observability import select_exporter_kind

        monkeypatch.setattr(settings, "otel_exporter_otlp_endpoint", "")
        monkeypatch.setattr(settings, "otel_traces_to_cloud_trace", False)
        monkeypatch.setattr(settings, "google_genai_use_vertexai", True)
        assert select_exporter_kind() == "disabled"


class _OpeningFakeSession:
    """開始一言の復旧テスト用スタブ。指定した試行回目で assistant 応答(reply_tracker)を再現する。"""

    def __init__(self, *, reply_tracker: object, succeed_on_attempt: int | None) -> None:
        self._reply_tracker = reply_tracker
        self._succeed_on = succeed_on_attempt
        self.reply_calls = 0
        self.interrupts = 0

    async def generate_reply(self, **kwargs: object) -> None:
        self.reply_calls += 1
        if self._succeed_on is not None and self.reply_calls >= self._succeed_on:
            self._reply_tracker.bump()  # type: ignore[attr-defined]

    async def interrupt(self) -> None:
        self.interrupts += 1


class TestOpenInterview:
    @pytest.mark.asyncio
    async def test_succeeds_on_first_attempt(self) -> None:
        from sanba_agent.main import _ReplyTracker, open_interview

        tracker = _ReplyTracker()
        session = _OpeningFakeSession(reply_tracker=tracker, succeed_on_attempt=1)
        ok = await open_interview(
            session,
            session_id="s1",
            instructions="どうも",
            reply_tracker=tracker,
            max_attempts=3,
            reply_timeout_s=0.05,
        )
        assert ok is True
        assert session.reply_calls == 1
        assert session.interrupts == 0

    @pytest.mark.asyncio
    async def test_recovers_on_retry(self) -> None:
        from sanba_agent.main import _ReplyTracker, open_interview

        tracker = _ReplyTracker()
        session = _OpeningFakeSession(reply_tracker=tracker, succeed_on_attempt=2)
        ok = await open_interview(
            session,
            session_id="s1",
            instructions="どうも",
            reply_tracker=tracker,
            max_attempts=3,
            reply_timeout_s=0.05,
        )
        assert ok is True
        assert session.reply_calls == 2
        assert session.interrupts == 1

    @pytest.mark.asyncio
    async def test_gives_up_after_max_attempts_and_interrupts_on_last(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        from sanba_agent.main import _ReplyTracker, open_interview

        tracker = _ReplyTracker()
        session = _OpeningFakeSession(reply_tracker=tracker, succeed_on_attempt=None)
        ok = await open_interview(
            session,
            session_id="s1",
            instructions="どうも",
            reply_tracker=tracker,
            max_attempts=3,
            reply_timeout_s=0.05,
        )
        assert ok is False
        assert session.reply_calls == 3
        assert session.interrupts == 3
        captured = capsys.readouterr()
        assert "voice_opening_exhausted" in captured.out


class TestReplyTracker:
    @pytest.mark.asyncio
    async def test_wait_beyond_returns_when_reply_arrives(self) -> None:
        from sanba_agent.main import _ReplyTracker

        tracker = _ReplyTracker()
        baseline = tracker.count
        tracker.bump()
        await tracker.wait_beyond(baseline, timeout_s=0.05)

    @pytest.mark.asyncio
    async def test_wait_beyond_times_out_without_reply(self) -> None:
        from sanba_agent.main import _ReplyTracker

        tracker = _ReplyTracker()
        with pytest.raises(TimeoutError):
            await tracker.wait_beyond(tracker.count, timeout_s=0.05)

    @pytest.mark.asyncio
    async def test_wait_beyond_is_per_turn_monotonic(self) -> None:
        """先行ターンの応答は後続ターンの baseline を満たさない（連投 race の解消）。"""
        from sanba_agent.main import _ReplyTracker

        tracker = _ReplyTracker()
        tracker.bump()
        second_baseline = tracker.count
        with pytest.raises(TimeoutError):
            await tracker.wait_beyond(second_baseline, timeout_s=0.05)


class _WatchdogFakeSession:
    """guarded_turn_reply 検証用スタブ。generate_reply で応答到着や失敗を再現する。"""

    def __init__(self, *, bump: object | None = None, raises: BaseException | None = None) -> None:
        self._bump = bump
        self._raises = raises
        self.reply_calls = 0

    async def generate_reply(self, **kwargs: object) -> None:
        self.reply_calls += 1
        if self._raises is not None:
            raise self._raises
        if self._bump is not None:
            self._bump.bump()  # type: ignore[attr-defined]


class TestGuardedTurnReply:
    @pytest.mark.asyncio
    async def test_returns_true_when_reply_observed(self) -> None:
        from sanba_agent.main import _ReplyTracker, guarded_turn_reply

        tracker = _ReplyTracker()
        session = _WatchdogFakeSession(bump=tracker)
        pending: list[str] = []
        restarts: list[int] = []
        ok = await guarded_turn_reply(
            session,  # type: ignore[arg-type]
            session_id="s1",
            kind="user_text",
            reply_tracker=tracker,
            timeout_s=1.0,
            reinject="動画観察",
            pending_reinject=pending,
            request_restart=lambda: restarts.append(1),
            user_input="x",
        )
        assert ok is True
        assert pending == []
        assert restarts == []

    @pytest.mark.asyncio
    async def test_restarts_and_stashes_reinject_on_timeout(self) -> None:
        from sanba_agent.main import _ReplyTracker, guarded_turn_reply

        tracker = _ReplyTracker()
        session = _WatchdogFakeSession()
        pending: list[str] = []
        restarts: list[int] = []
        ok = await guarded_turn_reply(
            session,  # type: ignore[arg-type]
            session_id="s1",
            kind="video_analysis",
            reply_tracker=tracker,
            timeout_s=0.05,
            reinject="動画観察の再投入",
            pending_reinject=pending,
            request_restart=lambda: restarts.append(1),
            instructions="y",
        )
        assert ok is False
        assert pending == ["動画観察の再投入"]
        assert restarts == [1]

    @pytest.mark.asyncio
    async def test_timeout_without_reinject_restarts_without_stash(self) -> None:
        from sanba_agent.main import _ReplyTracker, guarded_turn_reply

        tracker = _ReplyTracker()
        session = _WatchdogFakeSession()
        pending: list[str] = []
        restarts: list[int] = []
        ok = await guarded_turn_reply(
            session,  # type: ignore[arg-type]
            session_id="s1",
            kind="user_text",
            reply_tracker=tracker,
            timeout_s=0.05,
            reinject=None,
            pending_reinject=pending,
            request_restart=lambda: restarts.append(1),
            user_input="x",
        )
        assert ok is False
        assert pending == []
        assert restarts == [1]

    @pytest.mark.asyncio
    async def test_generate_reply_exception_triggers_restart(self) -> None:
        """generate_reply が例外で落ちても（guarded 側で握る）無応答として再起動する。"""
        from sanba_agent.main import _ReplyTracker, guarded_turn_reply

        tracker = _ReplyTracker()
        session = _WatchdogFakeSession(raises=RuntimeError("room closed"))
        pending: list[str] = []
        restarts: list[int] = []
        ok = await guarded_turn_reply(
            session,  # type: ignore[arg-type]
            session_id="s1",
            kind="answer",
            reply_tracker=tracker,
            timeout_s=1.0,
            reinject="再投入",
            pending_reinject=pending,
            request_restart=lambda: restarts.append(1),
            instructions="z",
        )
        assert ok is False
        assert pending == ["再投入"]
        assert restarts == [1]


class TestBuildResumeInstructions:
    def test_appends_pending_reinject(self) -> None:
        from sanba_agent.main import build_resume_instructions

        text = build_resume_instructions(["[u1] participant: A"], ["動画観察の再投入"])
        assert "復旧" in text
        assert "動画観察の再投入" in text

    def test_no_reinject_is_plain_resume(self) -> None:
        from sanba_agent.main import build_resume_instructions, resume_instructions

        assert build_resume_instructions([], []) == resume_instructions([])
