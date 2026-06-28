"""Domain models for interview sessions, shared by agent and api.

Pydantic v2 のモデル。Firestore とのシリアライズは `model_dump(mode="json")` /
`model_validate(dict)` で行う。旧データ (status フィールドが無い要件など) は既定値で
フォールバックする (ADR-0014 §10)。
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


def _now() -> datetime:
    return datetime.now(UTC)


class RequirementCategory(StrEnum):
    FUNCTIONAL = "functional"
    NON_FUNCTIONAL = "non_functional"
    CONSTRAINT = "constraint"
    SCOPE = "scope"
    OPEN_QUESTION = "open_question"


class Priority(StrEnum):
    MUST = "must"
    SHOULD = "should"
    COULD = "could"
    WONT = "wont"


class RequirementStatus(StrEnum):
    """要件のレビュー状態 (ADR-0014 §10)。

    draft: AI が生成した未確認の下書き。30 日 TTL の対象。
    approved: 人間が承認した成果物。TTL を解除して保全する (§11)。
    rejected: 却下。TTL は維持し自動削除に任せる。
    """

    DRAFT = "draft"
    APPROVED = "approved"
    REJECTED = "rejected"


class Requirement(BaseModel):
    """A single confirmed (or candidate) requirement.

    `status` 欠落の旧文書を読み込むと既定 `draft` でフォールバックする。
    出所メタ (`id` / `created_at` / `source_speaker` / `confidence`) は人手で
    書き換えない (ADR-0008 / ADR-0014 §10)。
    """

    id: str
    category: RequirementCategory
    statement: str
    priority: Priority = Priority.SHOULD
    source_speaker: str | None = None
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    # 根拠となった発話 id（"u3" 等。transcript.* / detection.refs と同じ id 空間）。
    # 契約 §3 の citations:[{kind, ref}] へ整形して web に送る（要件カードの引用表示）。
    citations: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_now)

    # ---- レビュー状態 (ADR-0014) ----
    status: RequirementStatus = RequirementStatus.DRAFT
    approved_by: str | None = None
    approved_at: datetime | None = None


class Utterance(BaseModel):
    speaker: str
    text: str
    ts: datetime = Field(default_factory=_now)


class SessionMeta(BaseModel):
    """インタビューセッションのメタ文書 (`sessions/{id}`)。

    create 時に API が作成し、管理画面の一覧/閲覧/承認がこれを読む (ADR-0014 §4)。
    所有者はクエリしやすいようフラットに持つ (owner_sub / owner_email)。
    """

    id: str
    title: str
    owner_sub: str
    owner_email: str
    roles: list[str] = Field(default_factory=list)
    # active → finalized（07 判定で参加者が要件を確定したとき / #186）。
    status: str = "active"
    created_at: datetime = Field(default_factory=_now)
    # 確定スナップショットの刻と件数（#186）。未確定なら None。
    finalized_at: datetime | None = None
    finalized_count: int | None = None
    # 確定時点の要件 ID の不可逆スナップショット（#213）。finalize 後に要件が増減/却下
    # されても export はこの集合に固定して起票する。旧文書は既定 [] でフォールバック。
    finalized_requirement_ids: list[str] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    """Output of the ADK agent team for one analysis pass."""

    summary: str
    open_topics: list[str] = Field(default_factory=list)
    next_question: str
    suggested_answer: str
