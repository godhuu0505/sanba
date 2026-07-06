"""Binary asset storage for multimodal uploads (issue #103 / ADR-0004).

`POST /api/sessions/{id}/context/file` を画像/動画に拡張するための保存層。
受理した画像/動画を Cloud Storage に保存し、**安定 ID（content hash 由来の `asset_id`）**を
発番する。web はこの `asset_id` で `analysis.progress` / `analysis.visual`（契約 §3）を
ファイル行へ対応付ける。

ContextIndexer（ingestion.py）と同じ「本番=GCS / 未設定・テスト=in-memory」の二段構えにし、
GCS バケット未設定でもローカルとテストが回るようにする（CLAUDE.md: production-ready だが
PoC で止めない）。同一バイト列の再アップロードは同じ `asset_id` を返す（冪等・安定）。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

import structlog

from .config import settings

log = structlog.get_logger(__name__)

# 受理する MIME（要件票 06: 画像 PNG/JPG・動画 MP4/MOV）。拡張子だけに頼らず
# content-type と拡張子の両方から種別を判定する（ピッカ偽装・欠落への保険）。
IMAGE_MIME = {"image/png": ".png", "image/jpeg": ".jpg"}
VIDEO_MIME = {"video/mp4": ".mp4", "video/quicktime": ".mov"}
IMAGE_EXT = {".png", ".jpg", ".jpeg"}
VIDEO_EXT = {".mp4", ".mov"}
# テキスト系（既存経路）。ここに該当しないものは「非対応」として 415 で弾く。
TEXT_EXT = {".txt", ".md", ".pdf"}


@dataclass(frozen=True)
class Asset:
    """保存済みアセットの参照。`asset_id` が web との対応付けキー。"""

    asset_id: str
    kind: str  # "image" | "video"
    content_type: str
    size: int
    uri: str  # gs://bucket/... もしくは mem://... （in-memory 時）


def material_record(
    asset_id: str, name: str, kind: str, status: str, extracted: int = 0
) -> dict[str, object]:
    """素材一覧（GET context/files / 契約 §4 #184）の 1 行を組み立てる。

    web の MaterialItem（id/name/status/extracted）に対応する。バイト列ではなく
    「投入された素材のメタ」で、リロード/再接続時に実ファイル名と状態を復元する。
    永続化は SessionRepository（外部ストア）が担う（多インスタンス/再起動でも復元できる）。
    """
    item: dict[str, object] = {"id": asset_id, "name": name, "kind": kind, "status": status}
    if extracted > 0:
        item["extracted"] = extracted
    return item


def asset_kind(filename: str, content_type: str | None) -> str | None:
    """アップロードの種別を返す。画像/動画なら "image"/"video"、非対応なら None。

    テキスト系（txt/md/pdf）は既存の text 経路で処理するため、ここでは扱わない
    （呼び出し側が text として分岐する）。
    """
    name = (filename or "").lower()
    ext = name[name.rfind(".") :] if "." in name else ""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in IMAGE_MIME or ext in IMAGE_EXT:
        return "image"
    if ct in VIDEO_MIME or ext in VIDEO_EXT:
        return "video"
    return None


def resolve_content_type(filename: str, content_type: str | None, kind: str) -> str:
    """送信された content-type を採用しつつ、欠落時は拡張子から推定する。

    ピッカが content-type を付けないケースでも、JPEG を image/png と誤ラベルしない
    （Gemini 解析・GCS メタデータが実体と食い違うのを防ぐ）。
    """
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in IMAGE_MIME or ct in VIDEO_MIME:
        return ct
    name = (filename or "").lower()
    ext = name[name.rfind(".") :] if "." in name else ""
    if kind == "image":
        return "image/jpeg" if ext in {".jpg", ".jpeg"} else "image/png"
    return "video/quicktime" if ext == ".mov" else "video/mp4"


def is_text_upload(filename: str, content_type: str | None) -> bool:
    """既存のテキスト取り込み（txt/md/pdf）に該当するか。"""
    name = (filename or "").lower()
    ext = name[name.rfind(".") :] if "." in name else ""
    ct = (content_type or "").split(";")[0].strip().lower()
    return ext in TEXT_EXT or ct in {"text/plain", "text/markdown", "application/pdf"}


def compute_asset_id(raw: bytes) -> str:
    """content hash で安定 ID を作る（同じ素材は同じ ID = 冪等・対応付けが揺れない）。"""
    return f"asset-{hashlib.sha256(raw).hexdigest()[:16]}"


class AssetStore:
    """画像/動画を Cloud Storage に保存する。未設定なら in-memory にフォールバック。"""

    def __init__(self) -> None:
        self._bucket = self._init_bucket()
        # in-memory フォールバック: テスト・ローカルで保存先がないときの退避（本番は GCS）。
        self._mem: dict[str, bytes] = {}

    @property
    def is_memory(self) -> bool:
        return self._bucket is None

    @staticmethod
    def _init_bucket():  # type: ignore[no-untyped-def]
        if not settings.gcs_bucket:
            return None
        try:  # pragma: no cover - needs GCP creds/network
            from google.cloud import storage

            client = storage.Client()
            return client.bucket(settings.gcs_bucket)
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("gcs_unavailable_using_memory", error=str(exc))
            return None

    def store(self, session_id: str, kind: str, content_type: str, raw: bytes) -> Asset:
        """アセットを保存し、安定 `asset_id` 付きの参照を返す。"""
        asset_id = compute_asset_id(raw)
        ext = IMAGE_MIME.get(content_type) or VIDEO_MIME.get(content_type) or ""
        # セッション配下に置き、asset_id をオブジェクト名にする（同素材は上書き=冪等）。
        blob_name = f"sessions/{session_id}/assets/{asset_id}{ext}"
        if self._bucket is not None:  # pragma: no cover - needs live GCS
            blob = self._bucket.blob(blob_name)
            blob.upload_from_string(raw, content_type=content_type)
            uri = f"gs://{settings.gcs_bucket}/{blob_name}"
        else:
            self._mem[blob_name] = raw
            uri = f"mem://{blob_name}"
        log.info(
            "asset_stored",
            session=session_id,
            asset_id=asset_id,
            kind=kind,
            size=len(raw),
            backend="gcs" if self._bucket is not None else "memory",
        )
        return Asset(
            asset_id=asset_id, kind=kind, content_type=content_type, size=len(raw), uri=uri
        )

    def delete(self, session_id: str, asset_id: str) -> bool:
        """保存済み binary を削除する（#245 真の破棄）。実体を消したら True（冪等）。

        拡張子は content_type 依存で呼び出し側（DELETE エンドポイント）は持たないため、
        `sessions/{sid}/assets/{asset_id}` を接頭辞に持つオブジェクトをまとめて消す。
        asset_id は固定長（`asset-`＋16桁 hash）なので、別 asset の接頭辞に化けることはなく
        後続は拡張子（`.png` 等）のみ。GCS 未接続は in-memory を消す。存在しない asset でも
        安全に False を返す（フォールバックを壊さない）。
        """
        prefix = f"sessions/{session_id}/assets/{asset_id}"
        removed = False
        if self._bucket is not None:  # pragma: no cover - needs live GCS
            for blob in self._bucket.list_blobs(prefix=prefix):
                blob.delete()
                removed = True
        else:
            for name in [k for k in self._mem if k.startswith(prefix)]:
                del self._mem[name]
                removed = True
        if removed:
            log.info(
                "asset_deleted",
                session=session_id,
                asset_id=asset_id,
                backend="gcs" if self._bucket is not None else "memory",
            )
        return removed

    # ---- 動画の直送アップロード（ADR-0040） ---------------------------------
    # 200MB の動画は Cloud Run の HTTP/1 request 上限（32MiB）を超えるため multipart で受けない。
    # ブラウザから GCS へ署名付き URL で直送し、api はバイト列を経由しない。

    @staticmethod
    def blob_name(session_id: str, asset_id: str, content_type: str) -> str:
        ext = IMAGE_MIME.get(content_type) or VIDEO_MIME.get(content_type) or ""
        return f"sessions/{session_id}/assets/{asset_id}{ext}"

    def gcs_uri(self, session_id: str, asset_id: str, content_type: str) -> str:
        name = self.blob_name(session_id, asset_id, content_type)
        return f"gs://{settings.gcs_bucket}/{name}" if self._bucket is not None else f"mem://{name}"

    def generate_upload_url(
        self, session_id: str, asset_id: str, content_type: str, *, ttl_seconds: int, max_bytes: int
    ) -> str:
        """ブラウザが動画本体を PUT する署名付き URL（v4）を発行する。

        `x-goog-content-length-range` を署名に含め、GCS 側で 0..max_bytes を強制する
        （クライアントが上限超のサイズを送れないようにする）。GCS 未接続（テスト/ローカル）は
        `mem://` の擬似 URL を返す（直送は実バケットが要るため単体テストは差し込みで検証する）。
        """
        name = self.blob_name(session_id, asset_id, content_type)
        if self._bucket is None:
            return f"mem://{name}"
        return self._sign_put_url(name, content_type, ttl_seconds, max_bytes)  # pragma: no cover

    def _sign_put_url(  # pragma: no cover - needs GCP creds/network
        self, blob_name: str, content_type: str, ttl_seconds: int, max_bytes: int
    ) -> str:
        from datetime import timedelta

        import google.auth
        from google.auth.transport import requests as ga_requests

        # Cloud Run の SA には鍵ファイルが無いため、IAM SignBlob（tokenCreator on self）で署名する。
        credentials, _ = google.auth.default()
        credentials.refresh(ga_requests.Request())
        blob = self._bucket.blob(blob_name)
        return blob.generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=ttl_seconds),
            method="PUT",
            content_type=content_type,
            headers={"x-goog-content-length-range": f"0,{max_bytes}"},
            service_account_email=getattr(credentials, "service_account_email", None),
            access_token=getattr(credentials, "token", None),
        )

    def object_size(self, session_id: str, asset_id: str, content_type: str) -> int | None:
        """アップロード済みオブジェクトのサイズ（bytes）。存在しなければ None。

        upload-complete で「ブラウザが実際に PUT し終えたか」を検証するのに使う。
        """
        name = self.blob_name(session_id, asset_id, content_type)
        if self._bucket is not None:  # pragma: no cover - needs live GCS
            blob = self._bucket.get_blob(name)
            return int(blob.size) if blob is not None and blob.size is not None else None
        raw = self._mem.get(name)
        return len(raw) if raw is not None else None
