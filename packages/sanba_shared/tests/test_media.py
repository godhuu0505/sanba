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
    # creds 未設定（use_vertexai=False, api_key 空）なら静かに空を返す。
    cfg = MediaConfig(use_vertexai=False, google_api_key="")
    assert analyze_image(b"x", "image/png", cfg) == []
    result = analyze_video(cfg, gcs_uri="gs://b/o.mp4")
    assert isinstance(result, VideoAnalysis) and result.extracted == 0


def test_analyze_video_requires_source() -> None:
    cfg = MediaConfig(use_vertexai=True)
    try:
        analyze_video(cfg)
    except ValueError:
        return
    raise AssertionError("expected ValueError when neither gcs_uri nor raw is given")
