"""interview_mode 分岐と glossary シード（ADR-0032 決定6・7 / PR7）のテスト。

`build_agent_instructions` がセッション文書のモードで instructions を切り替えること、
end_user では glossary をシードし repo 前提を**シードしない**こと（決定8 が PR8 で
入るまでの暫定フェイルクローズ / #321）、読めないときは developer に安全側で
フォールバックすることを、LiveKit ランタイム無しのメモリ fallback で検証する。
"""

from __future__ import annotations

from sanba_shared.models import (
    GitHubIndexStatus,
    InviteScope,
    Product,
    SessionMeta,
)
from sanba_shared.repository import SessionRepository

from sanba_agent.main import (
    build_agent_instructions,
    opening_instructions,
    seed_github_context,
)
from sanba_agent.prompts.interview import (
    DEVELOPER_OPENING_INSTRUCTIONS,
    END_USER_OPENING_INSTRUCTIONS,
    END_USER_VOICE_AGENT_INSTRUCTIONS,
    VOICE_AGENT_INSTRUCTIONS,
)


def _repo() -> SessionRepository:
    repo = SessionRepository()
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    return repo


def _seed_session(
    repo: SessionRepository,
    *,
    mode: InviteScope = InviteScope.DEVELOPER,
    product_id: str | None = None,
    github_repo: str | None = None,
    goal: str | None = None,
    goal_detail: str | None = None,
) -> None:
    repo.create_session_doc(
        SessionMeta(
            id="s1",
            title="t",
            owner_sub="owner",
            owner_email="",
            interview_mode=mode,
            product_id=product_id,
            goal=goal,
            goal_detail=goal_detail,
            github_repo=github_repo,
            github_index_status=(
                GitHubIndexStatus.READY if github_repo else GitHubIndexStatus.NONE
            ),
            github_summary="# 前提リポジトリ: octo/demo" if github_repo else None,
        )
    )


def test_developer_session_keeps_grill_me_with_repo_premise() -> None:
    repo = _repo()
    _seed_session(repo, mode=InviteScope.DEVELOPER, github_repo="octo/demo")
    instructions, mode, allow_repo, _ = build_agent_instructions(repo, "s1")
    assert mode is InviteScope.DEVELOPER
    assert instructions.startswith(VOICE_AGENT_INSTRUCTIONS)
    assert "前提リポジトリ" in instructions  # ADR-0028 の既存挙動は不変
    assert allow_repo is True  # 確認済み developer は GitHub seed も従来どおり


def test_end_user_session_switches_persona_and_seeds_glossary() -> None:
    repo = _repo()
    repo.create_product(
        Product(
            id="prod-1",
            name="請求アプリ",
            owner_sub="owner",
            glossary=["請求書一覧", "明細画面"],
        )
    )
    _seed_session(repo, mode=InviteScope.END_USER, product_id="prod-1")
    instructions, mode, allow_repo, _ = build_agent_instructions(repo, "s1")
    assert mode is InviteScope.END_USER
    assert instructions.startswith(END_USER_VOICE_AGENT_INSTRUCTIONS)
    # glossary シード（FR-2.4）: アプリ名と語彙が機械的に埋め込まれる。
    assert "請求アプリ" in instructions
    assert "請求書一覧" in instructions
    assert "明細画面" in instructions
    assert allow_repo is False  # end_user は GitHub seed を許さない


def test_end_user_session_never_seeds_repo_premise() -> None:
    """#321 暫定フェイルクローズ: repo 紐づけがあっても end_user には前提化しない。"""
    repo = _repo()
    repo.create_product(Product(id="prod-1", name="請求アプリ", owner_sub="owner"))
    _seed_session(repo, mode=InviteScope.END_USER, product_id="prod-1", github_repo="octo/secret")
    instructions, _, allow_repo, _ = build_agent_instructions(repo, "s1")
    assert "octo/secret" not in instructions
    assert "前提リポジトリ" not in instructions
    assert "search_grounding で `octo" not in instructions
    assert allow_repo is False


