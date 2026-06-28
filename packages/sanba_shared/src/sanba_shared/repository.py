"""Firestore-backed persistence for sessions, utterances and requirements.

Stateless workers + external state => Cloud Run friendly (see docs/architecture.md §1).
Falls back to an in-memory store when Firestore is unavailable (e.g. unit tests).

このパッケージはアプリ config に依存しない: リテンション日数は `SessionRepository` の
コンストラクタ引数で受け取る (agent と api が別 settings を持つため / ADR-0014 §8)。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import structlog

from .models import (
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
        # 投入済み素材のメタ (#184)。GET context/files の復元に使う。プロセス内に閉じず外部
        # ストアへ永続化することで、多インスタンス/再起動後のリロード/途中参加でも復元できる。
        self._mem_materials: dict[str, dict[str, dict[str, Any]]] = {}
        # 現在の未回答質問の単一ポインタ (#212 / ADR-0020)。最新1問モデルなのでセッション
        # ごとに 1 ドキュメント。tombstone（cleared）も含めて保持し GET で cleared_seq を返す。
        self._mem_questions: dict[str, dict[str, Any]] = {}

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
    def create_session_doc(self, meta: SessionMeta) -> None:
        """`sessions/{id}` 文書を作成する。一覧/閲覧/承認の土台になる。"""
        if self._client is not None:
            doc = meta.model_dump(mode="json")
            self._client.collection("sessions").document(meta.id).set(doc)
            return
        self._mem_sessions[meta.id] = meta

    def list_sessions(self) -> list[SessionMeta]:
        """全セッションのメタ一覧 (MVP: ページングなし / ADR-0014 保留事項)。"""
        if self._client is not None:
            docs = self._client.collection("sessions").stream()
            return [SessionMeta.model_validate(d.to_dict()) for d in docs]
        return list(self._mem_sessions.values())

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
        存在しなければ None。要件そのものの承認（draft→approved）は管理画面の責務
        （ADR-0014）なのでここでは触れない。確定スナップショットはあくまでセッション単位の
        不可逆マーカ。`finalized_requirement_ids` は export が固定集合を起票する土台（#213）。
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
    ) -> Requirement:
        """承認/却下/差し戻しを行う (ADR-0014 §11)。

        approved にしたら `expireAt` を削除して TTL の対象外にする。
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

            if is_approved:
                # null 代入では「null フィールド」が残り TTL が効き続ける懸念があるため
                # センチネルで明示削除する (ADR-0014 §17)。
                doc["expireAt"] = firestore.DELETE_FIELD
            elif (exp := self._expire_at()) is not None:
                doc["expireAt"] = exp
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
