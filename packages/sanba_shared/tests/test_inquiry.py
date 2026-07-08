"""確認事項ロジックツリー（ADR-0059）の純ロジック・永続化テスト。"""

from __future__ import annotations

from collections.abc import Callable

from sanba_shared.inquiry import InquiryTree, make_inquiry_id, normalize_text
from sanba_shared.models import (
    MAX_INQUIRY_CHILDREN,
    MAX_INQUIRY_DEPTH,
    InquiryKind,
    InquiryOrigin,
    InquiryStatus,
)
from sanba_shared.repository import SessionRepository


def _seq() -> Callable[[], int]:
    n = {"v": 0}

    def nxt() -> int:
        n["v"] += 1
        return n["v"]

    return nxt


def test_make_inquiry_id_is_idempotent_over_normalization() -> None:
    a = make_inquiry_id(InquiryKind.GAP, "  権限モデル  が  未確認 ")
    b = make_inquiry_id(InquiryKind.GAP, "権限モデル が 未確認")
    assert a == b
    # kind が違えば別 id
    assert make_inquiry_id(InquiryKind.CHECK, "x") != make_inquiry_id(InquiryKind.GAP, "x")


def test_normalize_text() -> None:
    assert normalize_text("  A  B\tC ") == "a b c"


def test_upsert_creates_root_and_child_with_depth() -> None:
    tree = InquiryTree()
    seq = _seq()
    root = tree.upsert(kind=InquiryKind.CHECK, text="認証方式", seq=seq())[0]
    assert root.parent_id is None
    assert root.depth == 1
    child = tree.upsert(kind=InquiryKind.GAP, text="MFA の要否", seq=seq(), parent_id=root.id)[0]
    assert child.parent_id == root.id
    assert child.depth == 2


def test_upsert_is_idempotent_updates_confidence_and_refs() -> None:
    tree = InquiryTree()
    seq = _seq()
    first = tree.upsert(kind=InquiryKind.GAP, text="X", seq=seq(), confidence=0.4)[0]
    again = tree.upsert(kind=InquiryKind.GAP, text="x", seq=seq(), confidence=0.9, refs=["u1"])
    assert len(tree.nodes()) == 1
    assert again[0].id == first.id
    assert again[0].confidence == 0.9
    assert again[0].refs == ["u1"]


def test_resolved_node_reopens_on_reupsert() -> None:
    tree = InquiryTree()
    seq = _seq()
    node = tree.upsert(kind=InquiryKind.CONTRADICTION, text="矛盾A", seq=seq())[0]
    tree.resolve(node.id, seq())
    assert tree.get(node.id).status is InquiryStatus.RESOLVED
    reopened = tree.upsert(kind=InquiryKind.CONTRADICTION, text="矛盾A", seq=seq())[0]
    assert reopened.status is InquiryStatus.OPEN
    assert reopened.resolved_seq is None


def test_dropped_node_is_not_resurrected_by_reupsert() -> None:
    tree = InquiryTree()
    seq = _seq()
    node = tree.upsert(kind=InquiryKind.GAP, text="不要論点", seq=seq())[0]
    tree.drop(node.id, seq())
    changed = tree.upsert(kind=InquiryKind.GAP, text="不要論点", seq=seq())
    assert changed == []
    assert tree.get(node.id).status is InquiryStatus.DROPPED


def test_branch_cap_prunes_lowest_confidence_open_child() -> None:
    tree = InquiryTree()
    seq = _seq()
    root = tree.upsert(kind=InquiryKind.CHECK, text="root", seq=seq())[0]
    confidences = [0.9, 0.8, 0.7, 0.6, 0.5]
    for i, c in enumerate(confidences):
        tree.upsert(
            kind=InquiryKind.GAP, text=f"child{i}", seq=seq(), confidence=c, parent_id=root.id
        )
    # 6 個目（最高 confidence）を足すと最低 0.5 が drop される
    changed = tree.upsert(
        kind=InquiryKind.GAP, text="child5", seq=seq(), confidence=0.95, parent_id=root.id
    )
    open_children = [
        n for n in tree.nodes() if n.parent_id == root.id and n.status is InquiryStatus.OPEN
    ]
    assert len(open_children) == MAX_INQUIRY_CHILDREN
    dropped = [n for n in changed if n.status is InquiryStatus.DROPPED]
    assert len(dropped) == 1
    assert dropped[0].text == "child4"  # confidence 0.5 が最小


