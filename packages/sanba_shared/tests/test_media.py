"""Tests for multimodal analysis output shaping (ADR-0040)."""

from __future__ import annotations

from sanba_shared.media import (
    MediaConfig,
    VideoAnalysis,
    analyze_image,
    analyze_video,
    parse_observations,
)


def test_parse_observations_strips_markers_keeps_timestamps() -> None:
    text = (
        "- [00:01] ログイン画面\n* [00:05] 保存ボタン\n1. [00:10] エラー表示\n\n   \n・[00:12] 一覧"
    )
    obs = parse_observations(text, limit=20)
    assert obs == [
        "[00:01] ログイン画面",
        "[00:05] 保存ボタン",
        "[00:10] エラー表示",
        "[00:12] 一覧",
    ]


def test_parse_observations_respects_limit() -> None:
    text = "\n".join(f"- 行{i}" for i in range(30))
    assert len(parse_observations(text, limit=8)) == 8


def test_analyze_returns_empty_without_creds() -> None:
    cfg = MediaConfig(use_vertexai=False, google_api_key="")
    assert analyze_image(b"x", "image/png", cfg) == []
    result = analyze_video(cfg, gcs_uri="gs://b/o.mp4")
    assert isinstance(result, VideoAnalysis) and result.extracted == 0


def test_analyze_image_keeps_client_alive_during_call(monkeypatch) -> None:
    import gc
    import weakref

    import sanba_shared.media as media

    state = {"collected": False}

    class _Resp:
        text = "- 観察A\n- 観察B"

    class _Models:
        def generate_content(self, **kwargs: object) -> _Resp:
            gc.collect()
            assert not state["collected"], "genai client was GC'd mid-call (use-after-close 回帰)"
            return _Resp()

    class _Client:
        def __init__(self) -> None:
            self.models = _Models()

    def _make(config: MediaConfig) -> _Client:
        client = _Client()
        weakref.finalize(client, lambda: state.__setitem__("collected", True))
        return client

    monkeypatch.setattr(media, "_client", _make)
    cfg = MediaConfig(use_vertexai=True)
    assert analyze_image(b"x", "image/png", cfg) == ["観察A", "観察B"]


def test_analyze_video_keeps_client_alive_during_call(monkeypatch) -> None:
    import gc
    import weakref

    import sanba_shared.media as media

    state = {"collected": False}

    class _Resp:
        text = "- [00:01] 観察A"

    class _Models:
        def generate_content(self, **kwargs: object) -> _Resp:
            gc.collect()
            assert not state["collected"], "genai client was GC'd mid-call (use-after-close 回帰)"
            return _Resp()

    class _Client:
        def __init__(self) -> None:
            self.models = _Models()

    def _make(config: MediaConfig) -> _Client:
        client = _Client()
        weakref.finalize(client, lambda: state.__setitem__("collected", True))
        return client

    monkeypatch.setattr(media, "_client", _make)
    cfg = MediaConfig(use_vertexai=True)
    result = analyze_video(cfg, gcs_uri="gs://b/o.mp4")
    assert result.observations == ["[00:01] 観察A"]


def test_analyze_video_requires_source() -> None:
    cfg = MediaConfig(use_vertexai=True)
    try:
        analyze_video(cfg)
    except ValueError:
        return
    raise AssertionError("expected ValueError when neither gcs_uri nor raw is given")
