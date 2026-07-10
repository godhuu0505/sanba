"""`sanba-analytics-*` データストリームと単価 lookup index の冪等セットアップ（ADR-0061）。

grounding 索引（`ContextIndexer._init_client`）と同じ「存在確認 → 作成/更新」の冪等イディオムを
データストリーム + ILM + index template に拡張したもの。`scripts/setup_analytics.py`
（`just analytics-setup`）から全量セットアップを実行し、`AnalyticsSink` は起動時に
テンプレート不在時の最小セットアップだけを fail-soft で行う。

Kibana ダッシュボード（`infra/observability/kibana/sanba-analytics.ndjson`）の import も
ここに置き、追加依存なし（urllib）で Kibana Saved Objects API を叩く。
"""

from __future__ import annotations

import json
import urllib.request
import uuid
from typing import Any

import structlog

from .analytics import PRICING

log = structlog.get_logger(__name__)

ANALYTICS_DATA_STREAM = "sanba-analytics-events"
ANALYTICS_INDEX_PATTERN = "sanba-analytics-*"
ANALYTICS_INDEX_TEMPLATE = "sanba-analytics"
ANALYTICS_ILM_POLICY = "sanba-analytics-retention"
PRICING_INDEX = "sanba-pricing"

DEFAULT_ANALYTICS_RETENTION_DAYS = 365


def event_mappings() -> dict[str, Any]:
    token_fields = {
        name: {"type": "long"}
        for name in (
            "input_tokens",
            "input_text_tokens",
            "input_audio_tokens",
            "input_image_tokens",
            "input_cached_tokens",
            "output_tokens",
            "output_text_tokens",
            "output_audio_tokens",
        )
    }
    return {
        "properties": {
            "@timestamp": {"type": "date"},
            "event_type": {"type": "keyword"},
            "session_id": {"type": "keyword"},
            "product_id": {"type": "keyword"},
            "interview_mode": {"type": "keyword"},
            "occurred_at": {"type": "date"},
            "payload": {
                "properties": {
                    "component": {"type": "keyword"},
                    "model": {"type": "keyword"},
                    "estimated_usd": {"type": "double"},
                    "pricing_known": {"type": "boolean"},
                    "requests": {"type": "long"},
                    "tokens": {"properties": token_fields},
                    "ai_usd": {"type": "double"},
                    "total_usd": {"type": "double"},
                    "total_jpy": {"type": "double"},
                    "usd_jpy_rate": {"type": "double"},
                    "livekit": {
                        "properties": {
                            "minutes": {"type": "double"},
                            "assumed_participants": {"type": "long"},
                            "connection_usd": {"type": "double"},
                            "agent_session_usd": {"type": "double"},
                            "noise_cancellation_usd": {"type": "double"},
                            "estimated_usd": {"type": "double"},
                        }
                    },
                    "components": {"type": "object", "dynamic": True},
                    "kpi": {
                        "properties": {
                            "finalized_count": {"type": "long"},
                            "requirement_count": {"type": "long"},
                            "session_seconds": {"type": "double"},
                            "quality_overall": {"type": "double"},
                            "quality_scores": {"type": "object", "dynamic": True},
                            "inquiry": {"type": "object", "dynamic": True},
                        }
                    },
                    "efficiency": {
                        "properties": {
                            "usd_per_finalized_requirement": {"type": "double"},
                            "usd_per_resolved_inquiry": {"type": "double"},
                        }
                    },
                }
            },
        }
    }


def is_serverless(client: Any) -> bool:
    """対象クラスタが Elasticsearch Serverless かを判定する（判定不能なら False）。

    Serverless は `index.number_of_replicas` も ILM も設定できず、指定すると 400 で弾かれる。
    `GET /`（`client.info()`）の `version.build_flavor == "serverless"` で見分け、
    template 構築時に replica/ILM を落として data stream lifecycle へ切り替える。
    """
    info = getattr(client, "info", None)
    if not callable(info):
        return False
    try:
        data = info()
    except Exception:  # noqa: BLE001
        return False
    try:
        version = data.get("version") or {}
        return version.get("build_flavor") == "serverless"
    except AttributeError:
        return False


def put_index_template(
    client: Any,
    *,
    with_ilm: bool,
    serverless: bool = False,
    retention_days: int = DEFAULT_ANALYTICS_RETENTION_DAYS,
) -> None:
    settings: dict[str, Any] = {}
    template: dict[str, Any] = {"mappings": event_mappings()}
    if serverless:
        template["lifecycle"] = {"data_retention": f"{retention_days}d"}
    else:
        settings["number_of_replicas"] = 0
        if with_ilm:
            settings["index.lifecycle.name"] = ANALYTICS_ILM_POLICY
    if settings:
        template["settings"] = settings
    client.indices.put_index_template(
        name=ANALYTICS_INDEX_TEMPLATE,
        index_patterns=[ANALYTICS_INDEX_PATTERN],
        data_stream={},
        template=template,
    )