def test_end_user_session_survives_missing_product() -> None:
    """product 削除済み / product_id なしでも end_user ペルソナで会話は成立する。"""
    repo = _repo()
    _seed_session(repo, mode=InviteScope.END_USER, product_id="prod-gone")
    instructions, mode, allow_repo, _ = build_agent_instructions(repo, "s1")
    assert mode is InviteScope.END_USER
    assert instructions == END_USER_VOICE_AGENT_INSTRUCTIONS

    repo2 = _repo()
    _seed_session(repo2, mode=InviteScope.END_USER, product_id=None)
    instructions2, _, _, _ = build_agent_instructions(repo2, "s1")
    assert instructions2 == END_USER_VOICE_AGENT_INSTRUCTIONS


def test_check_items_seeded_for_developer_session() -> None:
    """product 登録の確認項目は developer セッションの初期 instructions にシードされる。"""
    repo = _repo()
    repo.create_product(
        Product(
            id="prod-1",
            name="請求アプリ",
            owner_sub="owner",
            check_items=["ログイン方式を確認する", "課金の有無を確認する"],
        )
    )
    _seed_session(repo, mode=InviteScope.DEVELOPER, product_id="prod-1")
    instructions, _, _, _ = build_agent_instructions(repo, "s1")
    assert "このセッションで必ず確認する項目" in instructions
    assert "- ログイン方式を確認する" in instructions
    assert "- 課金の有無を確認する" in instructions


def test_check_items_seeded_for_end_user_session_with_translation_rule() -> None:
    """end_user でも確認項目はシードされ、利用者の言葉への言い換え指示が付く。"""
    repo = _repo()
    repo.create_product(
        Product(
            id="prod-1",
            name="請求アプリ",
            owner_sub="owner",
            glossary=["請求書一覧"],
            check_items=["検索機能の使い勝手"],
        )
    )
    _seed_session(repo, mode=InviteScope.END_USER, product_id="prod-1")
    instructions, _, _, _ = build_agent_instructions(repo, "s1")
    assert "- 検索機能の使い勝手" in instructions
    assert "言い換えて確認する" in instructions


def test_check_items_target_filters_by_interview_mode() -> None:
    """対象タグでモードに合う項目だけがシードされる（ADR-0040 決定2）。

    end_user セッションに開発者向け項目を出さない（内部論点の露出防止）。
    developer セッションには企画者向けも合流する（企画者モード未導入の暫定）。
    """
    from sanba_shared.models import Audience, CheckItem

    def _seed_repo() -> SessionRepository:
        repo = _repo()
        repo.create_product(
            Product(
                id="prod-1",
                name="請求アプリ",
                owner_sub="owner",
                check_items=[
                    CheckItem(text="全員向け項目"),
                    CheckItem(text="利用者向け項目", target=Audience.END_USER),
                    CheckItem(text="企画者向け項目", target=Audience.PLANNER),
                    CheckItem(text="開発者向け項目", target=Audience.DEVELOPER),
                ],
            )
        )
        return repo

    repo = _seed_repo()
    _seed_session(repo, mode=InviteScope.END_USER, product_id="prod-1")
    instructions, _, _, _ = build_agent_instructions(repo, "s1")
    assert "全員向け項目" in instructions
    assert "利用者向け項目" in instructions
    assert "企画者向け項目" not in instructions
    assert "開発者向け項目" not in instructions

    repo2 = _seed_repo()
    _seed_session(repo2, mode=InviteScope.DEVELOPER, product_id="prod-1")
    instructions2, _, _, _ = build_agent_instructions(repo2, "s1")
    assert "全員向け項目" in instructions2
    assert "企画者向け項目" in instructions2
    assert "開発者向け項目" in instructions2
    assert "利用者向け項目" not in instructions2


def test_no_check_items_leaves_instructions_unchanged() -> None:
    """確認項目が未登録なら instructions にセクション自体を足さない。"""
    repo = _repo()
    repo.create_product(Product(id="prod-1", name="請求アプリ", owner_sub="owner"))
    _seed_session(repo, mode=InviteScope.DEVELOPER, product_id="prod-1")
    instructions, _, _, _ = build_agent_instructions(repo, "s1")
    assert "必ず確認する項目" not in instructions


def test_missing_session_falls_back_to_developer() -> None:
    """セッション文書が読めないときは既定 developer（既存挙動の安全側）。"""
    repo = _repo()
    instructions, mode, allow_repo, _ = build_agent_instructions(repo, "s-none")
    assert mode is InviteScope.DEVELOPER
    assert instructions == VOICE_AGENT_INSTRUCTIONS


