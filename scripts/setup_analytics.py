"""sanba-analytics（ADR-0061）の Elasticsearch / Kibana を冪等セットアップする ops スクリプト。

`just analytics-setup` から実行する。ロジック本体は `sanba_shared.analytics_setup`
（単体テスト済み）にあり、ここは環境変数の読み取りとクライアント生成だけを担う。

環境変数:
  ELASTICSEARCH_URL / ELASTICSEARCH_API_KEY  … 対象クラスタ（必須 / key は任意）
  ANALYTICS_RETENTION_DAYS                   … ILM の削除期限（既定 365）
  KIBANA_URL / KIBANA_API_KEY                … 指定時のみダッシュボード ndjson を import
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

KIBANA_NDJSON = (
    Path(__file__).parent.parent / "infra/observability/kibana/sanba-analytics.ndjson"
)


def main() -> int:
    es_url = os.environ.get("ELASTICSEARCH_URL", "")
    if not es_url:
        print("ELASTICSEARCH_URL is required", file=sys.stderr)
        return 1
    from elasticsearch import Elasticsearch
    from sanba_shared.analytics_setup import (
        DEFAULT_ANALYTICS_RETENTION_DAYS,
        import_kibana_saved_objects,
        is_serverless,
        setup_analytics,
    )

    kwargs: dict[str, object] = {"hosts": [es_url]}
    api_key = os.environ.get("ELASTICSEARCH_API_KEY", "")
    if api_key:
        kwargs["api_key"] = api_key
    client = Elasticsearch(**kwargs)  # type: ignore[arg-type]
    retention_days = int(
        os.environ.get(
            "ANALYTICS_RETENTION_DAYS", str(DEFAULT_ANALYTICS_RETENTION_DAYS)
        )
    )
    serverless = is_serverless(client)
    setup_analytics(client, retention_days=retention_days)
    retention_desc = (
        f"data stream lifecycle({retention_days}d)"
        if serverless
        else f"ILM({retention_days}d)"
    )
    print(
        f"elasticsearch: analytics data stream / {retention_desc} / pricing index ready"
    )

    kibana_url = os.environ.get("KIBANA_URL", "")
    if kibana_url:
        result = import_kibana_saved_objects(
            kibana_url,
            KIBANA_NDJSON.read_bytes(),
            api_key=os.environ.get("KIBANA_API_KEY", ""),
        )
        print(f"kibana: imported dashboard (success={result.get('success')})")
    else:
        print("kibana: skipped (KIBANA_URL not set)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
