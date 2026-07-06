"""要件結果ドキュメントの整形（result_document.render_result_document）の単体テスト。

純粋な整形関数のみを対象にする（ネットワーク・Firestore なし）。エンドポイント込みの
結合は apps/api の test_product_result_config_api.py が担う。
"""

from __future__ import annotations

from typing import Any

from sanba_shared.result_document import (
    render_result_document,
)


def _req(
    statement: str,
    *,
    priority: str = "must",
    category: str = "functional",
    status: str = "confirmed",
) -> dict[str, Any]:
    return {
        "id": "r1",
        "statement": statement,
        "priority": priority,
        "category": category,
        "status": status,
    }


def _render(template: str, **overrides: Any) -> str:
    kwargs: dict[str, Any] = {
        "session_title": "請求の深掘り",
        "app_name": "請求アプリ",
        "goal": "請求業務を自動化する",
        "date": "2026-07-06",
        "requirements": [],
        "check_items": [],
    }
    kwargs.update(overrides)
    return render_result_document(template, **kwargs)


def test_replaces_all_placeholders() -> None:
    out = _render(
        "# {{session_title}} / {{app_name}} / {{goal}} / {{date}}",
    )
    assert out == "# 請求の深掘り / 請求アプリ / 請求業務を自動化する / 2026-07-06\n"


def test_requirements_grouped_by_moscow_with_category_tag() -> None:
    out = _render(
        "{{requirements}}",
        requirements=[
            _req("CSV を出力できる", priority="should"),
            _req("ログインできる", priority="must", category="non_functional"),
        ],
    )
    # Must が先・見出しは ###・分類タグを併記。
    assert out.index("### Must（必須）") < out.index("### Should（重要）")
    assert "- [non_functional] ログインできる" in out
    assert "- [functional] CSV を出力できる" in out


def test_requirements_plain_hides_dev_vocabulary() -> None:
    out = _render(
        "{{requirements_plain}}",
        requirements=[_req("ボタンが見つけやすくなる", priority="must")],
    )
    assert "- ボタンが見つけやすくなる" in out
    assert "Must" not in out
    assert "functional" not in out


def test_rejected_requirements_are_excluded() -> None:
    # 契約形では rejected は status=draft に落ちている（confirmed のみ載せる）。
    out = _render(
        "{{requirements}}",
        requirements=[_req("却下済み", status="draft"), _req("確定済み")],
    )
    assert "確定済み" in out
    assert "却下済み" not in out


def test_empty_requirements_and_check_items_render_placeholders_text() -> None:
    out = _render("{{requirements}}\n{{check_items}}")
    assert "（確定した要件はありません）" in out
    assert "（確認項目は登録されていません）" in out


def test_check_items_render_as_bullets() -> None:
    out = _render("{{check_items}}", check_items=["ログイン方式", " 課金の有無 ", ""])
    assert "- ログイン方式" in out
    assert "- 課金の有無" in out


def test_empty_optional_fields_fall_back_to_placeholder_text() -> None:
    out = _render("{{app_name}} / {{goal}}", app_name=None, goal=None)
    assert out == "（未設定） / （未設定）\n"


def test_substituted_values_are_not_rescanned_for_placeholders() -> None:
    # 発話由来の要件文にプレースホルダを偽装されても、そのまま文字列として残る。
    out = _render(
        "{{requirements_plain}}",
        requirements=[_req("{{check_items}} を表示したい")],
    )
    assert "- {{check_items}} を表示したい" in out


def test_unknown_placeholders_are_left_as_is() -> None:
    out = _render("{{unknown_thing}}")
    assert out == "{{unknown_thing}}\n"


def test_issue_title_is_stable_across_exporters() -> None:
    from sanba_shared.result_document import issue_title

    # api / agent の起票が同じ標題を使う（本文整形の一本化 / ADR-0043）。
    assert issue_title("sess-1") == "要件定義: sess-1"


def test_requirements_to_render_dicts_maps_models_to_contract_shape() -> None:
    from sanba_shared.models import (
        Priority,
        Requirement,
        RequirementCategory,
        RequirementStatus,
    )
    from sanba_shared.result_document import requirements_to_render_dicts

    reqs = [
        Requirement(
            id="r1",
            category=RequirementCategory.FUNCTIONAL,
            statement="CSV を出力できる",
            priority=Priority.MUST,
        ),
        Requirement(
            id="r2",
            category=RequirementCategory.SCOPE,
            statement="却下済み",
            priority=Priority.COULD,
            status=RequirementStatus.REJECTED,
        ),
    ]
    dicts = requirements_to_render_dicts(reqs)
    assert dicts[0] == {
        "statement": "CSV を出力できる",
        "category": "functional",
        "priority": "must",
        "status": "confirmed",
    }
    # rejected は非確定（draft）に落ち、レンダラが文書から除外する。
    assert dicts[1]["status"] == "draft"
    out = render_result_document(
        "{{requirements}}",
        session_title="t",
        app_name=None,
        goal=None,
        date="2026-07-06",
        requirements=dicts,
        check_items=[],
    )
    assert "CSV を出力できる" in out
    assert "却下済み" not in out