def test_unreadable_session_fails_closed_for_repo_grounding() -> None:
    """/security-review 指摘対応: 文書が読めないときは repo 由来を一切シードしない。

    モードを確認できないまま developer にフェイルオープンすると、end_user セッション
    へ private repo の前提・GitHub seed が混入し得る。developer ペルソナで会話は
    成立させつつ、repo 前提と GitHub seed は止める（`_repo_access` と同じ倒し方）。
    """
    repo = _repo()
    _seed_session(repo, mode=InviteScope.DEVELOPER, github_repo="octo/secret")

    def _boom(session_id: str) -> SessionMeta | None:
        raise RuntimeError("firestore down")

    repo.get_session = _boom  # type: ignore[method-assign]
    instructions, mode, allow_repo, _ = build_agent_instructions(repo, "s1")
    assert mode is InviteScope.DEVELOPER  # 会話は成立させる（既定ペルソナ）
    assert instructions == VOICE_AGENT_INSTRUCTIONS  # repo 前提は付けない
    assert "octo/secret" not in instructions
    assert allow_repo is False  # GitHub seed も止める


def test_opening_instructions_selected_by_mode() -> None:
    assert opening_instructions(InviteScope.DEVELOPER) == DEVELOPER_OPENING_INSTRUCTIONS
    assert opening_instructions(InviteScope.END_USER) == END_USER_OPENING_INSTRUCTIONS


# ---- セッション準備情報の前提化（ADR-0035）--------------------------------------
def test_developer_session_seeds_prep_premise_before_repo_premise() -> None:
    repo = _repo()
    _seed_session(
        repo,
        github_repo="octo/demo",
        goal="検索を速くしたい",
        goal_detail="現状は検索が遅い。まず商品検索だけ対象にしたい。",
    )
    setup = build_agent_instructions(repo, "s1")
    assert "セッション準備情報" in setup.instructions
    assert "検索を速くしたい" in setup.instructions
    assert "商品検索" in setup.instructions
    # 主題（準備情報）が先、repo 前提（裏付け）が後。
    assert setup.instructions.index("セッション準備情報") < setup.instructions.index(
        "前提リポジトリ"
    )
    # analyze へ渡す事前情報ノートも併せて返す（矛盾検知が突き合わせられる）。
    assert "検索を速くしたい" in setup.prep_note


def test_developer_session_without_prep_keeps_existing_shape() -> None:
    repo = _repo()
    _seed_session(repo)
    setup = build_agent_instructions(repo, "s1")
    assert setup.instructions == VOICE_AGENT_INSTRUCTIONS
    assert setup.prep_note == ""


def test_end_user_session_does_not_seed_prep_premise() -> None:
    """end_user は利用者との会話。owner が記入した開発向けゴールは持ち込まない。"""
    repo = _repo()
    repo.create_product(Product(id="prod-1", name="請求アプリ", owner_sub="owner"))
    _seed_session(
        repo, mode=InviteScope.END_USER, product_id="prod-1", goal="開発チーム向けの内部ゴール"
    )
    setup = build_agent_instructions(repo, "s1")
    assert "開発チーム向けの内部ゴール" not in setup.instructions
    assert setup.prep_note == ""


def test_opening_instructions_confirm_goal_when_prep_seeded() -> None:
    from sanba_agent.prompts.interview import DEVELOPER_OPENING_WITH_PREP_INSTRUCTIONS

    assert (
        opening_instructions(InviteScope.DEVELOPER, has_prep_context=True)
        == DEVELOPER_OPENING_WITH_PREP_INSTRUCTIONS
    )
    # end_user は準備情報の有無に依らず利用者向けの開始指示のまま。
    assert (
        opening_instructions(InviteScope.END_USER, has_prep_context=True)
        == END_USER_OPENING_INSTRUCTIONS
    )


def test_seed_github_context_is_importable_for_developer_path() -> None:
    """entrypoint の分岐対象が存在し、connector 無効時は no-op であること（回帰の砦）。"""
    repo = _repo()
    _seed_session(repo, mode=InviteScope.DEVELOPER)

    class _Grounding:
        def index_passage(self, **kwargs: object) -> None:  # pragma: no cover - no-op 期待
            raise AssertionError("connector disabled なら index されない")

    seed_github_context(_Grounding(), "s1", repo, "")  # type: ignore[arg-type]
