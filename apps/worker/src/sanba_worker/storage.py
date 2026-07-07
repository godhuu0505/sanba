"""GCS bytes fetch for the GenAI-API (local) analysis path.

本番 Vertex 経路は gs:// URI を Gemini に直接渡すため不要。ローカル/GenAI 経路のみ、動画本体を
worker に読み込んで inline 送信する（短尺前提。大きすぎるものは analysis 側で弾く）。
"""

from __future__ import annotations


def parse_gs_uri(gcs_uri: str) -> tuple[str, str]:
    """`gs://bucket/path/to/obj` を (bucket, object_name) に分解する。"""
    if not gcs_uri.startswith("gs://"):
        raise ValueError(f"not a gs:// uri: {gcs_uri}")
    rest = gcs_uri[len("gs://") :]
    bucket, _, obj = rest.partition("/")
    if not bucket or not obj:
        raise ValueError(f"malformed gs:// uri: {gcs_uri}")
    return bucket, obj


def gcs_fetch_bytes(gcs_uri: str) -> bytes:  # pragma: no cover
    """gs:// オブジェクトの中身を取得する。"""
    from google.cloud import storage  # type: ignore[attr-defined]

    bucket, obj = parse_gs_uri(gcs_uri)
    client = storage.Client()
    return client.bucket(bucket).blob(obj).download_as_bytes()