def ensure_event_stream_template(client: Any) -> bool:
    """テンプレート不在時だけ最小構成（ILM なし）で作る。作成したら True。

    アプリの ES API key が template 権限を持たない環境でも fail-soft で動くよう、
    `AnalyticsSink` の初期化から呼ぶ軽量経路。ILM 付きの全量は `setup_analytics` で行う。
    Serverless では replica/ILM を落とし、retention は data stream lifecycle で持たせる。
    """
    if client.indices.exists_index_template(name=ANALYTICS_INDEX_TEMPLATE):
        return False
    put_index_template(client, with_ilm=False, serverless=is_serverless(client))
    return True


def put_ilm_policy(client: Any, retention_days: int) -> None:
    client.ilm.put_lifecycle(
        name=ANALYTICS_ILM_POLICY,
        policy={
            "phases": {
                "hot": {"actions": {"rollover": {"max_primary_shard_size": "10gb"}}},
                "delete": {
                    "min_age": f"{retention_days}d",
                    "actions": {"delete": {}},
                },
            }
        },
    )


def seed_pricing_index(client: Any) -> int:
    """単価テーブルを lookup 用 index へ冪等投入する（ES|QL での再計算・監査用）。"""
    if not client.indices.exists(index=PRICING_INDEX):
        client.indices.create(
            index=PRICING_INDEX,
            mappings={
                "properties": {
                    "model": {"type": "keyword"},
                    "input_text_usd": {"type": "double"},
                    "input_audio_usd": {"type": "double"},
                    "input_image_usd": {"type": "double"},
                    "output_text_usd": {"type": "double"},
                    "output_audio_usd": {"type": "double"},
                }
            },
        )
    for model, pricing in PRICING.items():
        client.index(
            index=PRICING_INDEX,
            id=model,
            document={
                "model": model,
                "input_text_usd": pricing.input_text_usd,
                "input_audio_usd": pricing.input_audio_usd,
                "input_image_usd": pricing.input_image_usd,
                "output_text_usd": pricing.output_text_usd,
                "output_audio_usd": pricing.output_audio_usd,
            },
        )
    return len(PRICING)


def setup_analytics(client: Any, *, retention_days: int = DEFAULT_ANALYTICS_RETENTION_DAYS) -> None:
    """ILM・index template・データストリーム・単価 index を冪等に整える（ops 用の全量経路）。

    Serverless では ILM が使えないため、retention は index template の data stream lifecycle
    （`data_retention`）に載せ、ILM ポリシー投入はスキップする。
    """
    serverless = is_serverless(client)
    if not serverless:
        put_ilm_policy(client, retention_days)
    put_index_template(
        client, with_ilm=not serverless, serverless=serverless, retention_days=retention_days
    )
    if not client.indices.exists(index=ANALYTICS_DATA_STREAM):
        client.indices.create_data_stream(name=ANALYTICS_DATA_STREAM)
    seeded = seed_pricing_index(client)
    log.info(
        "analytics_setup_done",
        data_stream=ANALYTICS_DATA_STREAM,
        retention_days=retention_days,
        serverless=serverless,
        pricing_models=seeded,
    )


def import_kibana_saved_objects(
    kibana_url: str, ndjson: bytes, *, api_key: str = "", timeout: float = 30.0
) -> dict[str, Any]:
    """Kibana Saved Objects import API へ ndjson を冪等（overwrite=true）投入する。"""
    boundary = f"sanba-{uuid.uuid4().hex}"
    body = (
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="sanba-analytics.ndjson"\r\n'
            "Content-Type: application/ndjson\r\n\r\n"
        ).encode()
        + ndjson
        + f"\r\n--{boundary}--\r\n".encode()
    )
    request = urllib.request.Request(
        f"{kibana_url.rstrip('/')}/api/saved_objects/_import?overwrite=true",
        data=body,
        method="POST",
        headers={
            "kbn-xsrf": "sanba",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    if api_key:
        request.add_header("Authorization", f"ApiKey {api_key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        result: dict[str, Any] = json.loads(response.read().decode())
    log.info(
        "kibana_import_done",
        success=result.get("success"),
        success_count=result.get("successCount"),
    )
    return result