def test_depth_cap_clamps_parent_to_deepest_allowed_ancestor() -> None:
    tree = InquiryTree()
    seq = _seq()
    parent_id = None
    last = None
    # 深さ MAX まで連鎖を作る
    for i in range(MAX_INQUIRY_DEPTH):
        last = tree.upsert(kind=InquiryKind.GAP, text=f"n{i}", seq=seq(), parent_id=parent_id)[0]
        parent_id = last.id
    assert last.depth == MAX_INQUIRY_DEPTH
    # MAX の子を作ろうとすると深さ上限に丸められる（親は MAX 未満の祖先へ）
    deeper = tree.upsert(kind=InquiryKind.GAP, text="too-deep", seq=seq(), parent_id=last.id)[0]
    assert deeper.depth <= MAX_INQUIRY_DEPTH


def test_reconcile_absent_resolves_only_given_kind() -> None:
    tree = InquiryTree()
    seq = _seq()
    g1 = tree.upsert(kind=InquiryKind.GAP, text="g1", seq=seq())[0]
    g2 = tree.upsert(kind=InquiryKind.GAP, text="g2", seq=seq())[0]
    conv = tree.upsert(
        kind=InquiryKind.CONTRADICTION, text="c1", seq=seq(), origin=InquiryOrigin.CONVERSATION
    )[0]
    # 最新パスに g1 だけ現れた → g2 は自動 resolve、contradiction は触らない
    resolved = tree.reconcile_absent(InquiryKind.GAP, present_ids={g1.id}, seq=seq())
    assert [n.id for n in resolved] == [g2.id]
    assert tree.get(g1.id).status is InquiryStatus.OPEN
    assert tree.get(conv.id).status is InquiryStatus.OPEN


def test_gating_open_count_excludes_ambiguous_and_low_confidence() -> None:
    tree = InquiryTree()
    seq = _seq()
    tree.upsert(kind=InquiryKind.CONTRADICTION, text="c", seq=seq(), confidence=0.9)
    tree.upsert(kind=InquiryKind.GAP, text="g", seq=seq(), confidence=0.9)
    tree.upsert(kind=InquiryKind.CHECK, text="ck", seq=seq(), confidence=0.9)
    tree.upsert(kind=InquiryKind.AMBIGUOUS, text="amb", seq=seq(), confidence=0.9)
    tree.upsert(kind=InquiryKind.GAP, text="low", seq=seq(), confidence=0.2)
    # ambiguous は advisory・confidence<τ は除外
    assert tree.gating_open_count(tau=0.5) == 3


def test_validated_returns_resolved_gating_kinds_only() -> None:
    tree = InquiryTree()
    seq = _seq()
    g = tree.upsert(kind=InquiryKind.GAP, text="g", seq=seq())[0]
    amb = tree.upsert(kind=InquiryKind.AMBIGUOUS, text="amb", seq=seq())[0]
    tree.resolve(g.id, seq())
    tree.resolve(amb.id, seq())
    validated = tree.validated()
    assert [n.id for n in validated] == [g.id]  # ambiguous は除外


def test_repository_persists_and_reloads_nodes_in_memory() -> None:
    repo = SessionRepository()
    seq = _seq()
    tree = InquiryTree()
    for n in tree.upsert(kind=InquiryKind.CHECK, text="認証", seq=seq()):
        repo.save_inquiry_node("sess-1", n)
    loaded = repo.list_inquiry_nodes("sess-1")
    assert len(loaded) == 1
    assert loaded[0].kind is InquiryKind.CHECK
    # round-trip で InquiryTree を再構築できる
    rebuilt = InquiryTree.from_nodes(loaded)
    assert rebuilt.get(loaded[0].id) is not None
