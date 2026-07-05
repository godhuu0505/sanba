"""音声ターン検出のチューニングとセッション安定化（ADR-0036）のテスト。

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
        # 既定値が「待ち長め」に倒れていること（発話途中の被せ発話対策の本丸）。
        assert settings.turn_end_sensitivity == "low"
        assert settings.turn_silence_duration_ms >= 500

    def test_context_window_compression_enabled_by_default(self) -> None:
        # 長時間セッションがコンテキスト上限で打ち切られない既定であること。
        assert settings.gemini_context_window_compression is True
        assert (
            settings.gemini_context_sliding_window_tokens < settings.gemini_context_trigger_tokens
        )

    def test_restart_budget_is_positive(self) -> None:
        assert settings.voice_session_max_restarts >= 1
        assert settings.voice_session_restart_backoff_s > 0


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


class TestResumeInstructions:
    def test_includes_transcript_tail_only(self) -> None:
        transcript = [f"[u{i}] participant: 発話{i}" for i in range(1, 21)]
        text = resume_instructions(transcript, tail=10)
        assert "発話20" in text
        assert "発話11" in text
        assert "発話10" not in text  # 末尾 10 件より古い発話は含めない
        assert "復旧" in text

    def test_empty_transcript_still_produces_instructions(self) -> None:
        text = resume_instructions([])
        assert "復旧" in text
        assert "まだ発話はありません" in text
