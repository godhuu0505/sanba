"""投機的プリフェッチ（ADR-0037 段階A）のテスト。

PrefetchCache の鮮度判定（TTL / ターン / 語彙重なり）はクロック注入で決定的に検証し、
SANBAAgent 統合では「キャッシュヒットでも出力制御が不変」「ACL 変化時は同期検索へ
フォールバック」を LiveKit ランタイム無しのメモリ fallback で機械検証する。
"""

from __future__ import annotations

import asyncio
import json

import pytest
from sanba_shared.models import GitHubIndexStatus, GitHubLink, InviteScope, SessionMeta
from sanba_shared.repository import SessionRepository

from sanba_agent.main import SANBAAgent
from sanba_agent.prefetch import (
    REASON_EMPTY,
    REASON_EXPIRED_TIME,
    REASON_EXPIRED_TURNS,
    REASON_HIT,
    REASON_QUERY_MISMATCH,
    PrefetchCache,
    query_overlap,
)
from sanba_agent.retrieval import GroundingStore


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


RESULT = {"passages": [{"text": "t", "source": "s1:participant", "kind": "utterance"}]}


# ---- PrefetchCache（純ロジック） ------------------------------------------


def test_hit_within_ttl() -> None:
    clock = FakeClock()
    cache = PrefetchCache(clock=clock)
    cache.put("ログイン画面の認証方式", RESULT, turn=1, search_seconds=0.5)
    clock.advance(30.0)
    entry, reason = cache.get("ログイン画面の認証方式", turn=1)
    assert reason == REASON_HIT
    assert entry is not None and entry.result == RESULT


def test_expired_by_time_drops_entry() -> None:
    clock = FakeClock()
    cache = PrefetchCache(clock=clock)
    cache.put("ログイン画面の認証方式", RESULT, turn=1, search_seconds=0.5)
    clock.advance(61.0)
    entry, reason = cache.get("ログイン画面の認証方式", turn=1)
    assert entry is None and reason == REASON_EXPIRED_TIME
    # 失効時に破棄済み（2 回目は empty）。
    _, reason2 = cache.get("ログイン画面の認証方式", turn=1)
    assert reason2 == REASON_EMPTY


def test_expired_by_turns() -> None:
    # ユーザー確定発話 2 ターンで失効（会話が進んだら古い先読みは使わない 決定2）。
    cache = PrefetchCache(clock=FakeClock())
    cache.put("ログイン画面の認証方式", RESULT, turn=1, search_seconds=0.5)
    entry, reason = cache.get("ログイン画面の認証方式", turn=3)
    assert entry is None and reason == REASON_EXPIRED_TURNS


def test_query_mismatch_keeps_entry_for_similar_query() -> None:
    # 語彙が重ならない検索語には使わないが、エントリは破棄しない（同一ターン内で
    # モデルが別観点→類似観点の順に検索することがある）。
    cache = PrefetchCache(clock=FakeClock())
    cache.put("ログイン画面の認証方式はどうしますか", RESULT, turn=1, search_seconds=0.5)
    entry, reason = cache.get("決済手数料の負担者", turn=1)
    assert entry is None and reason == REASON_QUERY_MISMATCH
    # モデルの言い換え（部分語彙）にはヒットする。
    entry2, reason2 = cache.get("ログイン画面 認証", turn=1)
    assert reason2 == REASON_HIT and entry2 is not None


def test_latest_wins_replaces_previous_entry() -> None:
    cache = PrefetchCache(clock=FakeClock())
    cache.put("ログイン画面の認証方式", RESULT, turn=1, search_seconds=0.5)
    newer = {"passages": []}
    cache.put("決済手数料の負担者はだれか", newer, turn=2, search_seconds=0.3)
    entry, reason = cache.get("ログイン画面の認証方式", turn=2)
    assert entry is None and reason == REASON_QUERY_MISMATCH
    entry2, _ = cache.get("決済手数料の負担者", turn=2)
    assert entry2 is not None and entry2.result == newer


def test_query_overlap_empty_tokens() -> None:
    assert query_overlap("", "ログイン") == 0.0


# ---- SANBAAgent 統合（メモリ fallback） ------------------------------------


def _developer_repo() -> SessionRepository:
    repo = SessionRepository()
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    repo.create_session_doc(SessionMeta(id="s1", title="t", owner_sub="owner", owner_email=""))
    repo.set_session_github(
        "s1",
        repo="octo/secret",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))
    return repo


def _grounding() -> GroundingStore:
    g = GroundingStore()
    assert g.is_memory is True
    g.index_passage("請求書の画面で保存に困った", "s1:participant", "utterance", "s1")
    g.index_passage(
        "請求書の画面の実装コード",
        "github:octo/secret@main@sha1:src/billing.py#0",
        "context",
        "s1",
    )
    return g


async def _await_prefetch(agent: SANBAAgent) -> None:
    task = agent._prefetch_task
    assert task is not None, "確定発話でプリフェッチが発火していること"
    await task


@pytest.mark.asyncio
async def test_prefetch_hit_skips_sync_search() -> None:
    repo = _developer_repo()
    agent = SANBAAgent("s1", repo, _grounding())
    sync_calls = 0
    original = agent._grounded_search

    def _counting(query: str) -> dict:
        nonlocal sync_calls
        sync_calls += 1
        return original(query)

    agent._grounded_search = _counting  # type: ignore[method-assign]
    agent.record_utterance("participant", "請求書の画面で保存に困った")
    await _await_prefetch(agent)
    assert sync_calls == 1  # 先読みの 1 回だけ

    tool = type(agent).search_grounding.__wrapped__
    result = await tool(agent, None, "請求書の画面 保存")
    assert sync_calls == 1, "ヒット時は同期検索を実行しない"
    assert result["passages"], "先読み結果がそのまま返る"


