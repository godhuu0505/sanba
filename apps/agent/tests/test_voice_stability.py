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
        # 空文字・0 以下は「サーバ既定」= None で送る（明示的に上書きしない）。
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
        # 設定ミス（typo 等）で Gemini への接続自体が失敗しないこと（fail-safe）。
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
        # 考えながらの沈黙で発話が途中確定して分断されないよう、無音待ちを延長。
        assert settings.turn_end_sensitivity == "low"
        assert settings.turn_silence_duration_ms >= 1000

    def test_defaults_require_sustained_speech_to_start(self) -> None:
        # 一瞬の環境音・相槌の漏れで start が誤検出され発話が区切られないよう、
        # start-of-speech 確定に最低限の発話長を要求する。
        assert settings.turn_prefix_padding_ms >= 100

    def test_language_pinned_by_default(self) -> None:
        # 日本語固定が既定（認識ドリフト＝韓国語/中国語化の主対策）。
        assert settings.gemini_language == "ja-JP"

    def test_context_window_compression_enabled_by_default(self) -> None:
        assert settings.gemini_context_window_compression is True
        assert (
            settings.gemini_context_sliding_window_tokens < settings.gemini_context_trigger_tokens
        )

    def test_restart_budget_is_positive(self) -> None:
        assert settings.voice_session_max_restarts >= 1
        assert settings.voice_session_restart_backoff_s > 0


class TestBuildInputTranscription:
    def test_uses_configured_language_as_hint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 入力文字起こしに言語ヒントを与え、誤認識ドリフトを抑える。
        monkeypatch.setattr(settings, "gemini_language", "ja-JP")
        conf = build_input_transcription()
        assert conf.language_codes == ["ja-JP"]

    def test_empty_language_falls_back_to_auto_detect(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 空文字なら language_codes を付けず、モデルの自動判定に委ねる。
        monkeypatch.setattr(settings, "gemini_language", "")
        conf = build_input_transcription()
        assert conf.language_codes is None


class TestBuildRealtimeModel:
    def test_builds_with_turn_detection_and_compression(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # RealtimeModel は構築時に認証情報とモデル名/API の整合だけ検証する（接続はしない）。
        # 既定モデル gemini-live-2.5-flash-native-audio は VertexAI 系のため Vertex 側で構築する。
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
        # self-host / local は Cloud transport 前提を満たさない。
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
        # Live の generation_created タイムアウト等でも例外を伝播させず、会話は続行できる。
        from sanba_agent.main import guarded_generate_reply

        session = _FakeSession(raises=TimeoutError("generation_created timed out"))
        ok = await guarded_generate_reply(session, session_id="s1", kind="opening")
        assert ok is False
