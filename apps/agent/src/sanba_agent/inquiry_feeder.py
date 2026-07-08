"""背景分析の結果を確認事項ツリーへ反映する純粋な調停器（ADR-0059 Stage②）。

`analyze_transcript` は純粋関数のまま検知の束（open_topics/ambiguous_topics/
coverage_open）を返し、on-loop 側はこの `reconcile_analysis` を呼んでツリーへ差分適用する。
LiveKit/ADK/Firestore に依存しないため creds 無しで単体テストできる。永続化と realtime 発火は
呼び出し側（main.py）が返り値に対して行う。

決定③のとおり:
- gap/ambiguous は現在フォーカス中のノードの子に upsert（後追い確認 / HP6）。最新パスに現れない
  open は kind 限定で自動 resolve。
- 確認観点（check_points）は root ノード。coverage_open（未カバー）に載っていれば open、
  外れていれば covered とみなして resolve する。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from sanba_shared.inquiry import InquiryTree, make_inquiry_id
from sanba_shared.models import AnalysisResult, InquiryKind, InquiryNode, InquiryOrigin

GAP_CONFIDENCE = 0.7
AMBIGUOUS_CONFIDENCE = 0.4
CHECK_CONFIDENCE = 0.9


def reconcile_analysis(
    tree: InquiryTree,
    result: AnalysisResult,
    *,
    check_points: Sequence[str] = (),
    focus_id: str | None,
    seq: Callable[[], int],
) -> list[InquiryNode]:
    """1 回の分析結果をツリーへ反映し、変化したノード（永続化/発火の対象）を返す。

    seq は呼び出しごとに単調増加する採番器（realtime envelope seq と揃える）。
    """
    changed: list[InquiryNode] = []

    gap_ids: set[str] = set()
    for topic in result.open_topics:
        gap_ids.add(make_inquiry_id(InquiryKind.GAP, topic))
        changed.extend(
            tree.upsert(
                kind=InquiryKind.GAP,
                text=topic,
                seq=seq(),
                confidence=GAP_CONFIDENCE,
                origin=InquiryOrigin.ANALYSIS,
                parent_id=focus_id,
            )
        )
    changed.extend(tree.reconcile_absent(InquiryKind.GAP, gap_ids, seq()))

    amb_ids: set[str] = set()
    for topic in result.ambiguous_topics:
        amb_ids.add(make_inquiry_id(InquiryKind.AMBIGUOUS, topic))
        changed.extend(
            tree.upsert(
                kind=InquiryKind.AMBIGUOUS,
                text=topic,
                seq=seq(),
                confidence=AMBIGUOUS_CONFIDENCE,
                origin=InquiryOrigin.CONVERSATION,
                parent_id=focus_id,
            )
        )
    changed.extend(tree.reconcile_absent(InquiryKind.AMBIGUOUS, amb_ids, seq()))

    uncovered = set(result.coverage_open)
    for point in check_points:
        node_id = make_inquiry_id(InquiryKind.CHECK, point)
        if point in uncovered:
            changed.extend(
                tree.upsert(
                    kind=InquiryKind.CHECK,
                    text=point,
                    seq=seq(),
                    confidence=CHECK_CONFIDENCE,
                    origin=InquiryOrigin.PREP,
                    parent_id=None,
                )
            )
        else:
            resolved = tree.resolve(node_id, seq())
            if resolved is not None:
                changed.append(resolved)

    return _dedupe(changed)


def _dedupe(nodes: list[InquiryNode]) -> list[InquiryNode]:
    by_id: dict[str, InquiryNode] = {}
    for n in nodes:
        by_id[n.id] = n
    return list(by_id.values())
