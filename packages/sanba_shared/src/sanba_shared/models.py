"""Domain models for interview sessions, shared by agent and api.

Pydantic v2 のモデル。Firestore とのシリアライズは `model_dump(mode="json")` /
`model_validate(dict)` で行う。旧データ (status フィールドが無い要件など) は既定値で
フォールバックする (ADR-0014 §10)。
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


def _now() -> datetime:
    return datetime.now(UTC)


def new_product_id() -> str:
    """product のランダム ID を採番する（連番禁止 / ADR-0031 決定5）。"""
    return f"prod-{secrets.token_urlsafe(9)}"


def new_invite_id() -> str:
    """深掘りリンクのランダム ID を採番する。

    リンク URL の一部になるため product より長い 16 バイト（128 bit）にする。
    推測・列挙への耐性は署名（api 層の HMAC）と二段で持つ（ADR-0031 決定3/5）。
    """
    return f"inv-{secrets.token_urlsafe(16)}"


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


class GitHubIndexStatus(StrEnum):
    """セッションに紐づけた repo の ES 索引状態 (ADR-0028)。

    none: 未紐づけ。pending: キュー投入済み。indexing: 索引中。
    ready: 完了（search_grounding で参照可）。partial: 総量キャップ等で一部のみ。
    failed: 取得/索引に失敗。
    """

    NONE = "none"
    PENDING = "pending"
    INDEXING = "indexing"
    READY = "ready"
    PARTIAL = "partial"
    FAILED = "failed"


class GitHubLink(BaseModel):
    """ユーザーの GitHub App 連携 (`users/{sub}`)。ADR-0028。

    生のアクセストークンは保存しない。installation token は都度 App 秘密鍵から発行する。
    `sub` は Google ID トークンの subject（所有者の検証済み identity）。
    """

    sub: str
    installation_id: int
    github_login: str
    linked_at: datetime = Field(default_factory=_now)


class Product(BaseModel):
    """深掘り対象のアプリ (`products/{id}`)。ADR-0031。

    開発者 / PdM が登録し、セッションが `product_id` で従属する。repo 解決は
    「セッション明示 > product > 環境変数」の優先順（ADR-0027 の解決を一段持ち上げ）。
    所有は `owner_sub` のフラット 1 値（owner / admin の 2 値運用 / ADR-0031 決定4）。
    id は `new_product_id` でランダム採番する（連番禁止 / 決定5）。
    """

    id: str
    name: str = Field(min_length=1)
    description: str = ""
    owner_sub: str
    created_at: datetime = Field(default_factory=_now)
    # 利用者向け語彙（画面名・機能の呼び名）。end_user モードのプロンプトへ機械的に
    # シードする（ADR-0032 決定7）。Stage 1 では保持のみで未使用。
    glossary: list[str] = Field(default_factory=list)

    # ---- 連携 GitHub リポジトリ (ADR-0027 / ADR-0028 を product に持ち上げ) ----
    # 意味は SessionMeta の同名フィールドと同じ。None = 未指定（環境変数フォールバック）、
    # 空文字 = 明示的な「連携しない」、"owner/name" = 選択済み。
    github_repo: str | None = None
    github_branch: str | None = None
    # 索引をピン留めした commit sha（(repo,branch,sha) 共有索引のキー / ADR-0028）。
    github_commit_sha: str | None = None
    github_index_status: GitHubIndexStatus = GitHubIndexStatus.NONE
    github_summary: str | None = None


class InviteScope(StrEnum):
    """深掘りリンクの対象ペルソナ (ADR-0031 / ADR-0032)。

    developer: ログイン済みの開発者 / PdM 向け（Stage 1 で解禁）。
    end_user: 利用者向け。ゲスト入場の解禁は ADR-0032（`guest_join_enabled`）。
    """

    DEVELOPER = "developer"
    END_USER = "end_user"


class ProductInvite(BaseModel):
    """product の深掘りリンク (`products/{id}/invites/{inviteId}`)。ADR-0031 決定3。

    再利用可能なリンクの永続側。URL の署名・組み立ては api 層（`auth.py` の HMAC 基盤）が
    担い、ここは期限・回数・失効の判定材料を持つ。`expires_at` / `max_uses` の None は
    「その制限を掛けない」（失効・もう一方の制限で止める運用を許す）。
    `use_count` の消費は `SessionRepository.consume_invite` でアトミックに行い、
    ここを直接書き換えない。id は `new_invite_id` でランダム採番する（決定5）。
    """

    id: str
    product_id: str
    scope: InviteScope = InviteScope.DEVELOPER
    expires_at: datetime | None = None
    max_uses: int | None = Field(default=None, ge=1)
    use_count: int = Field(default=0, ge=0)
    revoked: bool = False
    created_at: datetime = Field(default_factory=_now)


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

    # ---- product 従属 (ADR-0031) ----
    # 深掘りリンク経由で作られたセッションが従属する product。None = 従来どおりの
    # 単発セッション（旧文書の互換）。repo 解決は「セッション明示 > product > 環境変数」。
    product_id: str | None = None
    # インタビュー・モード（ADR-0032）。リンクの scope から決まり、agent がプロンプト・
    # 語彙・成果物の形式を分岐する。値は InviteScope と同じ語彙（developer / end_user）。
    # 旧文書は既定 developer でフォールバックする。
    interview_mode: str = "developer"

    # ---- 連携 GitHub リポジトリ (ADR-0027 / ADR-0028) ----
    # セッション単位の GitHub リポジトリ（ADR-0027）。02 準備で選択され、grounding 取り込みと
    # 要件→Issue 起票の対象になる。None = 未指定（環境変数へフォールバック / 旧文書の互換）、
    # 空文字 = 明示的な「連携しない」（既定リポジトリにも送らない）、"owner/name" = 選択済み。
    github_repo: str | None = None
    # 以下は GitHub App 連携（ADR-0028）での拡張。owner の App installation が読める repo を
    # 選ぶと branch を確定し ES 索引される。旧文書・connector 選択は既定（None / none）のまま。
    github_branch: str | None = None
    # 索引をピン留めした commit sha（鮮度の基準・(repo,branch,sha) 索引キー）。
    github_commit_sha: str | None = None
    github_index_status: GitHubIndexStatus = GitHubIndexStatus.NONE
    # 索引時に組み立てた repo 要約（名/説明/README先頭/ツリー概要）。agent が初期 instructions に
    # proactive シードする（ADR-0028・retrieval 任せにしない）。索引完了時に書き込む。
    github_summary: str | None = None


class AnalysisResult(BaseModel):
    """Output of the ADK agent team for one analysis pass."""

    summary: str
    open_topics: list[str] = Field(default_factory=list)
    # 触れられているが基準が曖昧な論点（矛盾でも抜けでもない第三類 / #260・ADR-0022）。
    # open_topics（未確認の抜け）と区別し、detection.ambiguous として発火する。
    ambiguous_topics: list[str] = Field(default_factory=list)
    next_question: str
    suggested_answer: str
