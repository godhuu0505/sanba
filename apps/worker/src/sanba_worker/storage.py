"""GCS bytes fetch for the GenAI-API (local) analysis path.

本番 Vertex 経路は gs:// URI を Gemini に直接渡すため不要。ローカル/GenAI 経路のみ、動画本体を
worker に読み込んで inline 送信する（短尺前提。大きすぎるものは analysis 側で弾く）。
"""

from __future__ import annotations


class DisallowedBucketError(ValueError):
    """`gcs_uri` の bucket が許可バケット（`settings.gcs_bucket`）と一致しないときに送出。"""


def parse_gs_uri(gcs_uri: str) -> tuple[str, str]:
    """`gs://bucket/path/to/obj` を (bucket, object_name) に分解する。"""
    if not gcs_uri.startswith("gs://"):
        raise ValueError(f"not a gs:// uri: {gcs_uri}")
    rest = gcs_uri[len("gs://") :]
    bucket, _, obj = rest.partition("/")
    if not bucket or not obj:
        raise ValueError(f"malformed gs:// uri: {gcs_uri}")
    return bucket, obj


def ensure_allowed_bucket(gcs_uri: str, allowed_bucket: str) -> tuple[str, str]:
    """`gcs_uri` を分解し、bucket が許可バケットと一致することを確認して返す。

    `allowed_bucket` が空（未設定＝dev/local）のときは制約を課さない。設定されていれば、
    payload 由来の任意 bucket 取得（CWE-639）を拒否してフェイルクローズする。
    """
    bucket, obj = parse_gs_uri(gcs_uri)
    if allowed_bucket and bucket != allowed_bucket:
        raise DisallowedBucketError(
            f"bucket {bucket!r} is not the allowed bucket {allowed_bucket!r}"
        )
    return bucket, obj


def gcs_fetch_bytes(gcs_uri: str) -> bytes:  # pragma: no cover
    """gs:// オブジェクトの中身を取得する。"""
    from google.cloud import storage  # type: ignore[attr-defined]

    bucket, obj = parse_gs_uri(gcs_uri)
    client = storage.Client()
    return client.bucket(bucket).blob(obj).download_as_bytes()
