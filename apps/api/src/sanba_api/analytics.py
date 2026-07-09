"""api の分析イベント排出（ADR-0061）。

共有の `AnalyticsSink` / `UsageRecorder` を api の settings に束ねる薄いアダプタ。
api の AI 呼び出し（タイトル・要約・画像解析・埋め込み）は agent と別プロセスで走るため、
`ai_usage` イベントの排出と同時に `sessions/{id}.ai_cost` へ `Increment` で都度加算し、
agent がセッション終了時に組み立てる `session_summary` に合流させる。
"""

from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache
from typing import Any

import structlog
from sanba_shared.analytics import (
    COMPONENT_EMBEDDING,
    TokenUsage,
    UsageRecorder,
    vertex_billing_labels,
)
from sanba_shared.analytics_sink import AnalyticsConfig, AnalyticsSink
from sanba_shared.repository import SessionRepository

from .config import settings

log = structlog.get_logger(__name__)


@lru_cache(maxsize=1)
def analytics_sink() -> AnalyticsSink:
    return AnalyticsSink(
        AnalyticsConfig(
            elasticsearch_url=settings.elasticsearch_url,
            elasticsearch_api_key=settings.elasticsearch_api_key,
        )
    )


def usage_recorder(
    session_id: str,
    *,
    repo: SessionRepository,
    product_id: str | None = None,
    interview_mode: str | None = None,
) -> UsageRecorder:
    def _increment(component: str, payload: dict[str, Any]) -> None:
        tokens = payload.get("tokens", {})
        repo.add_session_ai_cost(
            session_id,
            component=component,
            usd=float(payload.get("estimated_usd", 0.0)),
            input_tokens=int(tokens.get("input_tokens", 0)),
            output_tokens=int(tokens.get("output_tokens", 0)),
            requests=int(payload.get("requests", 1)),
        )

    return UsageRecorder(
        analytics_sink(),
        session_id,
        product_id=product_id,
        interview_mode=interview_mode,
        on_record=_increment,
    )


def session_recorder(session_id: str, repo: SessionRepository) -> UsageRecorder:
    """セッションメタから文脈（product_id / interview_mode）を引いた recorder を作る。

    メタ読み取りの失敗は文脈なし recorder に倒し、呼び出し側の本処理を止めない。
    """
    meta = None
    try:
        meta = repo.get_session(session_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("analytics_recorder_meta_failed", session=session_id, error=str(exc))
    return usage_recorder(
        session_id,
        repo=repo,
        product_id=meta.product_id if meta is not None else None,
        interview_mode=meta.interview_mode.value if meta is not None else None,
    )


def scope_recorder(scope_id: str, *, product_id: str | None = None) -> UsageRecorder:
    """セッション文書を持たないスコープ（product 前提素材の索引等）用の recorder。

    Firestore への加算先が無いため `on_record` を持たず、`ai_usage` イベントの排出
    （ログ + ES）だけを行う。grounding の索引スコープ id をそのまま `session_id` に使う
    （ADR-0028: product スコープは `session_id=product_id` で索引される規約と同じ）。
    """
    return UsageRecorder(analytics_sink(), scope_id, product_id=product_id)


def embedding_hook(recorder: UsageRecorder) -> Callable[[TokenUsage], None]:
    def _hook(usage: TokenUsage) -> None:
        recorder.record(COMPONENT_EMBEDDING, settings.gemini_embed_model, usage)

    return _hook


def billing_labels(session_id: str, product_id: str | None = None) -> dict[str, str] | None:
    return vertex_billing_labels(
        session_id, product_id, use_vertexai=settings.google_genai_use_vertexai
    )
