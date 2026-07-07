"""Tests for multimodal asset upload.

画像/動画アップロードの分類・安定 ID・保存・エンドポイント契約（asset_id 返却・
動画は準備中・非対応は 415）を検証する。Gemini 解析は creds 依存なので、整形ロジック
（parse_observations）のみ単体で確認する。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth import create_session_token
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.main import app
from sanba_api.storage import (
    AssetStore,
    asset_kind,
    compute_asset_id,
    is_binary_document,
    is_text_upload,
    resolve_content_type,
)
from sanba_api.vision import parse_observations

client = TestClient(app)


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    """セッション作成に必要な検証済みユーザーをスタブする。"""
    app.dependency_overrides[require_user] = lambda: AuthUser(
        sub="owner-123456789", email="owner@example.com", email_verified=True, name="Owner"
    )
    yield
    app.dependency_overrides.pop(require_user, None)


def _new_session() -> str:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    return created.json()["session_id"]


def _session_auth(session_id: str, role: str = "pm") -> dict[str, str]:
    """context/file 投稿は join 済みトークン必須（契約 §4）。テスト用の Bearer を作る。"""
    token = create_session_token(
        session_id, "owner-123456789", role, settings.session_signing_secret, 3600
    )
    return {"Authorization": f"Bearer {token}"}


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


def test_is_text_upload_detects_extended_document_types() -> None:
    # 追加した資料形式（html/csv/json/docx/xlsx/pptx）。拡張子・MIME どちらでも受理する。
    assert is_text_upload("spec.html", None) is True
    assert is_text_upload("page.htm", "text/html") is True
    assert is_text_upload("data.csv", "text/csv") is True
    assert is_text_upload("config.json", "application/json") is True
    assert is_text_upload("doc.docx", None) is True
    assert (
        is_text_upload(
            "noext",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        is True
    )
    assert is_text_upload("deck.pptx", None) is True
    assert is_text_upload("archive.zip", "application/zip") is False


def test_is_binary_document_splits_size_guard() -> None:
    # バイナリ文書は max_asset_bytes、プレーンテキストは文字数上限×4 で守る（境界の判定）。
    assert is_binary_document("doc.pdf", None) is True
    assert is_binary_document("doc.docx", None) is True
    assert is_binary_document("spec.md", "text/markdown") is False
    assert is_binary_document("spec.html", None) is False


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
        headers=_session_auth(sid),
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
        headers=_session_auth(sid),
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
        headers=_session_auth(sid),
    )
    assert res.status_code == 415


# ── 素材一覧ハイドレーション（GET context/files）──────────────────────
def test_context_files_requires_session_token() -> None:
    res = client.get("/api/sessions/sess-nofiles/context/files")
    assert res.status_code == 401


def test_context_files_lists_uploaded_materials() -> None:
    sid = _new_session()
    # 画像（同期解析済み = done）と動画（解析未実装 = analyzing）を投入。
    client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("mock.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        headers=_session_auth(sid),
    )
    client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("rec.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")},
        headers=_session_auth(sid),
    )
    res = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid))
    assert res.status_code == 200
    items = res.json()["items"]
    by_name = {it["name"]: it for it in items}
    # 実ファイル名と asset_id・状態が復元できる（リロード/再接続のハイドレーション）。
    assert by_name["mock.png"]["kind"] == "image"
    assert by_name["mock.png"]["status"] == "done"
    assert by_name["mock.png"]["id"].startswith("asset-")
    assert by_name["rec.mp4"]["kind"] == "video"
    assert by_name["rec.mp4"]["status"] == "analyzing"


def test_context_files_empty_for_new_session() -> None:
    sid = _new_session()
    res = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid))
    assert res.status_code == 200
    assert res.json()["items"] == []


# ── 真の破棄（DELETE context/file）──────────────────────────────────
def test_delete_context_file_requires_session_token() -> None:
    res = client.delete("/api/sessions/sess-x/context/file/asset-deadbeef")
    assert res.status_code == 401


def test_delete_context_file_removes_binary_meta_and_grounding() -> None:
    from sanba_api.main import _asset_store, _indexer

    sid = _new_session()
    up = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("mock.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        headers=_session_auth(sid),
    )
    asset_id = up.json()["asset_id"]
    # 解析（grounding）は creds 依存で空のため、出所 asset:{id} の chunk を明示的に投入して
    # 「真の破棄」が索引まで消すことを検証する（本番では index_context が同経路で入る）。
    _indexer.index_context(sid, ["観察A", "観察B"], f"asset:{asset_id}")
    assert any(d.get("source", "").startswith(f"asset:{asset_id}") for d in _indexer._mem)

    res = client.delete(f"/api/sessions/{sid}/context/file/{asset_id}", headers=_session_auth(sid))
    assert res.status_code == 200
    body = res.json()
    assert body == {"deleted": True, "existed": True}

    # (1) GET context/files に出ない（リロードで復活しない）。
    files = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid)).json()
    assert all(it["id"] != asset_id for it in files["items"])
    # (2) grounding 索引から消える。
    assert not any(d.get("source", "").startswith(f"asset:{asset_id}") for d in _indexer._mem)
    # (3) binary が消える（再削除は実体なし）。
    assert _asset_store.delete(sid, asset_id) is False


def test_delete_context_file_is_idempotent() -> None:
    sid = _new_session()
    # 存在しない asset でも 200・existed=false（冪等）。
    res = client.delete(
        f"/api/sessions/{sid}/context/file/asset-doesnotexist", headers=_session_auth(sid)
    )
    assert res.status_code == 200
    assert res.json() == {"deleted": True, "existed": False}

    # 実在 asset を消したあと、二度目も 200・existed=false（一貫）。
    up = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("rec.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")},
        headers=_session_auth(sid),
    )
    asset_id = up.json()["asset_id"]
    first = client.delete(
        f"/api/sessions/{sid}/context/file/{asset_id}", headers=_session_auth(sid)
    )
    assert first.json() == {"deleted": True, "existed": True}
    second = client.delete(
        f"/api/sessions/{sid}/context/file/{asset_id}", headers=_session_auth(sid)
    )
    assert second.json() == {"deleted": True, "existed": False}


def test_upload_text_indexes_and_returns_doc_asset() -> None:
    """資料も画像/動画と同じく安定 asset_id 付きの素材になる（素材一覧・破棄に対応）。"""
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("prd.md", "要約機能が必要。\n\n対象は社内。".encode(), "text/markdown")},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    body = res.json()
    assert body["indexed_chunks"] >= 1
    assert body["asset_id"].startswith("asset-")
    assert body["asset_kind"] == "doc"
    assert body["analysis_pending"] is False

    # 素材一覧（GET context/files）に載り、リロード後も実ファイル名・件数を復元できる。
    files = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid)).json()
    by_name = {it["name"]: it for it in files["items"]}
    assert by_name["prd.md"]["kind"] == "doc"
    assert by_name["prd.md"]["status"] == "done"
    assert by_name["prd.md"]["extracted"] >= 1


def test_upload_doc_reupload_is_idempotent_in_grounding() -> None:
    """同一資料の再投入は同じ asset_id になり、grounding の chunk を重複させない。"""
    from sanba_api.main import _indexer

    sid = _new_session()
    payload = "検索を高速化する。\n\n対象は社内ユーザー。".encode()
    first = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("spec.md", payload, "text/markdown")},
        headers=_session_auth(sid),
    ).json()
    second = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("spec.md", payload, "text/markdown")},
        headers=_session_auth(sid),
    ).json()
    assert first["asset_id"] == second["asset_id"]
    chunks = [
        d
        for d in _indexer._mem
        if d.get("session_id") == sid
        and str(d.get("source", "")).startswith(f"asset:{first['asset_id']}")
    ]
    assert len(chunks) == second["indexed_chunks"]


def test_upload_html_indexes_visible_text() -> None:
    sid = _new_session()
    html = "<html><body><h1>検索機能</h1><script>alert(1)</script></body></html>"
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("spec.html", html.encode(), "text/html")},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    assert res.json()["indexed_chunks"] >= 1


def test_upload_docx_indexes_extracted_text() -> None:
    import io

    from docx import Document

    document = Document()
    document.add_paragraph("要約機能が必要。")
    buf = io.BytesIO()
    document.save(buf)

    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={
            "file": (
                "spec.docx",
                buf.getvalue(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    body = res.json()
    assert body["indexed_chunks"] >= 1
    assert body["asset_kind"] == "doc"


def test_delete_context_file_discards_doc_material() -> None:
    """資料も DELETE で素材メタ・grounding 索引をまとめて破棄できる。"""
    from sanba_api.main import _indexer

    sid = _new_session()
    up = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("prd.md", "要約機能が必要。".encode(), "text/markdown")},
        headers=_session_auth(sid),
    ).json()
    asset_id = up["asset_id"]

    res = client.delete(f"/api/sessions/{sid}/context/file/{asset_id}", headers=_session_auth(sid))
    assert res.status_code == 200
    assert res.json() == {"deleted": True, "existed": True}
    files = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid)).json()
    assert all(it["id"] != asset_id for it in files["items"])
    assert not any(
        str(d.get("source", "")).startswith(f"asset:{asset_id}")
        for d in _indexer._mem
        if d.get("session_id") == sid
    )
