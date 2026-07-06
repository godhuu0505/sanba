"""投機的プリフェッチ・キャッシュ（ADR-0037 段階A）。

ユーザーの確定発話を種に grounding 検索を先読みし、モデルが `search_grounding` を
呼んだ時点で温まった結果を即返して「ツール待ちの沈黙」を短縮する。

設計上の不変条件（ADR-0037 決定2）:
  - 格納するのは出力制御（ADR-0032 決定8 の allowlist / stale・revoked 遮断）を
    **通過した後の結果のみ**。キャッシュに何が入っていても返してよい状態を保つ。
  - プロセス内メモリのみ・保持は最新 1 件（latest-wins）。永続化しない。
  - 鮮度はユーザー確定発話 2 ターンまたは 60 秒の短い方。失効・語彙不一致は
    黙って捨て、呼び出し側は同期検索へフォールバックする（最悪ケース＝現状と同一）。

クロックは注入可能にし、TTL 判定を決定的にテストできるようにする（CLAUDE.md テスト方針）。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .retrieval import tokenize

# 鮮度: ユーザー確定発話 2 ターンまたは 60 秒の短い方で失効。
DEFAULT_TTL_SECONDS = 60.0
DEFAULT_TTL_TURNS = 2
# ツール query とプリフェッチ種 query の語彙重なり（containment 係数）の下限。
# モデルの検索語は発話の言い換えになりがちなので、完全一致ではなく重なりで判定する。
DEFAULT_MIN_OVERLAP = 0.5

# get() のミス理由（観測性: prefetch_hit_rate / stale_dropped_count の分類に使う）。
REASON_HIT = "hit"
REASON_EMPTY = "empty"
REASON_EXPIRED_TIME = "expired_time"
REASON_EXPIRED_TURNS = "expired_turns"
REASON_QUERY_MISMATCH = "query_mismatch"
# キャッシュ自体は有効だが、repo 由来 chunk の ACL 再検証（呼び出し側）で無効化された。
REASON_ACL_RECHECK = "repo_acl_recheck"


@dataclass
class PrefetchEntry:
    """先読み済みの検索結果 1 件。result は search_grounding の返り値そのもの（フィルタ後）。"""

    query: str
    result: dict[str, Any]
    turn: int
    created_at: float
    # 背景検索の所要時間。ヒット時に「同期実行なら掛かっていた時間」の推定として記録する
    # （latency_saved_ms メトリクス）。
    search_seconds: float


def query_overlap(a: str, b: str) -> float:
    """2 つの検索語の語彙重なり（containment 係数 = 共通語 / 小さい方の語彙数）。"""
    ta, tb = tokenize(a), tokenize(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


class PrefetchCache:
    """フィルタ後の grounding 検索結果を最新 1 件だけ保持する（latest-wins）。"""

    def __init__(
        self,
        *,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        ttl_turns: int = DEFAULT_TTL_TURNS,
        min_overlap: float = DEFAULT_MIN_OVERLAP,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._ttl_turns = ttl_turns
        self._min_overlap = min_overlap
        self._clock = clock
        self._entry: PrefetchEntry | None = None

    def put(self, query: str, result: dict[str, Any], *, turn: int, search_seconds: float) -> None:
        """先読み結果を格納する。既存エントリは無条件で置き換える（latest-wins）。"""
        self._entry = PrefetchEntry(
            query=query,
            result=result,
            turn=turn,
            created_at=self._clock(),
            search_seconds=search_seconds,
        )

    def get(self, query: str, *, turn: int) -> tuple[PrefetchEntry | None, str]:
        """query に使える先読み結果と判定理由を返す。使えなければ (None, 理由)。

        失効（時間/ターン）したエントリはこの時点で破棄する。語彙不一致は破棄しない:
        同じ発話ターン内でモデルが別観点の検索を重ねることがあり、後続の類似 query には
        まだ使えるため。
        """
        entry = self._entry
        if entry is None:
            return None, REASON_EMPTY
        if self._clock() - entry.created_at > self._ttl_seconds:
            self._entry = None
            return None, REASON_EXPIRED_TIME
        if turn - entry.turn >= self._ttl_turns:
            self._entry = None
            return None, REASON_EXPIRED_TURNS
        if query_overlap(query, entry.query) < self._min_overlap:
            return None, REASON_QUERY_MISMATCH
        return entry, REASON_HIT
