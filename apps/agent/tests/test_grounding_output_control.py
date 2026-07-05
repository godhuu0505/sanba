"""grounding 出力制御（ADR-0032 決定8 / FR-2.5 / NFR-2 / PR8）の結合テスト。

end_user セッション（およびモード未確認セッション）では `search_grounding` の返り値が
利用者由来 kind（utterance / requirement）の allowlist に限定され、repo 由来（context の
github: 索引・README/Issue シード）と開発語彙（knowledge）が本文・source ともモデルへ
渡らないことを機械的に検証する。developer セッションは従来どおり repo passage が返る
（回帰）。web へ渡る引用イベント（requirement.upserted の citations）にも repo 由来
source が混ざらないことを、LiveKit ランタイム無しのメモリ fallback で確認する。
"""

from __future__ import annotations

import json

import pytest
from sanba_shared.models import (
    GitHubIndexStatus,
    GitHubLink,
    InviteScope,
    Product,
    SessionMeta,
)
from sanba_shared.repository import SessionRepository

from sanba_agent.events import EventPublisher, RecordingTransport
from sanba_agent.main import SANBAAgent, _partition_passages_for_output
from sanba_agent.retrieval import GroundingStore, Passage

QUERY = "請求書の画面で困ったこと"


def _repo(mode: InviteScope) -> SessionRepository:
    repo = SessionRepository()
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    if mode is InviteScope.END_USER:
        repo.create_product(Product(id="prod-1", name="請求アプリ", owner_sub="owner"))
    repo.create_session_doc(
        SessionMeta(
            id="s1",
            title="t",
            owner_sub="owner",
            owner_email="",
            interview_mode=mode,
            product_id="prod-1" if mode is InviteScope.END_USER else None,
        )
    )
    return repo


def _grounding_with_mixed_passages() -> GroundingStore:
    """利用者由来・repo 由来・開発語彙・アップロード資料が同時にヒットする索引を作る。"""
    g = GroundingStore()
    assert g.is_memory is True
    # 利用者由来（allowlist 対象）。requirement は過去セッション由来でも呼び戻せる（決定8）。
    g.index_passage("請求書の画面で保存に困った", "s1:participant", "utterance", "s1")
    g.index_passage("請求書の画面に検索を付ける", "requirement:req_1", "requirement", "other")
    # repo 由来（ES 索引 chunk / README・Issue シード）: 出力に出てはならない（NFR-2）。
    g.index_passage(
        "[octo/secret src/billing.py]\n請求書の画面の未公開機能コード",
        "github:octo/secret@main@sha1:src/billing.py#0",
        "context",
        "s1",
    )
    g.index_passage("請求書アプリのREADME 画面説明", "github:octo/secret#readme", "context", "s1")
    # 開発語彙 knowledge（FR-2.4: MoSCoW 等は利用者に見せない）。
    g.index_passage("要件は MoSCoW で優先度付けし、請求書の画面も対象", "guide:moscow", "knowledge")
    # owner アップロード資料（kind=context）: 内部資料なので end_user には出さない。
    g.index_passage("アップロード資料: 請求書の画面仕様", "asset:123", "context", "s1")
    return g


async def _search(agent: SANBAAgent) -> dict:
    tool = type(agent).search_grounding.__wrapped__  # function_tool の素の関数
    return await tool(agent, None, QUERY)


@pytest.mark.asyncio
async def test_end_user_search_returns_only_user_derived_kinds() -> None:
    repo = _repo(InviteScope.END_USER)
    agent = SANBAAgent("s1", repo, _grounding_with_mixed_passages())
    assert agent.interview_mode is InviteScope.END_USER
    result = await _search(agent)

    kinds = {p["kind"] for p in result["passages"]}
    assert kinds <= {"utterance", "requirement"}
    assert result["passages"], "利用者由来の呼び戻しは完全遮断しない（ADR-0032 却下代替案）"
    dumped = json.dumps(result["passages"], ensure_ascii=False).lower()
    assert "github:" not in dumped
    assert "octo/secret" not in dumped
    assert "moscow" not in dumped
    assert "asset:123" not in dumped


@pytest.mark.asyncio
async def test_end_user_background_signal_is_count_only() -> None:
    # 決定8「次に聞くことの判断材料」: repo 由来ヒットは件数のみ。内容・出所を含めない。
    repo = _repo(InviteScope.END_USER)
    agent = SANBAAgent("s1", repo, _grounding_with_mixed_passages())
    result = await _search(agent)

    background = result["background"]
    # 件数のみ: speech-to-speech でモデルが読み上げる文章フィールドは付けない（NFR-2）。
    assert set(background.keys()) == {"related_internal_hits"}
    assert background["related_internal_hits"] == 2  # ES chunk + README シード
    assert "octo" not in json.dumps(background, ensure_ascii=False).lower()


