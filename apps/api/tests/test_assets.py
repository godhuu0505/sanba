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


def test_asset_kind_classifies_image_and_video() -> None:
    assert asset_kind("mock.png", "image/png") == "image"
    assert asset_kind("photo.JPG", None) == "image"
    assert asset_kind("rec.mp4", "video/mp4") == "video"
    assert asset_kind("screen.MOV", None) == "video"


def test_asset_kind_rejects_unsupported() -> None:
    assert asset_kind("malware.exe", "application/octet-stream") is None
    assert asset_kind("archive.zip", None) is None


def test_resolve_content_type_infers_from_extension() -> None:
    assert resolve_content_type("photo.jpg", None, "image") == "image/jpeg"
    assert resolve_content_type("mock.png", "", "image") == "image/png"
    assert resolve_content_type("clip.mov", None, "video") == "video/quicktime"
    assert resolve_content_type("x.bin", "image/png", "image") == "image/png"


def test_is_text_upload_detects_text_family() -> None:
    assert is_text_upload("spec.md", None) is True
    assert is_text_upload("notes.txt", "text/plain") is True
    assert is_text_upload("doc.pdf", "application/pdf") is True
    assert is_text_upload("mock.png", "image/png") is False


def test_is_text_upload_detects_extended_document_types() -> None:
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
    assert is_binary_document("doc.pdf", None) is True
    assert is_binary_document("doc.docx", None) is True
    assert is_binary_document("spec.md", "text/markdown") is False
    assert is_binary_document("spec.html", None) is False


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
    again = store.store("sess-1", "image", "image/png", b"\x89PNG\r\n")
    assert again.asset_id == asset.asset_id


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


def test_context_files_requires_session_token() -> None:
    res = client.get("/api/sessions/sess-nofiles/context/files")
    assert res.status_code == 401


def test_context_files_lists_uploaded_materials() -> None:
    sid = _new_session()
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
    assert by_name["mock.png"]["kind"] == "image"
    assert by_name["mock.png"]["status"] == "done"
    assert by_name["mock.png"]["id"].startswith("asset-")
    assert by_name["rec.mp4"]["kind"] == "video"
    assert by_name["rec.mp4"]["status"] == "analyzing"


def test_context_files_include_analysis_details(monkeypatch: pytest.MonkeyPatch) -> None:
    """解析済み素材は観察テキストを返す（#355: 再接続後も解析詳細を復元できる）。"""
    observations = ["検索ボタンがある", "設定画面へのリンクが無い"]
    monkeypatch.setattr(
        "sanba_api.routers.sessions.analyze_image",
        lambda raw, content_type, **_kwargs: observations,
    )
    sid = _new_session()
    client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("mock.png", b"\x89PNG\r\n\x1a\n#355-details", "image/png")},
        headers=_session_auth(sid),
    )
    res = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid))
    assert res.status_code == 200
    item = next(it for it in res.json()["items"] if it["name"] == "mock.png")
    assert item["status"] == "done"
    assert item["extracted"] == 2
    assert item["extracted_texts"] == observations


def test_context_files_empty_for_new_session() -> None:
    sid = _new_session()
    res = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid))
    assert res.status_code == 200
    assert res.json()["items"] == []


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
    _indexer.index_context(sid, ["観察A", "観察B"], f"asset:{asset_id}")
    assert any(d.get("source", "").startswith(f"asset:{asset_id}") for d in _indexer._mem)

    res = client.delete(f"/api/sessions/{sid}/context/file/{asset_id}", headers=_session_auth(sid))
    assert res.status_code == 200
    body = res.json()
    assert body == {"deleted": True, "existed": True}

    files = client.get(f"/api/sessions/{sid}/context/files", headers=_session_auth(sid)).json()
    assert all(it["id"] != asset_id for it in files["items"])
    assert not any(d.get("source", "").startswith(f"asset:{asset_id}") for d in _indexer._mem)
    assert _asset_store.delete(sid, asset_id) is False


def test_delete_context_file_is_idempotent() -> None:
    sid = _new_session()
    res = client.delete(
        f"/api/sessions/{sid}/context/file/asset-doesnotexist", headers=_session_auth(sid)
    )
    assert res.status_code == 200
    assert res.json() == {"deleted": True, "existed": False}

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


def test_upload_doc_saves_extracted_texts_for_agent_seed() -> None:
    """doc も画像/動画と同じく素材メタへ本文（extracted_texts）を残す（ADR-0063）。

    voice agent が起動時に初期前提としてシードする源。上限（DOC_SEED_MAX_CHARS）で
    機械的に打ち切られ、全文は従来どおり grounding 側が持つ。
    """
    from sanba_api.main import _repo
    from sanba_api.routers.sessions import DOC_SEED_MAX_CHARS, _doc_seed_texts

    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/context/file",
        files={"file": ("prd.md", "要約機能が必要。\n\n対象は社内。".encode(), "text/markdown")},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    material = _repo.get_material(sid, res.json()["asset_id"])
    assert material is not None
    texts = material["extracted_texts"]
    assert any("要約機能が必要" in t for t in texts)
    assert sum(len(t) for t in texts) <= DOC_SEED_MAX_CHARS

    capped = _doc_seed_texts(["あ" * 3000, "い" * 3000, "う" * 3000])
    assert sum(len(t) for t in capped) == DOC_SEED_MAX_CHARS
    assert _doc_seed_texts([]) == []
    assert _doc_seed_texts(["  ", ""]) == []


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
