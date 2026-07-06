"""Unit tests for the video analysis task logic (ADR-0040).

副作用（GCS 取得・Gemini 解析）を差し込みで置き換え、冪等・破棄競合・上限・失敗の分岐を
GCP 無しで検証する。
"""

from __future__ import annotations

from sanba_shared.grounding import ContextIndexer
from sanba_shared.media import VideoAnalysis
from sanba_shared.repository import SessionRepository

from sanba_worker.analysis import TaskResult, VideoTaskPayload, process_video
from sanba_worker.config import WorkerSettings


def _repo_with_material(status: str = "analyzing") -> SessionRepository:
    repo = SessionRepository()  # ES/Firestore 未接続 → in-memory
    repo.save_material(
        "s1", {"id": "asset-abc", "name": "demo.mp4", "kind": "video", "status": status}
    )
    return repo


def _indexer() -> ContextIndexer:
    return ContextIndexer()  # 未設定 → in-memory


def _payload(**kw: object) -> VideoTaskPayload:
    base = {"session_id": "s1", "asset_id": "asset-abc", "gcs_uri": "gs://b/o.mp4"}
    base.update(kw)
    return VideoTaskPayload(**base)  # type: ignore[arg-type]


def _settings(**kw: object) -> WorkerSettings:
    return WorkerSettings(google_genai_use_vertexai=True, **kw)  # type: ignore[arg-type]


def _fake_analyze(*obs: str):
    def _inner(_config, **_kw):
        return VideoAnalysis(observations=list(obs))

    return _inner


def test_analyzes_and_marks_done() -> None:
    repo, indexer = _repo_with_material(), _indexer()
    result = process_video(
        _payload(),
        repo=repo,
        indexer=indexer,
        settings=_settings(),
        analyze=_fake_analyze("[00:01] ログイン画面", "[00:05] 保存ボタン"),
    )
    assert result == TaskResult("done", extracted=2)
    mat = repo.get_material("s1", "asset-abc")
    assert mat is not None and mat["status"] == "done" and mat["extracted"] == 2
    # grounding へ投入されている（in-memory）。
    assert any(d["source"].startswith("asset:asset-abc") for d in indexer._mem)


def test_skips_when_material_missing() -> None:
    repo = SessionRepository()  # 素材なし（削除済み相当）
    result = process_video(
        _payload(), repo=repo, indexer=_indexer(), settings=_settings(), analyze=_fake_analyze("x")
    )
    assert result.status == "skipped" and result.reason == "not_found"


def test_skips_when_already_done() -> None:
    repo = _repo_with_material(status="done")
    result = process_video(
        _payload(), repo=repo, indexer=_indexer(), settings=_settings(), analyze=_fake_analyze("x")
    )
    assert result.status == "skipped" and result.reason == "status_done"


def test_fails_when_too_long() -> None:
    repo = _repo_with_material()
    result = process_video(
        _payload(duration_seconds=1200),
        repo=repo,
        indexer=_indexer(),
        settings=_settings(max_video_duration_seconds=600),
        analyze=_fake_analyze("x"),
    )
    assert result.status == "failed" and result.reason == "video_too_long"
    assert repo.get_material("s1", "asset-abc")["status"] == "failed"


def test_does_not_resurrect_deleted_material() -> None:
    """解析中に破棄された素材は復活させない（書き込み直前の再確認）。"""
    repo = _repo_with_material()

    def _delete_then_analyze(_config, **_kw):
        repo.delete_material("s1", "asset-abc")  # 解析中に破棄
        return VideoAnalysis(observations=["[00:01] x"])

    result = process_video(
        _payload(),
        repo=repo,
        indexer=_indexer(),
        settings=_settings(),
        analyze=_delete_then_analyze,
    )
    assert result.status == "skipped" and result.reason == "deleted_during_analysis"
    assert repo.get_material("s1", "asset-abc") is None  # 復活していない


def test_local_path_rejects_oversized_bytes() -> None:
    repo = _repo_with_material()
    result = process_video(
        _payload(),
        repo=repo,
        indexer=_indexer(),
        settings=WorkerSettings(google_genai_use_vertexai=False, max_inline_video_bytes=10),
        analyze=_fake_analyze("x"),
        fetch_bytes=lambda _uri: b"x" * 50,
    )
    assert result.status == "failed" and result.reason == "video_too_large_for_local"


def test_local_path_analyzes_bytes() -> None:
    repo, indexer = _repo_with_material(), _indexer()
    result = process_video(
        _payload(),
        repo=repo,
        indexer=indexer,
        settings=WorkerSettings(google_genai_use_vertexai=False, max_inline_video_bytes=1000),
        analyze=_fake_analyze("[00:02] 一覧画面"),
        fetch_bytes=lambda _uri: b"tiny-bytes",
    )
    assert result.status == "done" and result.extracted == 1
