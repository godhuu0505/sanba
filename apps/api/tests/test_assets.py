"""Tests for multimodal asset upload (issue #103 / ADR-0004).

画像/動画アップロードの分類・安定 ID・保存・エンドポイント契約（asset_id 返却・
動画は準備中・非対応は 415）を検証する。Gemini 解析は creds 依存なので、整形ロジック
（parse_observations）のみ単体で確認する。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import app
from sanba_api.storage import (
    AssetStore,
    asset_kind,
    compute_asset_id,
    is_text_upload,
    resolve_content_type,
)
from sanba_api.vision import parse_observations

client = TestClient(app)


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    """セッション作成に必要な検証済みユーザーをスタブする (ADR-0012)。"""
    app.dependency_overrides[require_user] = lambda: AuthUser(
        sub="owner-123456789", email="owner@example.com", email_verified=True, name="Owner"
    )
    yield
    app.dependency_overrides.pop(require_user, None)


def _new_session() -> str:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    return created.json()["session_id"]


# ── 分類 ────────────────────────────────────────────────────────────────
def test_asset_kind_classifies_image_and_video() -> None:
    assert asset_kind("mock.png", "image/png") == "image"
    assert asset_kind("photo.JPG", None) == "image"
    assert asset_kind("rec.mp4", "video/mp4") == "video"
    assert asset_kind("screen.MOV", None) == "video"


def test_asset_kind_rejects_unsupported() -> None:
    assert asset_kind("malware.exe", "application/octet-stream") is None
    assert asset_kind("archive.zip", None) is None


def test_resolve_content_type_infers_from_extension() -> None:
    # content-type 欠落でも拡張子から実体に合わせる（JPEG を PNG と誤らない）。
    assert resolve_content_type("photo.jpg", None, "image") == "image/jpeg"
    assert resolve_content_type("mock.png", "", "image") == "image/png"
    assert resolve_content_type("clip.mov", None, "video") == "video/quicktime"
    # 明示された正規 content-type はそのまま採用。
    assert resolve_content_type("x.bin", "image/png", "image") == "image/png"


def test_is_text_upload_detects_text_family() -> None:
    assert is_text_upload("spec.md", None) is True
    assert is_text_upload("notes.txt", "text/plain") is True
    assert is_text_upload("doc.pdf", "application/pdf") is True
    assert is_text_upload("mock.png", "image/png") is False


# ── 安定 ID / 保存 ────────────────────────────────────────────────────────
def test_compute_asset_id_is_stable_and_content_addressed() -> None:
    a = compute_asset_id(b"same-bytes")
    b = compute_asset_id(b"same-bytes")
    c = compute_asset_id(b"other-bytes")
    assert a == b
    assert a != c
    assert a.startswith("asset-")


def test_asset_store_memory_roundtrip() -> None:
    store = AssetStore()
    assert store.is_memory is True
    asset = store.store("sess-1", "image", "image/png", b"\x89PNG\r\n")
    assert asset.kind == "image"
    assert asset.size == 6
    assert asset.uri.startswith("mem://")
    # 同じバイト列は同じ asset_id（冪等・対応付けが揺れない）。
    again = store.store("sess-1", "image", "image/png", b"\x89PNG\r\n")
    assert again.asset_id == asset.asset_id


# ── Gemini 出力の整形 ────────────────────────────────────────────────────
def test_parse_observations_strips_bullets_and_numbers() -> None:
    text = "- ログイン画面にSSOボタン\n* 検索バーが上部\n1. 件数バッジ=12\n\n・送信ボタンが無効"
    obs = parse_observations(text)
    assert obs == [
        "ログイン画面にSSOボタン",
        "検索バーが上部",
        "件数バッジ=12",
        "送信ボタンが無効",
    ]


def test_parse_observations_respects_limit() -> None:
    text = "\n".join(f"- 観察{i}" for i in range(20))
    assert len(parse_observations(text, limit=8)) == 8


# ── エンドポイント契約 ────────────────────────────────────────────────────
def test_upload_image_returns_asset_id() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("mock.png", b"\x89PNG\r\n\x1a\n", "image/png")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["asset_id"].startswith("asset-")
    assert body["asset_kind"] == "image"
    assert body["analysis_pending"] is False
    # creds 未設定のテストでは解析は空 → 索引 0 でも asset_id は返る。
    assert body["indexed_chunks"] == 0


def test_upload_video_is_pending() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("rec.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["asset_kind"] == "video"
    assert body["analysis_pending"] is True
    assert body["asset_id"].startswith("asset-")


def test_upload_unsupported_type_rejected() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("evil.exe", b"MZ\x90\x00", "application/octet-stream")},
    )
    assert res.status_code == 415


def test_upload_text_still_indexes() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("prd.md", "要約機能が必要。\n\n対象は社内。".encode(), "text/markdown")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["indexed_chunks"] >= 1
    assert body["asset_id"] is None
