"""背景分析 → 確認事項ツリー調停器（ADR-0059 Stage②）の単体テスト。"""

from __future__ import annotations

from collections.abc import Callable

from sanba_shared.inquiry import InquiryTree, make_inquiry_id
from sanba_shared.models import AnalysisResult, InquiryKind, InquiryStatus

from sanba_agent.inquiry_feeder import reconcile_analysis


def _seq() -> Callable[[], int]:
    n = {"v": 0}

    def nxt() -> int:
        n["v"] += 1
        return n["v"]

    return nxt


def _result(**kw: object) -> AnalysisResult:
    base: dict[str, object] = {
        "summary": "s",
        "open_topics": [],
        "ambiguous_topics": [],
        "coverage_open": [],
        "next_question": "q?",
        "suggested_answer": "a",
    }
    base.update(kw)
    return AnalysisResult(**base)  # type: ignore[arg-type]


def test_gaps_become_open_gap_nodes_under_focus() -> None:
    tree = InquiryTree()
    seq = _seq()
    root = tree.upsert(kind=InquiryKind.CHECK, text="認証", seq=seq())[0]
    changed = reconcile_analysis(
        tree,
        _result(open_topics=["権限モデルが未定義"]),
        focus_id=root.id,
        seq=seq,
    )
    gap = next(n for n in changed if n.kind is InquiryKind.GAP)
    assert gap.status is InquiryStatus.OPEN
    assert gap.parent_id == root.id


def test_gap_absent_in_next_pass_is_auto_resolved() -> None:
    tree = InquiryTree()
    seq = _seq()
    reconcile_analysis(tree, _result(open_topics=["A", "B"]), focus_id=None, seq=seq)
    reconcile_analysis(tree, _result(open_topics=["A"]), focus_id=None, seq=seq)
    b_id = make_inquiry_id(InquiryKind.GAP, "B")
    a_id = make_inquiry_id(InquiryKind.GAP, "A")
    assert tree.get(b_id).status is InquiryStatus.RESOLVED
    assert tree.get(a_id).status is InquiryStatus.OPEN


def test_uncovered_check_point_opens_and_covered_resolves() -> None:
    tree = InquiryTree()
    seq = _seq()
    points = ["性能要件", "セキュリティ要件"]
    reconcile_analysis(
        tree,
        _result(coverage_open=["性能要件", "セキュリティ要件"]),
        check_points=points,
        focus_id=None,
        seq=seq,
    )
    sec_id = make_inquiry_id(InquiryKind.CHECK, "セキュリティ要件")
    assert tree.get(sec_id).status is InquiryStatus.OPEN
    reconcile_analysis(
        tree, _result(coverage_open=["性能要件"]), check_points=points, focus_id=None, seq=seq
    )
    assert tree.get(sec_id).status is InquiryStatus.RESOLVED


def test_pinned_check_point_is_not_reopened_by_coverage() -> None:
    tree = InquiryTree()
    seq = _seq()
    points = ["セキュリティ要件"]
    reconcile_analysis(
        tree,
        _result(coverage_open=["セキュリティ要件"]),
        check_points=points,
        focus_id=None,
        seq=seq,
    )
    sec_id = make_inquiry_id(InquiryKind.CHECK, "セキュリティ要件")
    tree.resolve(sec_id, seq(), pin=True)
    reconcile_analysis(
        tree,
        _result(coverage_open=["セキュリティ要件"]),
        check_points=points,
        focus_id=None,
        seq=seq,
    )
    assert tree.get(sec_id).status is InquiryStatus.RESOLVED
    assert tree.gating_open_count(tau=0.0) == 0


def test_ambiguous_nodes_do_not_gate() -> None:
    tree = InquiryTree()
    seq = _seq()
    reconcile_analysis(tree, _result(ambiguous_topics=["いい感じにして"]), focus_id=None, seq=seq)
    assert tree.gating_open_count(tau=0.0) == 0
    amb_id = make_inquiry_id(InquiryKind.AMBIGUOUS, "いい感じにして")
    assert tree.get(amb_id).status is InquiryStatus.OPEN
