"""Firestore-backed persistence for sessions, utterances and requirements.

Stateless workers + external state => Cloud Run friendly (see docs/architecture.md §1).
Falls back to an in-memory store when Firestore is unavailable (e.g. unit tests).

このパッケージはアプリ config に依存しない: リテンション日数は `SessionRepository` の
コンストラクタ引数で受け取る (agent と api が別 settings を持つため / ADR-0014 §8)。
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog

from .models import (
    GitHubIndexStatus,
    GitHubLink,
    Product,
    ProductInvite,
    Requirement,
    RequirementStatus,
    SessionMeta,
    Utterance,
)
from .pii import mask_pii

log = structlog.get_logger(__name__)

# 上書き可能な要件フィールド (ADR-0014 §10)。出所メタ (id/created_at/source_speaker/
# confidence) はここに含めない = 人手で書き換えない。
EDITABLE_REQUIREMENT_FIELDS = frozenset({"statement", "priority", "category"})


class RequirementNotFound(Exception):
    """対象の要件が存在しないときに送出。"""


class ProductNotFound(Exception):
    """対象の product が存在しないときに送出 (ADR-0031)。"""


class InviteNotFound(Exception):
    """対象の深掘りリンクが存在しないときに送出 (ADR-0031)。"""


class InviteNotUsable(Exception):
    """深掘りリンクが失効・期限切れ・上限到達で使えないときに送出 (ADR-0031 決定3)。

    `reason` は "revoked" / "expired" / "exhausted"。api 層がエラー表示の出し分けに使う。
    どの理由でも `use_count` は消費しない。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class InviteRateLimited(Exception):
    """深掘りリンク単位のセッション作成レートが上限に達したときに送出 (ADR-0032 決定5)。

    InviteNotUsable と分ける: リンク自体は有効（403 ではなく 429 を返す）で、
    ウィンドウが明ければ再び使える。`use_count` は消費しない。"""


