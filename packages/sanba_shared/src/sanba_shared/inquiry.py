"""確認事項ロジックツリーの純粋ドメイン（ADR-0059）。

Firestore/LiveKit/ADK に一切依存しないため、深さ・枝の制約や剪定・冪等 id・自動 resolve
を creds 無しで単体テストできる。永続化と realtime 発火は呼び出し側（agent の調停器）が担う。

`InquiryTree` は「単一の書き手」の状態そのもの。upsert/resolve/drop は**変化したノードの
リスト**を返し、呼び出し側がそれを永続化（`save_inquiry_node`）し realtime（`inquiry.node`）へ
流す。これにより木の正本性（決定①）と単一書き手（決定③）を保つ。
"""

from __future__ import annotations

import hashlib

from .models import (
    MAX_INQUIRY_CHILDREN,
    MAX_INQUIRY_DEPTH,
    InquiryKind,
    InquiryNode,
    InquiryOrigin,
    InquiryStatus,
)

_GATING_KINDS = (InquiryKind.CONTRADICTION, InquiryKind.GAP, InquiryKind.CHECK)


def normalize_text(text: str) -> str:
    """冪等 id と重複検知のための正規化（前後空白除去・連続空白畳み・小文字化）。"""
    return " ".join(text.strip().lower().split())


def make_inquiry_id(kind: InquiryKind, text: str) -> str:
    """kind と正規化テキストから決定的な短い id（冪等 upsert・reparent で不変）。"""
    digest = hashlib.sha1(f"{kind.value}:{normalize_text(text)}".encode()).hexdigest()
    return f"inq_{digest[:10]}"


