"""Read-side persistence for hydration APIs.

agent（apps/agent）が Firestore に書いた要件・検知を、web のハイドレーション
（契約 §4）向けに読み出す。レスポンス schema は契約 §2/§3 の `requirement` /
`detection` 形に揃える（source_speaker / confidence / citations / status を含む）。

Firestore が無い環境（単体テスト）ではインメモリにフォールバックする。
"""

from __future__ import annotations

from typing import Any

import structlog

log = structlog.get_logger(__name__)


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


def detection_doc_to_contract(doc: dict[str, Any]) -> dict[str, Any]:
    """Firestore の detection ドキュメントを契約 §3（web 正規化形）へ整形する。"""
    return {
        "id": doc.get("id", ""),
        "kind": doc.get("kind", "gap"),
        "summary": doc.get("summary", ""),
        "refs": doc.get("refs", []),
        "category": doc.get("category"),
        "options": doc.get("options"),
        "detector": doc.get("detector", ""),
        "resolved": doc.get("resolved", False),
    }


class ReadRepository:
    """Hydration の読み出し境界。Firestore が無ければインメモリで動く。"""

    def __init__(self) -> None:
        self._client = self._init_client()
        self._mem_requirements: dict[str, list[dict[str, Any]]] = {}
        self._mem_detections: dict[str, list[dict[str, Any]]] = {}
        self._mem_seq: dict[str, int] = {}
        self._mem_questions: dict[str, dict[str, Any]] = {}

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

    def _seed_detection(self, session_id: str, doc: dict[str, Any]) -> None:
        self._mem_detections.setdefault(session_id, []).append(doc)

    def _seed_seq(self, session_id: str, seq: int) -> None:
        self._mem_seq[session_id] = seq

    def _seed_question(self, session_id: str, doc: dict[str, Any]) -> None:
        self._mem_questions[session_id] = doc

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
        if self._client is not None:
            by_id: dict[str, dict[str, Any]] = {}
            for rid in ids:
                snap = (
                    self._client.collection("sessions")
                    .document(session_id)
                    .collection("requirements")
                    .document(rid)
                    .get()
                )
                if snap.exists:
                    by_id[rid] = requirement_doc_to_contract(snap.to_dict())
        else:
            raw = self._mem_requirements.get(session_id, [])
            by_id = {d.get("id", ""): requirement_doc_to_contract(d) for d in raw}
        return [by_id[rid] for rid in ids if rid in by_id]

    def list_open_detections(self, session_id: str) -> list[dict[str, Any]]:
        if self._client is not None:
            docs = (
                self._client.collection("sessions")
                .document(session_id)
                .collection("detections")
                .stream()
            )
            raw = [d.to_dict() for d in docs]
        else:
            raw = self._mem_detections.get(session_id, [])
        items = [detection_doc_to_contract(d) for d in raw]
        return [d for d in items if not d["resolved"]]

    def get_current_question(self, session_id: str) -> dict[str, Any]:
        """現在質問のハイドレーション（ADR-0020 §2 / §5-4）。

        返却は契約に合わせて `{"question": {id,prompt,options} | None, "seq": int}`。
        - active（未回答）: `{question, seq=asked_seq}`。
        - tombstone（回答済み/クリア済み）: `{None, seq=cleared_seq}`。
        - 未提示: `{None, seq=0}`。

        `question=None` でも `seq` を返すことで、web は「遅延 null が新しい live 質問を消す」
        逆転を防げる（§5-4）。
        """
        doc = self._read_question_doc(session_id)
        if doc is None:
            return {"question": None, "seq": 0}
        if doc.get("cleared"):
            return {"question": None, "seq": int(doc.get("cleared_seq", 0))}
        return {
            "question": {
                "id": doc.get("id", ""),
                "prompt": doc.get("prompt", ""),
                "options": doc.get("options") or [],
            },
            "seq": int(doc.get("asked_seq", 0)),
        }

    def _read_question_doc(self, session_id: str) -> dict[str, Any] | None:
        if self._client is not None:
            snap = (
                self._client.collection("sessions")
                .document(session_id)
                .collection("questions")
                .document("current")
                .get()
            )
            return snap.to_dict() if snap.exists else None
        return self._mem_questions.get(session_id)

    def get_session_seq(self, session_id: str) -> int:
        """適用済み最大 seq（ハイドレーション境界, 契約 §4）。未保存なら 0。"""
        if self._client is not None:
            doc = self._client.collection("sessions").document(session_id).get()
            data = doc.to_dict() if doc.exists else None
            return int(data.get("last_seq", 0)) if data else 0
        return self._mem_seq.get(session_id, 0)
