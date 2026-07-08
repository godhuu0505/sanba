"""Domain models for interview sessions, shared by agent and api.

Pydantic v2 のモデル。Firestore とのシリアライズは `model_dump(mode="json")` /
`model_validate(dict)` で行う。旧データ (status フィールドが無い要件など) は既定値で
フォールバックする (ADR-0014 §10)。
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field, field_validator


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


def new_member_invite_id() -> str:
    """メンバー招待のランダム ID を採番する（ADR-0036）。

    招待 URL の一部になるため深掘りリンクと同じ 16 バイト（128 bit）。
    推測・列挙への耐性は署名（api 層の HMAC）と二段で持つ（ADR-0031 決定5 と同方針）。
    """
    return f"minv-{secrets.token_urlsafe(16)}"


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
    citations: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_now)

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


class Audience(StrEnum):
    """要件結果ドキュメントの読み手（出力フォーマットの選択キー）。

    利用者（end_user）・企画者（planner）・開発者（developer）の 3 値。
    `InviteScope`（インタビューの相手 2 値）とは軸が別: こちらは**成果物を誰向けの
    体裁で出すか**であり、1 セッションの結果を 3 通りに切り替えて閲覧できる。
    """

    END_USER = "end_user"
    PLANNER = "planner"
    DEVELOPER = "developer"


MAX_CHECK_ITEMS = 10


class CheckItem(BaseModel):
    """要件サンバ中に必ず確認する項目 1 件（ADR-0043）。

    `target` は対象ペルソナ（Audience）。None = 全員（どのセッションにもシードし、
    どの読み手の結果ドキュメントにも載せる）。旧文書（str のリスト）は Product の
    validator が `{text, target=None}` に平す（ADR-0014 §10 と同じ互換方針）。
    """

    text: str
    target: Audience | None = None


def check_items_for_scope(items: list[CheckItem], scope: InviteScope) -> list[str]:
    """インタビューモードでシードする確認項目を絞り込む（ADR-0043 決定2）。

    end_user セッション: 全員 + 利用者向け。
    developer セッション: 全員 + 企画者向け + 開発者向け（企画者向けの独立した
    インタビューモードは未導入のため、当面 developer モードに合流する）。
    """
    if scope is InviteScope.END_USER:
        allowed = {None, Audience.END_USER}
    else:
        allowed = {None, Audience.PLANNER, Audience.DEVELOPER}
    return [c.text for c in items if c.target in allowed]


def check_items_for_audience(items: list[CheckItem], audience: Audience) -> list[str]:
    """結果ドキュメント（読み手 = audience）に載せる確認項目を絞り込む（全員 + 対象一致）。"""
    return [c.text for c in items if c.target is None or c.target is audience]


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
    slug: str | None = None
    created_at: datetime = Field(default_factory=_now)
    glossary: list[str] = Field(default_factory=list)

    output_formats: dict[Audience, str] = Field(default_factory=dict)
    check_items: list[CheckItem] = Field(default_factory=list)

    @field_validator("check_items", mode="before")
    @classmethod
    def _coerce_legacy_check_items(cls, value: object) -> object:
        """旧文書の `list[str]`（対象タグ導入前）を `{text, target=None}` に平す。"""
        if isinstance(value, list):
            return [{"text": item} if isinstance(item, str) else item for item in value]
        return value

    github_repo: str | None = None
    github_branch: str | None = None
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
    join_window_start: datetime | None = None
    join_window_count: int = Field(default=0, ge=0)


class ProductMember(BaseModel):
    """product のメンバー (`product_members/{product_id}__{sub}`)。ADR-0036 決定1。

    メンバー = その product で要件サンバ（product 従属セッションの作成・product の閲覧）が
    できる人。owner はこのコレクションに入れない（`Product.owner_sub` が単一の正のまま）。
    ロール列挙は導入しない（owner / member の 2 値 + 既存 admin。ADR-0031 決定4 の最小方針を
    維持し、editors 等の細分は需要が出てから別 ADR で扱う）。
    トップレベルコレクションにするのは「sub → 所属 product 一覧」の横断クエリのため
    （サブコレクションだと collection group index の運用が要る）。
    """

    product_id: str
    sub: str
    email: str
    display_name: str = ""
    invited_by_sub: str = ""
    created_at: datetime = Field(default_factory=_now)


class MemberInviteStatus(StrEnum):
    """メンバー招待の状態 (ADR-0036 決定2)。

    pending: 応答待ち。accepted: 承諾（メンバー化済み）。declined: 辞退。
    revoked: 発行者が取り消し。期限切れは `expires_at` からの導出（状態には持たない）。
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    REVOKED = "revoked"


class ProductMemberInvite(BaseModel):
    """メンバー招待 (`member_invites/{id}`)。ADR-0036 決定2。

    メールアドレス宛の 1 回限りの招待。深掘りリンク（ProductInvite = 再利用可能な入場券）と
    違い、承諾するとメンバーシップという永続権限になるため、宛先 email に束縛し
    承諾時に検証済み identity の email と照合する（URL の転送で第三者が承諾できない）。
    URL の署名・組み立ては api 層（`auth.py` の HMAC 基盤）が担い、状態の正はこの文書。
    状態遷移（pending → accepted/declined/revoked）は
    `SessionRepository.respond_member_invite` / `revoke_member_invite` でアトミックに行う。
    `email` は小文字正規化して保存する（照合も小文字同士）。
    """

    id: str
    product_id: str
    email: str
    invited_by_sub: str = ""
    invited_by_email: str = ""
    status: MemberInviteStatus = MemberInviteStatus.PENDING
    created_at: datetime = Field(default_factory=_now)
    expires_at: datetime | None = None
    responded_at: datetime | None = None
    accepted_sub: str | None = None


class Utterance(BaseModel):
    speaker: str
    text: str
    ts: datetime = Field(default_factory=_now)


DEFAULT_SESSION_TITLE = "要件インタビュー"


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
    goal: str | None = None
    goal_detail: str | None = None
    status: str = "active"
    created_at: datetime = Field(default_factory=_now)
    finalized_at: datetime | None = None
    finalized_count: int | None = None
    finalized_requirement_ids: list[str] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)
    exported_issue_url: str | None = None

    product_id: str | None = None
    interview_mode: InviteScope = InviteScope.DEVELOPER

    github_repo: str | None = None
    github_branch: str | None = None
    github_commit_sha: str | None = None
    github_index_status: GitHubIndexStatus = GitHubIndexStatus.NONE
    github_summary: str | None = None


class AnalysisResult(BaseModel):
    """Output of the ADK agent team for one analysis pass."""

    summary: str
    open_topics: list[str] = Field(default_factory=list)
    ambiguous_topics: list[str] = Field(default_factory=list)
    next_question: str
    suggested_answer: str
