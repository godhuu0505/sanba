"""バックグラウンド分析の debounce 判定（ADR-0037 段階B）。

ADK 分析（最も高価な LLM 往復）をツール呼び出しから切り離して裏で回すための
発火判定だけを持つ。LiveKit / asyncio に依存しない純ロジックとして分離し、
クロック注入で決定的にテストする（CLAUDE.md テスト方針）。

発火条件（ADR-0037 決定2）: 「確定発話 2 件以上の差分」かつ「前回実行開始から
20 秒以上」。実行中は新規発火しない（機内 1 件）。タイマーは持たず、条件は
発話到着時と実行完了時にだけ再評価する: 条件未達のまま沈黙が続いても、モデルが
`analyze_requirements` を呼ぶ同期フォールバック経路が最新化を保証するため。
"""

from __future__ import annotations

import time
from collections.abc import Callable

DEFAULT_MIN_INTERVAL_SECONDS = 20.0
DEFAULT_MIN_NEW_UTTERANCES = 2


class AnalysisScheduler:
    """発話数と経過時間でバックグラウンド分析の開始可否を判定する。"""

    def __init__(
        self,
        *,
        min_interval_seconds: float = DEFAULT_MIN_INTERVAL_SECONDS,
        min_new_utterances: int = DEFAULT_MIN_NEW_UTTERANCES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._min_interval_seconds = min_interval_seconds
        self._min_new_utterances = min_new_utterances
        self._clock = clock
        self._pending = 0
        self._last_started_at: float | None = None
        self._running = False

    @property
    def pending(self) -> int:
        return self._pending

    @property
    def running(self) -> bool:
        return self._running

    def note_utterance(self) -> bool:
        """確定発話 1 件を計上し、いま分析を開始すべきなら True を返す。"""
        self._pending += 1
        return self._should_start()

    def start(self) -> None:
        """実行開始を記録する（呼び出し側がタスクを起動する直前に呼ぶ）。"""
        self._running = True
        self._last_started_at = self._clock()
        self._pending = 0

    def finish(self) -> bool:
        """実行終了を記録し、追い掛け実行すべきなら True を返す。

        実行中に差分が溜まっていても、間隔条件（min_interval）を満たさない場合は
        False（次の発話到着時に再評価される）。
        """
        self._running = False
        return self._should_start()

    def _should_start(self) -> bool:
        if self._running:
            return False
        if self._pending < self._min_new_utterances:
            return False
        if (
            self._last_started_at is not None
            and self._clock() - self._last_started_at < self._min_interval_seconds
        ):
            return False
        return True