class InquiryTree:
    """1 セッションの確認事項ツリー。深さ≤5・同一親の open 子≤5 をサーバ側で強制する。"""

    def __init__(self, nodes: list[InquiryNode] | None = None) -> None:
        self._nodes: dict[str, InquiryNode] = {n.id: n for n in (nodes or [])}

    @classmethod
    def from_nodes(cls, nodes: list[InquiryNode]) -> InquiryTree:
        return cls(nodes)

    def nodes(self) -> list[InquiryNode]:
        """created_seq 昇順（同点は id 順）で全ノードを返す。"""
        return sorted(self._nodes.values(), key=lambda n: (n.created_seq, n.id))

    def get(self, node_id: str) -> InquiryNode | None:
        return self._nodes.get(node_id)

    def _depth_of(self, parent_id: str | None) -> int:
        if parent_id is None:
            return 1
        parent = self._nodes.get(parent_id)
        return parent.depth + 1 if parent is not None else 1

    def _clamp_parent(self, parent_id: str | None) -> str | None:
        """親が深すぎる場合、深さ上限に収まる最も深い祖先へ付け替える。

        自然な親が深さ MAX なら子は MAX+1 になり上限違反。上限内に収まるまで祖先へ遡る。
        """
        current = parent_id
        while current is not None:
            parent = self._nodes.get(current)
            if parent is None:
                return None
            if parent.depth < MAX_INQUIRY_DEPTH:
                return current
            current = parent.parent_id
        return None

    def _open_children(self, parent_id: str | None) -> list[InquiryNode]:
        return [
            n
            for n in self._nodes.values()
            if n.parent_id == parent_id and n.status is InquiryStatus.OPEN
        ]

    def upsert(
        self,
        *,
        kind: InquiryKind,
        text: str,
        seq: int,
        confidence: float = 1.0,
        refs: list[str] | None = None,
        origin: InquiryOrigin = InquiryOrigin.ANALYSIS,
        parent_id: str | None = None,
    ) -> list[InquiryNode]:
        """ノードを冪等 upsert し、変化したノード（本体＋剪定された子）を返す。

        - 既存が resolved なら再 open（同一論点の再燃）。dropped は「人間が不要と判断」した
          ものなので再検知でも復活させない（no-op）。
        - 親は与えられた `parent_id`（フォーカス）。深さ上限を超える場合は祖先へ付け替える。
        - upsert 後、同一親の open 子が上限超なら confidence 最小の open 子を drop する。
        """
        node_id = make_inquiry_id(kind, text)
        changed: list[InquiryNode] = []
        existing = self._nodes.get(node_id)

        if existing is not None:
            if existing.status is InquiryStatus.DROPPED:
                return []
            existing.confidence = confidence
            if refs:
                existing.refs = list(refs)
            if existing.status is InquiryStatus.RESOLVED:
                existing.status = InquiryStatus.OPEN
                existing.resolved_seq = None
            changed.append(existing)
        else:
            clamped = self._clamp_parent(parent_id)
            node = InquiryNode(
                id=node_id,
                parent_id=clamped,
                kind=kind,
                text=text.strip(),
                status=InquiryStatus.OPEN,
                confidence=confidence,
                depth=self._depth_of(clamped),
                origin=origin,
                refs=list(refs or []),
                created_seq=seq,
            )
            self._nodes[node_id] = node
            changed.append(node)

        pruned = self._enforce_branch_cap(self._nodes[node_id].parent_id, seq)
        changed.extend(pruned)
        return _dedupe(changed)

    def _enforce_branch_cap(self, parent_id: str | None, seq: int) -> list[InquiryNode]:
        """同一親の open 子が上限を超えたら confidence 最小（同点は古い順）を drop する。"""
        pruned: list[InquiryNode] = []
        while True:
            open_children = self._open_children(parent_id)
            if len(open_children) <= MAX_INQUIRY_CHILDREN:
                break
            victim = min(open_children, key=lambda n: (n.confidence, n.created_seq))
            victim.status = InquiryStatus.DROPPED
            victim.resolved_seq = seq
            pruned.append(victim)
        return pruned

    def resolve(self, node_id: str, seq: int) -> InquiryNode | None:
        """ノードを解消済みにする。存在しない/既に非 open なら None。"""
        node = self._nodes.get(node_id)
        if node is None or node.status is not InquiryStatus.OPEN:
            return None
        node.status = InquiryStatus.RESOLVED
        node.resolved_seq = seq
        return node

    def resolve_by_text(self, kind: InquiryKind, text: str, seq: int) -> InquiryNode | None:
        return self.resolve(make_inquiry_id(kind, text), seq)

    def drop(self, node_id: str, seq: int) -> InquiryNode | None:
        """ノードを不要（人間の剪定）にする。open のみ対象。"""
        node = self._nodes.get(node_id)
        if node is None or node.status is not InquiryStatus.OPEN:
            return None
        node.status = InquiryStatus.DROPPED
        node.resolved_seq = seq
        return node

    def reconcile_absent(
        self, kind: InquiryKind, present_ids: set[str], seq: int
    ) -> list[InquiryNode]:
        """指定 kind の open ノードのうち、最新パスに現れなかったものを自動 resolve する。

        背景分析の各パスで供給される kind（gap/contradiction/check）にだけ使う。会話由来の
        ノードを取りこぼしで消さないよう、呼び出し側が kind を限定する（決定③）。
        """
        resolved: list[InquiryNode] = []
        for node in self._nodes.values():
            if (
                node.kind is kind
                and node.status is InquiryStatus.OPEN
                and node.id not in present_ids
            ):
                node.status = InquiryStatus.RESOLVED
                node.resolved_seq = seq
                resolved.append(node)
        return resolved

    def gating_open_count(
        self, tau: float = 0.0, kinds: tuple[InquiryKind, ...] = _GATING_KINDS
    ) -> int:
        """終了をブロックする未解消ノード数（HP8）。

        `open かつ confidence ≥ tau かつ kind ∈ kinds`。ambiguous は既定で除外（advisory）。
        """
        return sum(
            1
            for n in self._nodes.values()
            if n.status is InquiryStatus.OPEN and n.confidence >= tau and n.kind in kinds
        )

    def validated(self) -> list[InquiryNode]:
        """HP9 出力用: 解消済みかつ kind ∈ {check, gap, contradiction}（ambiguous 除外）。"""
        keep = (InquiryKind.CHECK, InquiryKind.GAP, InquiryKind.CONTRADICTION)
        return [n for n in self.nodes() if n.status is InquiryStatus.RESOLVED and n.kind in keep]


def _dedupe(nodes: list[InquiryNode]) -> list[InquiryNode]:
    """同一ノードが本体＋剪定で二重に入るのを防ぐ（id で最後の状態に寄せる）。"""
    by_id: dict[str, InquiryNode] = {}
    for n in nodes:
        by_id[n.id] = n
    return list(by_id.values())