@pytest.mark.asyncio
async def test_prefetch_end_user_cache_holds_only_filtered_output() -> None:
    # キャッシュには出力制御通過後の結果しか入らない。end_user の
    # 先読み結果に repo 由来（github:）が現れないことを、ヒット返答で機械検証する。
    repo = SessionRepository()
    assert repo._client is None
    repo.create_session_doc(
        SessionMeta(
            id="s1",
            title="t",
            owner_sub="owner",
            owner_email="",
            interview_mode=InviteScope.END_USER,
        )
    )
    agent = SANBAAgent("s1", repo, _grounding())
    agent.record_utterance("participant", "請求書の画面で保存に困った")
    await _await_prefetch(agent)

    entry = agent._prefetch._entry
    assert entry is not None
    dumped = json.dumps(entry.result, ensure_ascii=False).lower()
    assert "github:" not in dumped
    assert "octo/secret" not in dumped

    tool = type(agent).search_grounding.__wrapped__
    result = await tool(agent, None, "請求書の画面 保存")
    assert "github:" not in json.dumps(result, ensure_ascii=False).lower()


@pytest.mark.asyncio
async def test_prefetch_acl_recheck_falls_back_when_link_revoked() -> None:
    # 先読み後に owner が GitHub 連携を解除した窓（≤TTL）: 古い ACL で通した repo chunk を
    # 返さず、同期検索（revoked 遮断）へフォールバックする。
    repo = _developer_repo()
    agent = SANBAAgent("s1", repo, _grounding())
    agent.record_utterance("participant", "請求書の画面で保存に困った")
    await _await_prefetch(agent)
    entry = agent._prefetch._entry
    assert entry is not None
    assert any(p["source"].startswith("github:") for p in entry.result["passages"]), (
        "developer の先読みには repo chunk が入る（前提確認）"
    )

    def _revoked(sub: str) -> GitHubLink | None:
        return None

    repo.get_github_link = _revoked  # type: ignore[method-assign]
    tool = type(agent).search_grounding.__wrapped__
    result = await tool(agent, None, "請求書の画面 保存")
    assert "github:" not in json.dumps(result, ensure_ascii=False).lower()


@pytest.mark.asyncio
async def test_prefetch_timeout_is_fail_soft(monkeypatch: pytest.MonkeyPatch) -> None:
    # 検索タイムアウト（fail-soft）: 例外は漏れず、キャッシュは空のまま（次のツール
    # 呼び出しは同期検索＝従来どおり）。
    import time as _time

    repo = _developer_repo()
    agent = SANBAAgent("s1", repo, _grounding())

    def _slow(query: str) -> dict:
        _time.sleep(0.3)
        return {"passages": []}

    agent._grounded_search = _slow  # type: ignore[method-assign]
    monkeypatch.setattr("sanba_agent.main.PREFETCH_TIMEOUT_SECONDS", 0.05)
    agent.record_utterance("participant", "請求書の画面で保存に困った")
    task = agent._prefetch_task
    assert task is not None
    await task  # TimeoutError はタスク内で処理される
    assert agent._prefetch._entry is None


@pytest.mark.asyncio
async def test_prefetch_acl_recheck_timeout_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ACL 再検証がタイムアウト/障害で判定不能なときは fail-closed: ヒットを捨てて
    # 最新 ACL を適用する同期検索へ倒す（sanba-reviewer P1 の回帰テスト）。
    repo = _developer_repo()
    agent = SANBAAgent("s1", repo, _grounding())
    agent.record_utterance("participant", "請求書の画面で保存に困った")
    await _await_prefetch(agent)
    assert agent._prefetch._entry is not None

    def _hang_access(sub: str) -> GitHubLink:
        import time as _time

        _time.sleep(0.3)
        return GitHubLink(sub="owner", installation_id=1, github_login="octo")

    repo.get_github_link = _hang_access  # type: ignore[method-assign]
    monkeypatch.setattr("sanba_agent.main.ACL_RECHECK_TIMEOUT_SECONDS", 0.05)
    sync_calls = 0
    original = agent._grounded_search

    def _counting(query: str) -> dict:
        nonlocal sync_calls
        sync_calls += 1
        return original(query)

    agent._grounded_search = _counting  # type: ignore[method-assign]
    tool = type(agent).search_grounding.__wrapped__
    await tool(agent, None, "請求書の画面 保存")
    assert sync_calls == 1, "判定不能ならヒットを使わず同期検索へフォールバック"


@pytest.mark.asyncio
async def test_prefetch_latest_wins_cancels_inflight_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 2 発話目で背景分析（段階B）も発火するため、高速スタブに差し替えてからドレンする。
    from sanba_shared.models import AnalysisResult

    async def _stub(transcript: str) -> AnalysisResult:
        return AnalysisResult(summary="s", next_question="q?", suggested_answer="a")

    monkeypatch.setattr("sanba_agent.main.analyze_transcript", _stub)
    repo = _developer_repo()
    agent = SANBAAgent("s1", repo, _grounding())
    agent.record_utterance("participant", "請求書の画面で保存に困った")
    first = agent._prefetch_task
    assert first is not None
    agent.record_utterance("participant", "決済手数料の負担者を決めたい")
    second = agent._prefetch_task
    assert second is not None and second is not first
    await asyncio.gather(first, second, return_exceptions=True)
    assert first.cancelled() or first.done()
    await agent.drain_background_tasks()
