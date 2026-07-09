"""セッション分析イベント基盤の中核（ADR-0061）。

会話セッション単位の AI コスト・KPI を扱う純粋ロジック層。単価テーブル（モデル × モダリティ ×
入出力、$/1M tokens）、`usage_metadata` からのトークン抽出、コスト見積り、汎用イベント
エンベロープ（`ai_usage` / `session_summary`）の組み立てを agent / api / worker で共有する。
I/O（構造化ログ・Elasticsearch への index）は `analytics_sink.AnalyticsSink` が担い、
ここはネットワーク・SDK 非依存で単体テスト可能に保つ。

単価は Vertex AI 公式価格表（ADR-0061 出典）に基づく。価格改定時はこのファイルの
`PRICING` だけを更新する。Live API は蓄積文脈の再処理課金があるため床値計算では実課金と
乖離する — 必ず実測 usage（`usageMetadata` / `session_usage_updated`）に単価を掛ける。
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog

log = structlog.get_logger(__name__)

TOKENS_PER_MILLION = 1_000_000

EVENT_AI_USAGE = "ai_usage"
EVENT_SESSION_SUMMARY = "session_summary"

COMPONENT_LIVE_AUDIO = "live_audio"
COMPONENT_ADK_TEAM = "adk_team"
COMPONENT_ANALYSIS = "analysis"
COMPONENT_JUDGE = "judge"
COMPONENT_TITLE = "title"
COMPONENT_SUMMARY = "summary"
COMPONENT_VISION = "vision"
COMPONENT_EMBEDDING = "embedding"


@dataclass(frozen=True)
class TokenUsage:
    """1 回の AI 呼び出し（または Live のターン集計差分）のトークン内訳。"""

    input_tokens: int = 0
    input_text_tokens: int = 0
    input_audio_tokens: int = 0
    input_image_tokens: int = 0
    input_cached_tokens: int = 0
    output_tokens: int = 0
    output_text_tokens: int = 0
    output_audio_tokens: int = 0

    def add(self, other: TokenUsage) -> TokenUsage:
        return TokenUsage(
            **{k: v + getattr(other, k) for k, v in asdict(self).items()},
        )

    @property
    def is_empty(self) -> bool:
        return all(v == 0 for v in asdict(self).values())

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def usage_delta(current: TokenUsage, previous: TokenUsage) -> TokenUsage | None:
    """累積スナップショット間の差分。いずれかが負（= 集計リセット後）なら None。"""
    diff = {k: v - getattr(previous, k) for k, v in asdict(current).items()}
    if any(v < 0 for v in diff.values()):
        return None
    return TokenUsage(**diff)


@dataclass(frozen=True)
class ModelPricing:
    """$/1M tokens。モダリティ単価が未指定(0)の入力トークンは input_text_usd で計上する。"""

    input_text_usd: float
    output_text_usd: float
    input_audio_usd: float = 0.0
    input_image_usd: float = 0.0
    output_audio_usd: float = 0.0


PRICING: dict[str, ModelPricing] = {
    "gemini-live-2.5-flash-native-audio": ModelPricing(
        input_text_usd=0.50,
        output_text_usd=2.00,
        input_audio_usd=3.00,
        input_image_usd=3.00,
        output_audio_usd=12.00,
    ),
    "gemini-2.5-flash": ModelPricing(
        input_text_usd=0.30,
        output_text_usd=2.50,
        input_audio_usd=1.00,
        input_image_usd=0.30,
    ),
    "gemini-embedding-001": ModelPricing(
        input_text_usd=0.15,
        output_text_usd=0.0,
    ),
}


def normalize_model(model: str) -> str:
    name = (model or "").strip()
    if name.startswith("models/"):
        name = name[len("models/") :]
    return name.lower()


def pricing_for(model: str) -> ModelPricing | None:
    return PRICING.get(normalize_model(model))


def _rate(modality_usd: float, fallback_usd: float) -> float:
    return modality_usd if modality_usd > 0 else fallback_usd


def estimate_usd(model: str, usage: TokenUsage) -> float | None:
    """実測トークン × 単価の見積り（USD）。単価表に無いモデルは None。

    モダリティ内訳（text/audio/image）に個別単価を掛け、内訳合計と報告合計の差
    （未分類トークン）はテキスト単価で計上する（過小見積りを避ける安全側）。
    キャッシュ済みトークンは割引せず通常単価のまま計上する（公式のキャッシュ割引率が
    Live API で保証されないため過大側に倒す。実額突合は billing export で行う）。
    """
    pricing = pricing_for(model)
    if pricing is None:
        return None
    input_known = usage.input_text_tokens + usage.input_audio_tokens + usage.input_image_tokens
    input_rest = max(0, usage.input_tokens - input_known)
    output_known = usage.output_text_tokens + usage.output_audio_tokens
    output_rest = max(0, usage.output_tokens - output_known)
    usd = (
        (usage.input_text_tokens + input_rest) * pricing.input_text_usd
        + usage.input_audio_tokens * _rate(pricing.input_audio_usd, pricing.input_text_usd)
        + usage.input_image_tokens * _rate(pricing.input_image_usd, pricing.input_text_usd)
        + (usage.output_text_tokens + output_rest) * pricing.output_text_usd
        + usage.output_audio_tokens * _rate(pricing.output_audio_usd, pricing.output_text_usd)
    ) / TOKENS_PER_MILLION
    return round(usd, 8)


def usd_to_jpy(usd: float, rate: float) -> float:
    return round(usd * rate, 2)


def _modality_name(modality: Any) -> str:
    return str(getattr(modality, "value", modality) or "").upper()


def _count(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _modality_buckets(details: Any) -> tuple[int, int, int]:
    text = audio = image = 0
    for item in details or []:
        count = _count(getattr(item, "token_count", 0))
        name = _modality_name(getattr(item, "modality", ""))
        if name == "TEXT":
            text += count
        elif name == "AUDIO":
            audio += count
        elif name in ("IMAGE", "VIDEO", "DOCUMENT"):
            image += count
        else:
            text += count
    return text, audio, image


def usage_from_genai(usage_metadata: Any) -> TokenUsage:
    """google-genai の `GenerateContentResponseUsageMetadata` からトークン内訳を写し取る。

    思考トークン（`thoughts_token_count`）は出力として課金されるため output に合算する。
    """
    if usage_metadata is None:
        return TokenUsage()
    prompt = _count(getattr(usage_metadata, "prompt_token_count", 0)) + _count(
        getattr(usage_metadata, "tool_use_prompt_token_count", 0)
    )
    thoughts = _count(getattr(usage_metadata, "thoughts_token_count", 0))
    candidates = _count(getattr(usage_metadata, "candidates_token_count", 0))
    in_text, in_audio, in_image = _modality_buckets(
        list(getattr(usage_metadata, "prompt_tokens_details", None) or [])
        + list(getattr(usage_metadata, "tool_use_prompt_tokens_details", None) or [])
    )
    out_text, out_audio, _ = _modality_buckets(
        getattr(usage_metadata, "candidates_tokens_details", None)
    )
    return TokenUsage(
        input_tokens=prompt,
        input_text_tokens=in_text,
        input_audio_tokens=in_audio,
        input_image_tokens=in_image,
        input_cached_tokens=_count(getattr(usage_metadata, "cached_content_token_count", 0)),
        output_tokens=candidates + thoughts,
        output_text_tokens=out_text + thoughts,
        output_audio_tokens=out_audio,
    )


def usage_from_model_usage(model_usage: Any) -> TokenUsage:
    """livekit-agents の `LLMModelUsage`（累積）からトークン内訳を写し取る。"""

    def get(name: str) -> int:
        return _count(getattr(model_usage, name, 0))

    return TokenUsage(
        input_tokens=get("input_tokens"),
        input_text_tokens=get("input_text_tokens"),
        input_audio_tokens=get("input_audio_tokens"),
        input_image_tokens=get("input_image_tokens"),
        input_cached_tokens=get("input_cached_tokens"),
        output_tokens=get("output_tokens"),
        output_text_tokens=get("output_text_tokens"),
        output_audio_tokens=get("output_audio_tokens"),
    )


def estimated_embedding_tokens(text: str) -> int:
    return max(1, len(text) // 4) if text else 0


_LABEL_UNSAFE = re.compile(r"[^a-z0-9_-]")


def _sanitize_label(value: str) -> str:
    return _LABEL_UNSAFE.sub("-", value.strip().lower())[:63]


def vertex_billing_labels(
    session_id: str, product_id: str | None, *, use_vertexai: bool
) -> dict[str, str] | None:
    """`generateContent` 系に付与する billing ラベル。Vertex 経路以外は None（付与不可）。"""
    if not use_vertexai or not session_id:
        return None
    labels = {"session_id": _sanitize_label(session_id)}
    if product_id:
        labels["product_id"] = _sanitize_label(product_id)
    return labels


def build_event(
    *,
    event_type: str,
    session_id: str,
    product_id: str | None,
    interview_mode: str | None,
    payload: dict[str, Any],
    occurred_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "session_id": session_id,
        "product_id": product_id,
        "interview_mode": interview_mode,
        "occurred_at": (occurred_at or datetime.now(UTC)).isoformat(),
        "payload": payload,
    }


def build_ai_usage_payload(
    *, component: str, model: str, usage: TokenUsage, requests: int = 1
) -> dict[str, Any]:
    estimated = estimate_usd(model, usage)
    if estimated is None:
        log.warning("ai_usage_pricing_unknown", model=normalize_model(model))
    return {
        "component": component,
        "model": normalize_model(model),
        "tokens": usage.as_dict(),
        "estimated_usd": estimated if estimated is not None else 0.0,
        "pricing_known": estimated is not None,
        "requests": requests,
    }


@dataclass(frozen=True)
class LiveKitRates:
    """LiveKit Cloud の分数課金の推定単価（$/分）。実額は LiveKit 請求で確認する。"""

    connection_usd_per_min: float = 0.0005
    agent_session_usd_per_min: float = 0.01
    noise_cancellation_usd_per_min: float = 0.005


def estimate_livekit_usd(
    minutes: float,
    *,
    participants: int = 2,
    noise_cancellation: bool = True,
    rates: LiveKitRates | None = None,
) -> dict[str, Any]:
    rates = rates or LiveKitRates()
    minutes = max(0.0, minutes)
    connection_usd = minutes * participants * rates.connection_usd_per_min
    agent_usd = minutes * rates.agent_session_usd_per_min
    krisp_usd = minutes * rates.noise_cancellation_usd_per_min if noise_cancellation else 0.0
    total = connection_usd + agent_usd + krisp_usd
    return {
        "minutes": round(minutes, 2),
        "assumed_participants": participants,
        "connection_usd": round(connection_usd, 6),
        "agent_session_usd": round(agent_usd, 6),
        "noise_cancellation_usd": round(krisp_usd, 6),
        "estimated_usd": round(total, 6),
    }


def build_session_summary_payload(
    *,
    components: Mapping[str, Mapping[str, Any]],
    livekit: Mapping[str, Any] | None,
    kpi: Mapping[str, Any],
    usd_jpy_rate: float,
) -> dict[str, Any]:
    """セッション終了時の `session_summary` payload（コスト合計 × KPI の同一ドキュメント結合）。

    `components` は component 名 → {usd, input_tokens, output_tokens, requests}
    （Firestore `ai_cost.components` と同形）。効率指標（承認要件 1 件あたりコスト等）は
    分母が正のときだけ載せる。
    """
    ai_usd = round(sum(float(c.get("usd", 0.0)) for c in components.values()), 8)
    livekit_usd = float(livekit.get("estimated_usd", 0.0)) if livekit else 0.0
    total_usd = round(ai_usd + livekit_usd, 8)
    payload: dict[str, Any] = {
        "components": {name: dict(c) for name, c in components.items()},
        "ai_usd": ai_usd,
        "livekit": dict(livekit) if livekit else None,
        "total_usd": total_usd,
        "total_jpy": usd_to_jpy(total_usd, usd_jpy_rate),
        "usd_jpy_rate": usd_jpy_rate,
        "kpi": dict(kpi),
    }
    efficiency: dict[str, float] = {}
    finalized = _count(kpi.get("finalized_count"))
    if finalized > 0:
        efficiency["usd_per_finalized_requirement"] = round(total_usd / finalized, 8)
    resolved = _count((kpi.get("inquiry") or {}).get("resolved_total"))
    if resolved > 0:
        efficiency["usd_per_resolved_inquiry"] = round(total_usd / resolved, 8)
    payload["efficiency"] = efficiency
    return payload


class EventSink(Protocol):
    def emit(self, event: dict[str, Any]) -> None: ...


class UsageRecorder:
    """session/product 文脈を束ねて `ai_usage` イベントを排出する薄いバインダ。

    排出は fail-soft: 記録の失敗が AI 呼び出し本体へ波及しない。`on_record` には
    Firestore へのコスト加算（`SessionRepository.add_session_ai_cost`）等を注入できる。
    """

    def __init__(
        self,
        sink: EventSink,
        session_id: str,
        *,
        product_id: str | None = None,
        interview_mode: str | None = None,
        on_record: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> None:
        self._sink = sink
        self._session_id = session_id
        self._product_id = product_id
        self._interview_mode = interview_mode
        self._on_record = on_record

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def product_id(self) -> str | None:
        return self._product_id

    @property
    def interview_mode(self) -> str | None:
        return self._interview_mode

    def set_context(
        self, *, product_id: str | None = None, interview_mode: str | None = None
    ) -> None:
        if product_id is not None:
            self._product_id = product_id
        if interview_mode is not None:
            self._interview_mode = interview_mode

    def record(self, component: str, model: str, usage: TokenUsage, *, requests: int = 1) -> None:
        if usage.is_empty:
            return
        try:
            payload = build_ai_usage_payload(
                component=component, model=model, usage=usage, requests=requests
            )
            self._sink.emit(
                build_event(
                    event_type=EVENT_AI_USAGE,
                    session_id=self._session_id,
                    product_id=self._product_id,
                    interview_mode=self._interview_mode,
                    payload=payload,
                )
            )
            if self._on_record is not None:
                self._on_record(component, payload)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "analytics_record_failed",
                session=self._session_id,
                component=component,
                error=str(exc),
            )
