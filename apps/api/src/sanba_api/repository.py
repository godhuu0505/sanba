"""Read-side persistence for hydration APIs (Issue #100).

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
    # 会話の確定軸（contract: draft|confirmed）と管理レビュー軸（draft|approved|rejected,
    # ADR-0014）は別物。永続モデル Requirement.status は管理軸（既定 draft）で保存されるため、
    # それを会話軸へそのまま流すと save_requirement 由来の確定要件がすべて draft 扱いになり、
    # hydration / finalize / export の確定件数が 0 にずれる（Codex P1）。save_requirement で
    # 保存された要件は会話上「確定」なので confirmed とし、管理画面で却下(rejected)された
    # ものだけ draft（非確定＝起票/確定の対象外）に落とす。approved は確定の上位なので confirmed。
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
        # テスト用インメモリ（_client が None のとき使用）。
        self._mem_requirements: dict[str, list[dict[str, Any]]] = {}
        self._mem_detections: dict[str, list[dict[str, Any]]] = {}
        self._mem_seq: dict[str, int] = {}

    @staticmethod
    def _init_client():  # type: ignore[no-untyped-def]
        try:
            from google.cloud import firestore

            return firestore.Client()
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("firestore_unavailable_using_memory", error=str(exc))
            return None

    # ── seed（テスト用）──────────────────────────────────────────────────
    def _seed_requirement(self, session_id: str, doc: dict[str, Any]) -> None:
        self._mem_requirements.setdefault(session_id, []).append(doc)

    def _seed_detection(self, session_id: str, doc: dict[str, Any]) -> None:
        self._mem_detections.setdefault(session_id, []).append(doc)

    def _seed_seq(self, session_id: str, seq: int) -> None:
        self._mem_seq[session_id] = seq

    # ── 読み出し ─────────────────────────────────────────────────────────
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
        """指定 ID の要件のみを契約形で取得する（#213 export スナップショット）。

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
        # open=1: 未解消のみ返す（契約 §4）。
        return [d for d in items if not d["resolved"]]

    def get_session_seq(self, session_id: str) -> int:
        """適用済み最大 seq（ハイドレーション境界, 契約 §4）。未保存なら 0。"""
        if self._client is not None:
            doc = self._client.collection("sessions").document(session_id).get()
            data = doc.to_dict() if doc.exists else None
            return int(data.get("last_seq", 0)) if data else 0
        return self._mem_seq.get(session_id, 0)