@pytest.mark.asyncio
async def test_developer_session_still_gets_repo_passages() -> None:
    # 回帰（FR-2.5 は developer の挙動を変えない）: 確認済み developer は repo chunk も
    # knowledge も従来どおり返り、background は付かない。
    repo = _repo(InviteScope.DEVELOPER)
    repo.set_session_github(
        "s1",
        repo="octo/secret",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))
    agent = SANBAAgent("s1", repo, _grounding_with_mixed_passages())
    assert agent.allow_repo_grounding is True
    result = await _search(agent)

    sources = {p["source"] for p in result["passages"]}
    assert any(s.startswith("github:octo/secret@main@sha1:") for s in sources)
    assert "background" not in result


@pytest.mark.asyncio
async def test_unconfirmed_mode_fails_closed() -> None:
    # セッション文書が読めない（例外）ときはフェイルオープンにせず allowlist に倒す。
    repo = _repo(InviteScope.DEVELOPER)

    def _boom(session_id: str) -> SessionMeta | None:
        raise RuntimeError("firestore down")

    repo.get_session = _boom  # type: ignore[method-assign]
    agent = SANBAAgent("s1", repo, _grounding_with_mixed_passages())
    assert agent.allow_repo_grounding is False
    result = await _search(agent)

    kinds = {p["kind"] for p in result["passages"]}
    assert kinds <= {"utterance", "requirement"}
    assert "github:" not in json.dumps(result, ensure_ascii=False).lower()
    assert result["background"]["related_internal_hits"] == 2


@pytest.mark.asyncio
async def test_missing_session_meta_fails_closed() -> None:
    # get_session() が None を返す（セッション未作成/削除済みの room）場合も
    # フェイルクローズで allowlist に倒す（confirmed=True でも meta is None ならば
    # repo grounding 不許可）。
    repo = _repo(InviteScope.DEVELOPER)

    def _none(session_id: str) -> SessionMeta | None:
        return None

    repo.get_session = _none  # type: ignore[method-assign]
    agent = SANBAAgent("s1", repo, _grounding_with_mixed_passages())
    assert agent.allow_repo_grounding is False
    result = await _search(agent)

    kinds = {p["kind"] for p in result["passages"]}
    assert kinds <= {"utterance", "requirement"}
    assert "github:" not in json.dumps(result, ensure_ascii=False).lower()


def test_partition_is_allowlist_and_resists_source_spoofing() -> None:
    # 遮断は kind の allowlist で決まる: source の大文字小文字・前後空白・形式変更では
    # すり抜けない（denylist の文字列判定に依存しない / security-review 重点）。
    passages = [
        Passage("u", "s1:participant", "utterance"),
        Passage("r", "requirement:req_1", "requirement"),
        Passage("c1", " GITHUB:octo/x@b@s:p", "context"),
        Passage("c2", "GitHub:octo/x#1", "context"),
        Passage("c3", "totally-not-github", "context"),
        Passage("k", "guide:moscow", "knowledge"),
    ]
    kept, dropped_repo, dropped_other = _partition_passages_for_output(passages)
    assert [p.kind for p in kept] == ["utterance", "requirement"]
    # 表記揺れの github source も repo 由来として数える（観測性・background 用の分類）。
    assert dropped_repo == 2
    # source が github に見えなくても allowlist 外なら遮断される（すり抜け無し）。
    assert dropped_other == 2


@pytest.mark.asyncio
async def test_end_user_web_events_carry_no_repo_sources() -> None:
    # NFR-2 の機械的検証（引用イベント経路）: 発話記録 → 検索 → 要件確定の一連で web へ
    # publish される全エンベロープに repo 由来 source が現れない。requirement.upserted の
    # citations は utterance 参照のみ（契約 §3）。
    repo = _repo(InviteScope.END_USER)
    transport = RecordingTransport()
    publisher = EventPublisher("s1", transport)
    agent = SANBAAgent("s1", repo, _grounding_with_mixed_passages(), publisher=publisher)

    agent.record_utterance("participant", "請求書の画面で保存に困りました")
    result = await _search(agent)
    assert "github:" not in json.dumps(result["passages"], ensure_ascii=False).lower()
    save = type(agent).save_requirement.__wrapped__
    await save(agent, None, "請求書の画面で保存結果を分かりやすくする", citations=["u1"])

    dumped = json.dumps([t["event"] for t in transport.sent], ensure_ascii=False).lower()
    assert "github:" not in dumped
    assert "octo/secret" not in dumped
    upserted = [t["event"] for t in transport.sent if t["event"]["type"] == "requirement.upserted"]
    assert upserted
    for ev in upserted:
        assert all(c["kind"] == "utterance" for c in ev["requirement"]["citations"])
