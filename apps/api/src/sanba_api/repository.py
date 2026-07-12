"""Read-side persistence for hydration APIs.

agent（apps/agent）が Firestore に書いた要件を、web のハイドレーション（契約 §4）向けに
読み出す。レスポンス schema は契約 §3 の `requirement` 形に揃える（source_speaker /
confidence / citations / status を含む）。確認事項ロジックツリー（ADR-0059）は正本の
`SessionRepository.list_inquiry_nodes` から直接ハイドレーションするため、ここでは扱わない。

Firestore が無い環境（単体テスト）ではインメモリにフォールバックする。
"""

from __future__ import annotations

from typing import Any

import structlog

log = structlog.get_logger(__name__)

_MAX_REQUIREMENT_IDS = 1000


def requirement_doc_to_contract(doc: dict[str, Any]) -> dict[str, Any]:
    """Firestore の requirement ドキュメントを契約 §3 の形へ整形する。

    agent の `Requirement` モデル（id/category/statement/priority/source_speaker/
    confidence）には citations/status が無いため、契約に合わせて補完する。
    """
    admin_status = doc.get("status")
    contract_status = "draft" if admin_status == "rejected" else "confirmed"
    return {
        "id": doc.get("id", ""),
        "statement": doc.get("statement", ""),
        "category": doc.get("category", "functional"),
        "priority": doc.get("priority", "should"),
        "confidence": doc.get("confidence", 0.7),
        "source_speaker": doc.get("source_speaker") or "",
        "citations": doc.get("citations", []),
        "status": contract_status,
    }


class ReadRepository:
    """Hydration の読み出し境界。Firestore が無ければインメモリで動く。"""

    def __init__(self) -> None:
        self._client = self._init_client()
        self._mem_requirements: dict[str, list[dict[str, Any]]] = {}
        self._mem_seq: dict[str, int] = {}

    @staticmethod
    def _init_client():  # type: ignore[no-untyped-def]
        try:
            from google.cloud import firestore

            return firestore.Client()
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("firestore_unavailable_using_memory", error=str(exc))
            return None

    def _seed_requirement(self, session_id: str, doc: dict[str, Any]) -> None:
        self._mem_requirements.setdefault(session_id, []).append(doc)

    def _seed_seq(self, session_id: str, seq: int) -> None:
        self._mem_seq[session_id] = seq

    def list_requirements(self, session_id: str) -> list[dict[str, Any]]:
        if self._client is not None:
            docs = (
                self._client.collection("sessions")
                .document(session_id)
                .collection("requirements")
                .stream()
            )
            raw = [d.to_dict() for d in docs]
        else:
            raw = self._mem_requirements.get(session_id, [])
        return [requirement_doc_to_contract(d) for d in raw]

    def get_requirements_by_ids(self, session_id: str, ids: list[str]) -> list[dict[str, Any]]:
        """指定 ID の要件のみを契約形で取得する（export スナップショット）。

        finalize 時に固定した `finalized_requirement_ids` を渡し、確定時集合だけを起票する
        ために使う。現在の status には依存せず ID 集合で取得するため、確定後に却下/追加されても
        集合は変わらない（rejected に落ちた要件も確定時に含まれていれば起票対象に残る）。
        順序は `ids` の順を保ち、既に存在しない（TTL 失効等）ID はスキップする。
        """
        if not ids:
            return []
        ids = ids[:_MAX_REQUIREMENT_IDS]
        by_id: dict[str, dict[str, Any]]
        if self._client is not None:
            requirements = (
                self._client.collection("sessions").document(session_id).collection("requirements")
            )
            refs = [requirements.document(rid) for rid in ids]
            by_id = {
                snap.id: requirement_doc_to_contract(snap.to_dict())
                for snap in self._client.get_all(refs)
                if snap.exists
            }
        else:
            raw = self._mem_requirements.get(session_id, [])
            by_id = {d.get("id", ""): requirement_doc_to_contract(d) for d in raw}
        return [by_id[rid] for rid in ids if rid in by_id]

    def get_session_seq(self, session_id: str) -> int:
        """適用済み最大 seq（ハイドレーション境界, 契約 §4）。未保存なら 0。"""
        if self._client is not None:
            doc = self._client.collection("sessions").document(session_id).get()
            data = doc.to_dict() if doc.exists else None
            return int(data.get("last_seq", 0)) if data else 0
        return self._mem_seq.get(session_id, 0)