class SessionRepository:
    """Persistence boundary. Swap the backend without touching agent/api logic."""

    def __init__(self, data_retention_days: int = 30, mask_pii_before_persist: bool = True) -> None:
        self._retention_days = data_retention_days
        # 発話を永続化する前に PII をマスクするか（issue #10 / mask_pii_before_index）。
        # ドメイン層は app config に依存しないので、呼び出し側 (agent/api) が注入する。
        self._mask_pii = mask_pii_before_persist
        self._client = self._init_client()
        # In-memory fallback used when Firestore is not configured.
        self._mem_sessions: dict[str, SessionMeta] = {}
        self._mem_utterances: dict[str, list[Utterance]] = {}
        self._mem_requirements: dict[str, dict[str, Requirement]] = {}
        # 検知 (矛盾/抜け) と適用済み最大 seq (#94/#100)。ハイドレーションの土台。
        self._mem_detections: dict[str, dict[str, dict[str, Any]]] = {}
        self._mem_seq: dict[str, int] = {}
        # lossy（status/transcript.partial）の epoch（再起動ごとに +1 / #270・ADR-0021）。
        # 起動時にここから lossy_seq の開始基底を払い出し、再起動を跨いで lossy_seq を
        # 大域的に単調増加させる（接続維持中の web が再起動後の lossy を黙殺しないように）。
        self._mem_lossy_epoch: dict[str, int] = {}
        # 投入済み素材のメタ (#184)。GET context/files の復元に使う。プロセス内に閉じず外部
        # ストアへ永続化することで、多インスタンス/再起動後のリロード/途中参加でも復元できる。
        self._mem_materials: dict[str, dict[str, dict[str, Any]]] = {}
        # 現在の未回答質問の単一ポインタ (#212 / ADR-0020)。最新1問モデルなのでセッション
        # ごとに 1 ドキュメント。tombstone（cleared）も含めて保持し GET で cleared_seq を返す。
        self._mem_questions: dict[str, dict[str, Any]] = {}
        # ユーザーの GitHub App 連携 (`users/{sub}` / ADR-0028)。sub -> GitHubLink。
        self._mem_github_links: dict[str, GitHubLink] = {}
        # product と深掘りリンク (ADR-0031)。product_id -> Product / invite_id -> ProductInvite。
        self._mem_products: dict[str, Product] = {}
        self._mem_invites: dict[str, dict[str, ProductInvite]] = {}
        # in-memory での invite 消費をアトミックにするためのロック（Firestore 経路は
        # トランザクションが担う。consume_invite の read-check-increment を直列化する）。
        self._mem_invite_lock = threading.Lock()

    @staticmethod
    def _init_client():  # type: ignore[no-untyped-def]
        try:
            from google.cloud import firestore

            return firestore.Client()
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("firestore_unavailable_using_memory", error=str(exc))
            return None

    def _expire_at(self) -> datetime | None:
        """Retention deadline for stored data (issue #10). None = keep indefinitely.

        Firestore deletes documents whose `expireAt` field is in the past, once a TTL
        policy is enabled on that field (see infra/terraform + docs/security.md).
        """
        days = self._retention_days
        return datetime.now(UTC) + timedelta(days=days) if days > 0 else None

    # ---- Sessions (ADR-0014 §4) -------------------------------------------
    def create_session_doc(self, meta: SessionMeta, *, apply_ttl: bool = False) -> None:
        """`sessions/{id}` 文書を作成する。一覧/閲覧/承認の土台になる。

        `apply_ttl=True` はゲスト作成セッション（ADR-0032 / FR-2.7）用: セッション文書
        そのものに 30 日 TTL（expireAt）を張り、同意文言の保持期間の約束をメタ文書にも
        効かせる。ログイン済みセッションは従来どおり張らない（「過去の要件を見る」履歴と
        finalize 済み資産のアンカーであり、消えると承認済み要件が辿れなくなるため）。
        in-memory fallback は TTL 掃除を持たない（テスト/ローカル用途のため許容）。
        """
        if self._client is not None:
            doc = meta.model_dump(mode="json")
            if apply_ttl and (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            self._client.collection("sessions").document(meta.id).set(doc)
            return
        self._mem_sessions[meta.id] = meta

    def list_sessions(self) -> list[SessionMeta]:
        """全セッションのメタ一覧 (MVP: ページングなし / ADR-0014 保留事項)。"""
        if self._client is not None:
            docs = self._client.collection("sessions").stream()
            return [SessionMeta.model_validate(d.to_dict()) for d in docs]
        return list(self._mem_sessions.values())

    def list_sessions_by_owner(self, owner_sub: str) -> list[SessionMeta]:
        """呼び出しユーザー本人 (owner_sub) のセッションだけを新しい順で返す (#250)。

        ホームの「過去の要件を見る」履歴リスト (#215) の供給元。認可は本人限定なので、
        `list_sessions` の全件ではなく owner_sub で必ず絞る。Firestore は owner_sub の
        等価クエリ、in-memory はフィルタで同じ意味にする。並びは created_at 降順 (新しい
        ものを上に)。複合インデックス不要なよう order_by は使わずアプリ側で整列する。
        """
        if self._client is not None:
            from google.cloud.firestore_v1.base_query import FieldFilter

            docs = (
                self._client.collection("sessions")
                .where(filter=FieldFilter("owner_sub", "==", owner_sub))
                .stream()
            )
            sessions = [SessionMeta.model_validate(d.to_dict()) for d in docs]
        else:
            sessions = [m for m in self._mem_sessions.values() if m.owner_sub == owner_sub]
        return sorted(sessions, key=lambda m: m.created_at, reverse=True)

    def get_session(self, session_id: str) -> SessionMeta | None:
        if self._client is not None:
            snap = self._client.collection("sessions").document(session_id).get()
            return SessionMeta.model_validate(snap.to_dict()) if snap.exists else None
        return self._mem_sessions.get(session_id)

    def finalize_session(
        self,
        session_id: str,
        *,
        confirmed_count: int,
        finalized_requirement_ids: list[str],
    ) -> SessionMeta | None:
        """07 判定の「確定」を永続化する（#186 / #213）。

        セッションを finalized にし、確定した要件件数・確定時の要件 ID 集合・刻を刻む。
        存在しなければ None。要件そのものの承認（draft→approved / TTL 解除）はここでは
        触れず、呼び出し側（API の finalize エンドポイント）が set_requirement_status で
        行う。確定スナップショットはあくまでセッション単位の不可逆マーカ。
        `finalized_requirement_ids` は export が固定集合を起票する土台（#213）。
        """
        meta = self.get_session(session_id)
        if meta is None:
            return None
        # 不可逆マーカ: 既に finalized なら最初のスナップショット（件数・ID集合・刻）を保持
        # して返す（Codex P2）。確定後に要件が増減/二重 POST されても初回確定値を変えない。
        if meta.status == "finalized":
            return meta
        snapshot_ids = list(finalized_requirement_ids)
        updated = meta.model_copy(
            update={
                "status": "finalized",
                "finalized_at": datetime.now(UTC),
                "finalized_count": confirmed_count,
                "finalized_requirement_ids": snapshot_ids,
            }
        )
        if self._client is not None:
            self._client.collection("sessions").document(session_id).set(
                {
                    "status": "finalized",
                    "finalized_at": updated.finalized_at,
                    "finalized_count": confirmed_count,
                    "finalized_requirement_ids": snapshot_ids,
                },
                merge=True,
            )
        else:
            self._mem_sessions[session_id] = updated
        return updated

    def set_session_github(
        self,
        session_id: str,
        *,
        repo: str | None,
        branch: str | None,
        commit_sha: str | None,
        index_status: GitHubIndexStatus,
        summary: str | None = None,
    ) -> SessionMeta | None:
        """セッションに紐づけた GitHub repo/branch/sha/索引状態/要約を保存する (ADR-0028)。

        agent は `SessionMeta` を読んで要約をシードし、web は状態表示・進捗に使う。
        存在しなければ None。merge 保存で他フィールド（要件確定スナップショット等）を温存する。
        """
        meta = self.get_session(session_id)
        if meta is None:
            return None
        updated = meta.model_copy(
            update={
                "github_repo": repo,
                "github_branch": branch,
                "github_commit_sha": commit_sha,
                "github_index_status": index_status,
                "github_summary": summary,
            }
        )
        if self._client is not None:
            self._client.collection("sessions").document(session_id).set(
                {
                    "github_repo": repo,
                    "github_branch": branch,
                    "github_commit_sha": commit_sha,
                    "github_index_status": index_status.value,
                    "github_summary": summary,
                },
                merge=True,
            )
        else:
            self._mem_sessions[session_id] = updated
        return updated

    # ---- User GitHub link (`users/{sub}` / ADR-0028) -----------------------
    def get_github_link(self, sub: str) -> GitHubLink | None:
        """ユーザー (Google sub) の GitHub App 連携を取得する。未連携なら None。"""
        if self._client is not None:
            snap = self._client.collection("users").document(sub).get()
            if not snap.exists:
                return None
            data = snap.to_dict() or {}
            github = data.get("github")
            return GitHubLink.model_validate(github) if github else None
        return self._mem_github_links.get(sub)

    def set_github_link(self, link: GitHubLink) -> None:
        """ユーザーの GitHub App 連携を upsert する。生トークンは保存しない (ADR-0028)。"""
        if self._client is not None:
            self._client.collection("users").document(link.sub).set(
                {"github": link.model_dump(mode="json")}, merge=True
            )
            return
        self._mem_github_links[link.sub] = link

    def delete_github_link(self, sub: str) -> bool:
        """連携解除: `users/{sub}` の installation 記録のみ削除する (ADR-0028)。

        共有 (repo,branch,sha) 索引は他 installation が参照し得るため消さない。
        記録があれば True（冪等: 無くても安全に False）。
        """
        if self._client is not None:
            from google.cloud import firestore

            ref = self._client.collection("users").document(sub)
            snap = ref.get()
            if not snap.exists or not (snap.to_dict() or {}).get("github"):
                return False
            ref.set({"github": firestore.DELETE_FIELD}, merge=True)
            return True
        return self._mem_github_links.pop(sub, None) is not None

    # ---- Products (ADR-0031) -----------------------------------------------
    def create_product(self, product: Product) -> None:
        """`products/{id}` 文書を作成する。所有・repo 紐づけ・深掘りリンクの土台。

        product は owner が明示的に削除するまで残す運用資産なので、発話や draft 要件と
        違い TTL（expireAt）は付けない（ADR-0031 影響節）。
        """
        if self._client is not None:
            self._client.collection("products").document(product.id).set(
                product.model_dump(mode="json")
            )
            return
        self._mem_products[product.id] = product

    def get_product(self, product_id: str) -> Product | None:
        if self._client is not None:
            snap = self._client.collection("products").document(product_id).get()
            return Product.model_validate(snap.to_dict()) if snap.exists else None
        return self._mem_products.get(product_id)

    def list_products_by_owner(self, owner_sub: str) -> list[Product]:
        """呼び出しユーザー本人 (owner_sub) の product を新しい順で返す。

        `list_sessions_by_owner` と同じ意味論: Firestore は等価クエリ、in-memory は
        フィルタ。複合インデックス不要なよう order_by は使わずアプリ側で整列する。
        """
        if self._client is not None:
            from google.cloud.firestore_v1.base_query import FieldFilter

            docs = (
                self._client.collection("products")
                .where(filter=FieldFilter("owner_sub", "==", owner_sub))
                .stream()
            )
            products = [Product.model_validate(d.to_dict()) for d in docs]
        else:
            products = [p for p in self._mem_products.values() if p.owner_sub == owner_sub]
        return sorted(products, key=lambda p: p.created_at, reverse=True)

    def update_product(
        self,
        product_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        glossary: list[str] | None = None,
    ) -> Product:
        """name / description / glossary のみ上書きする。

        所有と出所 (owner_sub / created_at) は不変。repo 紐づけは `set_product_github` が
        担う（`update_requirement` と同じ「編集可能フィールドを閉じる」パターン）。
        """
        current = self.get_product(product_id)
        if current is None:
            raise ProductNotFound(product_id)
        updates: dict[str, object] = {}
        if name is not None:
            updates["name"] = name
        if description is not None:
            updates["description"] = description
        if glossary is not None:
            updates["glossary"] = list(glossary)
        if not updates:
            return current
        # dict に適用してから検証する（name 空などの不正値検出を一度で行う）。
        data = current.model_dump()
        data.update(updates)
        updated = Product.model_validate(data)

        if self._client is not None:
            # github_* などの並行更新を巻き戻さないよう、編集対象フィールドのみ patch する。
            self._client.collection("products").document(product_id).set(updates, merge=True)
        else:
            self._mem_products[product_id] = updated
        return updated

    def set_product_github(
        self,
        product_id: str,
        *,
        repo: str | None,
        branch: str | None,
        commit_sha: str | None,
        index_status: GitHubIndexStatus,
        summary: str | None = None,
    ) -> Product | None:
        """product に紐づけた GitHub repo/branch/sha/索引状態/要約を保存する (ADR-0031)。

        `set_session_github` の product 版。存在しなければ None。merge 保存で
        name/glossary 等の他フィールドを温存する。
        """
        current = self.get_product(product_id)
        if current is None:
            return None
        updated = current.model_copy(
            update={
                "github_repo": repo,
                "github_branch": branch,
                "github_commit_sha": commit_sha,
                "github_index_status": index_status,
                "github_summary": summary,
            }
        )
        if self._client is not None:
            self._client.collection("products").document(product_id).set(
                {
                    "github_repo": repo,
                    "github_branch": branch,
                    "github_commit_sha": commit_sha,
                    "github_index_status": index_status.value,
                    "github_summary": summary,
                },
                merge=True,
            )
        else:
            self._mem_products[product_id] = updated
        return updated

    def delete_product(self, product_id: str) -> bool:
        """product と配下の深掘りリンクを削除する。実体を消したら True (冪等)。

        Firestore はサブコレクションをカスケード削除しないため、invites を明示的に
        消してから product 文書を消す（リンクだけ残ると join 検証が親なしで通り得る）。
        """
        if self._client is not None:
            ref = self._client.collection("products").document(product_id)
            if not ref.get().exists:
                return False
            for inv in ref.collection("invites").stream():
                inv.reference.delete()
            ref.delete()
            return True
        if product_id not in self._mem_products:
            return False
        del self._mem_products[product_id]
        self._mem_invites.pop(product_id, None)
        return True

    # ---- Product invites (深掘りリンク / ADR-0031) ---------------------------
    def create_invite(self, invite: ProductInvite) -> None:
        """深掘りリンクを作成する。親 product が無ければ ProductNotFound。

        親の存在を確認するのは、product 削除後に古いリンクだけが復活する事故を防ぐため。
        """
        if self.get_product(invite.product_id) is None:
            raise ProductNotFound(invite.product_id)
        if self._client is not None:
            self._invite_doc(invite.product_id, invite.id).set(invite.model_dump(mode="json"))
            return
        self._mem_invites.setdefault(invite.product_id, {})[invite.id] = invite

    def get_invite(self, product_id: str, invite_id: str) -> ProductInvite | None:
        if self._client is not None:
            snap = self._invite_doc(product_id, invite_id).get()
            return ProductInvite.model_validate(snap.to_dict()) if snap.exists else None
        return self._mem_invites.get(product_id, {}).get(invite_id)

    def list_invites(self, product_id: str) -> list[ProductInvite]:
        """product の深掘りリンク一覧を新しい順で返す（発行・失効の管理 UI 用）。"""
        if self._client is not None:
            docs = (
                self._client.collection("products")
                .document(product_id)
                .collection("invites")
                .stream()
            )
            invites = [ProductInvite.model_validate(d.to_dict()) for d in docs]
        else:
            invites = list(self._mem_invites.get(product_id, {}).values())
        return sorted(invites, key=lambda i: i.created_at, reverse=True)

    def revoke_invite(self, product_id: str, invite_id: str) -> bool:
        """深掘りリンクを失効させる。失効できたら True（冪等: 既失効でも True）。"""
        if self._client is not None:
            ref = self._invite_doc(product_id, invite_id)
            if not ref.get().exists:
                return False
            ref.set({"revoked": True}, merge=True)
            return True
        invite = self._mem_invites.get(product_id, {}).get(invite_id)
        if invite is None:
            return False
        self._mem_invites[product_id][invite_id] = invite.model_copy(update={"revoked": True})
        return True

    def consume_invite(
        self,
        product_id: str,
        invite_id: str,
        *,
        rate_limit_per_minute: int | None = None,
    ) -> ProductInvite:
        """深掘りリンクの使用回数を 1 消費し、消費後の invite を返す (ADR-0031 決定3)。

        検証（revoked / expires_at / max_uses）と `use_count` の増分を原子的に行う:
        Firestore はトランザクション、in-memory はロックで read-check-increment を
        直列化する。使えない場合は InviteNotUsable（消費しない）、無ければ InviteNotFound。
        並行 join が上限を跨いでも `use_count` が `max_uses` を超えないことを保証する。

        `rate_limit_per_minute` を渡すと、リンク単位のセッション作成レート制限
        （固定 60 秒ウィンドウ / ADR-0032 決定5）を同じ原子性で検証・計上する。
        超過は InviteRateLimited（消費もウィンドウ計上もしない）。カウンタは invite
        文書の `join_window_*` に同居させ、多インスタンスでも Firestore 側で整合する。
        """
        if self._client is not None:
            return self._consume_invite_txn(product_id, invite_id, rate_limit_per_minute)
        with self._mem_invite_lock:
            invite = self._mem_invites.get(product_id, {}).get(invite_id)
            if invite is None:
                raise InviteNotFound(invite_id)
            self._check_invite_usable(invite)
            updated = self._consumed_copy(invite, rate_limit_per_minute)
            self._mem_invites[product_id][invite_id] = updated
            return updated

    def _consume_invite_txn(
        self, product_id: str, invite_id: str, rate_limit_per_minute: int | None
    ) -> ProductInvite:
        from google.cloud import firestore

        doc_ref = self._invite_doc(product_id, invite_id)

        @firestore.transactional  # type: ignore[misc]
        def _txn(transaction: Any) -> ProductInvite:
            # delete_product との競合で孤立した invite を消費させない。
            product_snap = (
                self._client.collection("products")
                .document(product_id)
                .get(transaction=transaction)
            )
            if not product_snap.exists:
                raise ProductNotFound(product_id)
            snap = doc_ref.get(transaction=transaction)
            if not snap.exists:
                raise InviteNotFound(invite_id)
            invite = ProductInvite.model_validate(snap.to_dict())
            # 検証と増分を同一トランザクションにし、並行 join でも max_uses を超えない。
            self._check_invite_usable(invite)
            updated = self._consumed_copy(invite, rate_limit_per_minute)
            transaction.set(
                doc_ref,
                {
                    "use_count": updated.use_count,
                    "join_window_start": updated.join_window_start,
                    "join_window_count": updated.join_window_count,
                },
                merge=True,
            )
            return updated

        consumed: ProductInvite = _txn(self._client.transaction())
        return consumed

    @staticmethod
    def _consumed_copy(invite: ProductInvite, rate_limit_per_minute: int | None) -> ProductInvite:
        """消費後の invite を組み立てる（use_count とレートウィンドウの同時更新）。

        呼び出し側（トランザクション/ロック）が原子性を担う。上限到達なら
        InviteRateLimited を送出し、何も更新しない。
        """
        now = datetime.now(UTC)
        window_start = invite.join_window_start
        window_count = invite.join_window_count
        if window_start is None or (now - window_start).total_seconds() >= 60:
            window_start, window_count = now, 0
        if rate_limit_per_minute is not None and window_count >= rate_limit_per_minute:
            raise InviteRateLimited(invite.id)
        return invite.model_copy(
            update={
                "use_count": invite.use_count + 1,
                "join_window_start": window_start,
                "join_window_count": window_count + 1,
            }
        )

    @staticmethod
    def _check_invite_usable(invite: ProductInvite) -> None:
        """使用可否を検証する。使えない理由を InviteNotUsable(reason) で送出。"""
        if invite.revoked:
            raise InviteNotUsable("revoked")
        if invite.expires_at is not None and invite.expires_at <= datetime.now(UTC):
            raise InviteNotUsable("expired")
        if invite.max_uses is not None and invite.use_count >= invite.max_uses:
            raise InviteNotUsable("exhausted")

    def _invite_doc(self, product_id: str, invite_id: str):  # type: ignore[no-untyped-def]
        return (
            self._client.collection("products")
            .document(product_id)
            .collection("invites")
            .document(invite_id)
        )

    # ---- Utterances --------------------------------------------------------
    def add_utterance(self, session_id: str, utterance: Utterance) -> None:
        # PII を含みうる発話は永続化前にマスクする（issue #10 / #130 / mask_pii_before_index）。
        # grounding 索引は retrieval/ingestion 側でマスク済みだが、Firestore 保存経路でも
        # 同じ方針を適用し、生 PII が at-rest で残らないようにする。
        stored = utterance
        if self._mask_pii:
            stored = utterance.model_copy(update={"text": mask_pii(utterance.text)})
        if self._client is not None:
            doc = stored.model_dump(mode="json")
            if (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("utterances")
                .add(doc)
            )
            return
        self._mem_utterances.setdefault(session_id, []).append(stored)

    # ---- Requirements ------------------------------------------------------
    def save_requirement(self, session_id: str, requirement: Requirement) -> None:
        if self._client is not None:
            doc = requirement.model_dump(mode="json")
            # 承認済みは TTL の対象外 (§11)。それ以外はリテンション期限を付ける。
            if requirement.status is not RequirementStatus.APPROVED:
                if (exp := self._expire_at()) is not None:
                    doc["expireAt"] = exp
            self._req_doc(session_id, requirement.id).set(doc)
            return
        self._mem_requirements.setdefault(session_id, {})[requirement.id] = requirement

    def list_requirements(self, session_id: str) -> list[Requirement]:
        if self._client is not None:
            docs = (
                self._client.collection("sessions")
                .document(session_id)
                .collection("requirements")
                .stream()
            )
            return [Requirement.model_validate(d.to_dict()) for d in docs]
        return list(self._mem_requirements.get(session_id, {}).values())

    def get_requirement(self, session_id: str, rid: str) -> Requirement | None:
        if self._client is not None:
            snap = self._req_doc(session_id, rid).get()
            return Requirement.model_validate(snap.to_dict()) if snap.exists else None
        return self._mem_requirements.get(session_id, {}).get(rid)

    def update_requirement(
        self,
        session_id: str,
        rid: str,
        *,
        statement: str | None = None,
        priority: str | None = None,
        category: str | None = None,
    ) -> Requirement:
        """statement/priority/category のみ上書きする (ADR-0014 §10)。

        出所メタ (id/created_at/source_speaker/confidence) と承認状態は不変。
        """
        current = self.get_requirement(session_id, rid)
        if current is None:
            raise RequirementNotFound(rid)
        updates: dict[str, object] = {}
        if statement is not None:
            updates["statement"] = statement
        if priority is not None:
            updates["priority"] = priority
        if category is not None:
            updates["category"] = category
        if not updates:
            return current
        # dict に適用してから検証する (enum へのコアース・不正値検出を一度で行う)。
        data = current.model_dump()
        data.update(updates)
        updated = Requirement.model_validate(data)

        if self._client is not None:
            # merge=True は必須: model に無い expireAt (TTL センチネル) を消さず温存する。
            self._req_doc(session_id, rid).set(updated.model_dump(mode="json"), merge=True)
        else:
            self._mem_requirements.setdefault(session_id, {})[rid] = updated
        return updated

    def set_requirement_status(
        self,
        session_id: str,
        rid: str,
        status: RequirementStatus,
        approved_by: str | None = None,
        keep_expiry: bool = False,
    ) -> Requirement:
        """承認/却下/差し戻しを行う (ADR-0014 §11)。

        approved にしたら通常は `expireAt` を削除して TTL の対象外にする。
        `keep_expiry=True`（ゲストセッション向け）のときは approved でも TTL を維持する:
        セッション文書自体が 30 日 TTL で消えるため、要件を無期限に残すと orphan になる。
        draft/rejected は `expireAt` を張り直して 30 日自動削除に任せる。
        """
        current = self.get_requirement(session_id, rid)
        if current is None:
            raise RequirementNotFound(rid)

        now = datetime.now(UTC)
        is_approved = status is RequirementStatus.APPROVED
        updated = current.model_copy(
            update={
                "status": status,
                "approved_by": approved_by if is_approved else None,
                "approved_at": now if is_approved else None,
            }
        )

        if self._client is not None:
            doc = updated.model_dump(mode="json")
            from google.cloud import firestore

            if is_approved and not keep_expiry:
                # null 代入では「null フィールド」が残り TTL が効き続ける懸念があるため
                # センチネルで明示削除する (ADR-0014 §17)。
                doc["expireAt"] = firestore.DELETE_FIELD
            elif not is_approved and (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            # is_approved かつ keep_expiry=True: expireAt を触らず既存 TTL を温存する。
            self._req_doc(session_id, rid).set(doc, merge=True)
        else:
            self._mem_requirements.setdefault(session_id, {})[rid] = updated
        return updated

    # ---- Detections (#94/#100) ---------------------------------------------
    def save_detection(self, session_id: str, detection: dict[str, Any]) -> None:
        """検知 (矛盾/抜け) を Firestore に upsert する (#94/#100)。

        ハイドレーション (GET /detections?open=1) でリロード/途中参加時に未解消検知を
        復元できるよう、publish だけでなく永続化する (Codex review 対応)。
        """
        detection_id = detection["id"]
        if self._client is not None:
            doc = dict(detection)
            if (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("detections")
                .document(detection_id)
                .set(doc, merge=True)
            )
            return
        self._mem_detections.setdefault(session_id, {})[detection_id] = dict(detection)

    def resolve_detection(self, session_id: str, detection_id: str, resolution: str) -> None:
        """検知を解消済みに更新する。open スナップショットから外れるようにする。"""
        patch: dict[str, Any] = {"resolved": True, "resolution": resolution}
        if self._client is not None:
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("detections")
                .document(detection_id)
                .set(patch, merge=True)
            )
            return
        existing = self._mem_detections.setdefault(session_id, {}).get(detection_id)
        if existing is not None:
            existing.update(patch)

    # ---- Materials (#184) --------------------------------------------------
    def save_material(self, session_id: str, material: dict[str, Any]) -> None:
        """投入済み素材のメタ (id/name/kind/status/extracted) を upsert する (#184)。

        GET /context/files でリロード/途中参加時に実ファイル名・解析状態を復元できるよう、
        プロセス内ではなく外部ストアに永続化する (Cloud Run の多インスタンス/再起動対策)。
        同一 asset_id は上書き (冪等)。解析の進行で status/extracted を更新できる。
        """
        material_id = material["id"]
        if self._client is not None:
            doc = dict(material)
            if (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            (
                self._client.collection("sessions")
                .document(session_id)
                .collection("materials")
                .document(material_id)
                .set(doc, merge=True)
            )
            return
        self._mem_materials.setdefault(session_id, {})[material_id] = dict(material)

    def list_materials(self, session_id: str) -> list[dict[str, Any]]:
        """セッションに投入された素材メタの一覧 (#184)。"""
        if self._client is not None:
            docs = (
                self._client.collection("sessions")
                .document(session_id)
                .collection("materials")
                .stream()
            )
            return [d.to_dict() for d in docs]
        return list(self._mem_materials.get(session_id, {}).values())

    def delete_material(self, session_id: str, asset_id: str) -> bool:
        """投入済み素材メタを削除する (#245 真の破棄)。実体を消したら True (冪等)。

        GET /context/files (list_materials) から外し、リロード/再接続での復活を止める。
        中断確定で DELETE /context/file/{asset_id} から呼ばれる。存在しない asset_id でも
        安全に False を返す (Firestore 未接続の in-memory フォールバックも壊さない)。
        """
        if self._client is not None:
            ref = (
                self._client.collection("sessions")
                .document(session_id)
                .collection("materials")
                .document(asset_id)
            )
            if not ref.get().exists:
                return False
            ref.delete()
            return True
        materials = self._mem_materials.get(session_id)
        if materials is not None and asset_id in materials:
            del materials[asset_id]
            return True
        return False

    # ---- Current question (#212 / ADR-0020) --------------------------------
    def save_current_question(
        self, session_id: str, question: dict[str, Any], asked_seq: int
    ) -> None:
        """現在の未回答質問を「最新1問のポインタ」として保存する（ADR-0020 §1 / §5-8）。

        `sessions/{id}/questions/current` の単一ドキュメントに上書き保存する。リロード/途中参加で
        `GET /questions/current` が金枠ピンを復元できるよう、**publish の前に**確定させる
        （順序は §5-1。送信成功〜保存完了の窓で復元失敗が起きないようにする）。
        `expireAt` 付き（発話/draft 要件と同じ 30 日 TTL）。承認のような保全対象ではないため、
        未回答のまま離脱したら他の一過性データと同じく TTL で消える（§5-8 / issue #10）。
        `asked_seq` はその問いが publish された envelope seq。GET の順序情報に使う（§3）。
        """
        doc: dict[str, Any] = {
            "id": question["id"],
            "prompt": question["prompt"],
            "options": question.get("options") or [],
            "asked_seq": asked_seq,
            "cleared": False,
        }
        if self._client is not None:
            # set（merge なし）で全置換する: 前の tombstone（cleared/cleared_seq）を引き継がない。
            if (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
            self._question_doc(session_id).set(doc)
            return
        self._mem_questions[session_id] = doc

    def clear_current_question(self, session_id: str, question_id: str, cleared_seq: int) -> bool:
        """回答済みの現在質問を tombstone 化する（ADR-0020 §5-3 / §5-7 / §5-9）。

        現在質問 id == `question_id` のとき**だけ**、transaction / CAS で原子的にクリアする。
        物理削除はせず **tombstone**（`question=null` 相当 + `cleared_seq`）にし、PII を含みうる
        `prompt`/`options` は削除する（非 PII の `cleared_seq` だけ残す / §5-9）。tombstone も
        §5-8 の TTL（30 日）で最終的に消える。クリアできたら True、id 不一致 / 未提示 / 既クリア
        なら False を返す（呼び出し元はこれを見て publish するか決める）。
        """
        if self._client is not None:
            return self._clear_current_question_txn(session_id, question_id, cleared_seq)
        current = self._mem_questions.get(session_id)
        if current is None or current.get("cleared") or current.get("id") != question_id:
            return False
        self._mem_questions[session_id] = {
            "id": question_id,
            "cleared": True,
            "cleared_seq": cleared_seq,
        }
        return True

    def _clear_current_question_txn(
        self, session_id: str, question_id: str, cleared_seq: int
    ) -> bool:
        from google.cloud import firestore

        doc_ref = self._question_doc(session_id)
        expire_at = self._expire_at()

        @firestore.transactional  # type: ignore[misc]
        def _txn(transaction: Any) -> bool:
            snap = doc_ref.get(transaction=transaction)
            data = snap.to_dict() if snap.exists else None
            # 古い回答処理が一致を読んだ直後に新しい ask が上書きする競合を防ぐため、
            # 読み取り〜条件付き書き込みを 1 トランザクションにする（§5-7）。
            if data is None or data.get("cleared") or data.get("id") != question_id:
                return False
            tombstone: dict[str, Any] = {
                "id": question_id,
                "cleared": True,
                "cleared_seq": cleared_seq,
                # PII を含みうる本文/選択肢は tombstone から消す（§5-9）。
                "prompt": firestore.DELETE_FIELD,
                "options": firestore.DELETE_FIELD,
                "asked_seq": firestore.DELETE_FIELD,
            }
            if expire_at is not None:
                tombstone["expireAt"] = expire_at
            transaction.set(doc_ref, tombstone, merge=True)
            return True

        return bool(_txn(self._client.transaction()))

    def set_session_seq(self, session_id: str, seq: int) -> None:
        """セッションの適用済み最大 seq を保存する (ハイドレーション境界, 契約 §4)。"""
        if self._client is not None:
            (
                self._client.collection("sessions")
                .document(session_id)
                .set({"last_seq": seq}, merge=True)
            )
            return
        self._mem_seq[session_id] = seq

    def get_session_seq(self, session_id: str) -> int:
        """保存済みの適用済み最大 seq を返す（未保存なら 0）。

        Cloud Run 再起動・再参加後に EventPublisher の seq をここからシードし、seq が 0 へ
        戻らず単調増加を継ぐ。web の seq ガードが再起動後イベントを黙殺しないようにする
        （#123・ADR-0021）。
        """
        if self._client is not None:
            snap = self._client.collection("sessions").document(session_id).get()
            data = snap.to_dict() if snap.exists else None
            if data is not None and isinstance(data.get("last_seq"), int):
                return int(data["last_seq"])
            return 0
        return self._mem_seq.get(session_id, 0)

    def get_startup_seq(self, session_id: str) -> int:
        """起動時の reliable seq シードを返す（#270 補完・ADR-0021）。

        last_seq（set_session_seq で保存）に加え、current question の asked_seq/cleared_seq
        も読み、その最大値を返す。question.asked/cleared は set_session_seq を呼ばないが
        publisher._seq を消費するため（§3 設計制約）、再起動後に seq が後退して web の
        status ガード（event.seq < lastStatusSeq）に弾かれる窓を塞ぐ（#270）。
        """
        base = self.get_session_seq(session_id)
        if self._client is not None:
            snap = self._question_doc(session_id).get()
            data = snap.to_dict() if snap.exists else None
        else:
            data = self._mem_questions.get(session_id)
        if data is None:
            return base
        for key in ("asked_seq", "cleared_seq"):
            val = data.get(key)
            if isinstance(val, int) and val > base:
                base = val
        return base

    def reserve_session_seq(self, session_id: str, count: int = 1) -> int:
        """次の seq を count 個アトミックに予約し、予約区間の先頭 seq を返す（#145・ADR-0021）。

        API も agent と同じセッション seq 空間へ realtime を publish する（ADR-0023）。両者が
        並行しても単調増加を崩さないよう、last_seq をトランザクションで進めて区間を確保する。
        返り値 s に対し呼び出し元は s..s+count-1 を使ってよい（last_seq は s+count-1 まで前進）。
        """
        if count < 1:
            raise ValueError("count must be >= 1")
        if self._client is not None:
            from google.cloud import firestore

            doc_ref = self._client.collection("sessions").document(session_id)

            @firestore.transactional  # type: ignore[misc]
            def _txn(transaction: Any) -> int:
                snap = doc_ref.get(transaction=transaction)
                data = snap.to_dict() if snap.exists else None
                current = (
                    int(data["last_seq"])
                    if data is not None and isinstance(data.get("last_seq"), int)
                    else 0
                )
                transaction.set(doc_ref, {"last_seq": current + count}, merge=True)
                return current + 1

            return int(_txn(self._client.transaction()))
        current = self._mem_seq.get(session_id, 0)
        self._mem_seq[session_id] = current + count
        return current + 1

    # lossy_seq epoch のブロック幅。1 起動あたり最大この件数の lossy イベントを許容する。
    # 起動ごとに [epoch*BLOCK, (epoch+1)*BLOCK) の区間を割り当て、再起動を跨いで lossy_seq を
    # 大域単調にする。JS の安全整数（2^53）に対し十分小さく、現実の lossy 件数を大きく上回る。
    LOSSY_EPOCH_BLOCK = 1_000_000_000

    def reserve_lossy_seq_base(self, session_id: str) -> int:
        """この起動の lossy_seq 開始基底を払い出す（#270・ADR-0021）。

        lossy（status/transcript.partial）の `lossy_seq` は ephemeral でプロセス再起動時に 0 へ
        戻るが、接続を維持している web は再起動前の `lossy_seq` 高水位を保持しているため、0 から
        振り直すと再起動後の lossy が黙殺される（#123 が reliable seq で解いた退行の lossy 版）。
        起動ごとに epoch を +1 し、`epoch * BLOCK` を lossy_seq の開始基底として返すことで、
        再起動後の lossy_seq が必ず以前を上回り、大域的に単調増加する。epoch の採番は
        Firestore トランザクションで原子的に行う（複数 worker の同時起動に耐える）。
        """
        if self._client is not None:
            from google.cloud import firestore

            doc_ref = self._client.collection("sessions").document(session_id)

            @firestore.transactional  # type: ignore[misc]
            def _txn(transaction: Any) -> int:
                snap = doc_ref.get(transaction=transaction)
                data = snap.to_dict() if snap.exists else None
                epoch = (
                    int(data["lossy_epoch"])
                    if data is not None and isinstance(data.get("lossy_epoch"), int)
                    else 0
                ) + 1
                transaction.set(doc_ref, {"lossy_epoch": epoch}, merge=True)
                return epoch

            epoch = int(_txn(self._client.transaction()))
        else:
            epoch = self._mem_lossy_epoch.get(session_id, 0) + 1
            self._mem_lossy_epoch[session_id] = epoch
        return epoch * self.LOSSY_EPOCH_BLOCK

    # ---- internal ----------------------------------------------------------
    def _req_doc(self, session_id: str, rid: str):  # type: ignore[no-untyped-def]
        return (
            self._client.collection("sessions")
            .document(session_id)
            .collection("requirements")
            .document(rid)
        )

    def _question_doc(self, session_id: str):  # type: ignore[no-untyped-def]
        # 最新1問モデル: サブコレクション `questions` の単一ポインタ（doc id="current"）。
        return (
            self._client.collection("sessions")
            .document(session_id)
            .collection("questions")
            .document("current")
        )
