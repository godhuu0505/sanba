"""要件結果の出力フォーマット（既定テンプレートと解決）のテスト。"""

from __future__ import annotations

from sanba_shared.models import (
    MAX_CHECK_ITEMS,
    Audience,
    CheckItem,
    Product,
)
from sanba_shared.output_formats import DEFAULT_OUTPUT_FORMATS, resolve_output_format


def _product(**kwargs: object) -> Product:
    return Product(id="prod-1", name="請求アプリ", owner_sub="owner", **kwargs)  # type: ignore[arg-type]


def test_default_output_formats_cover_all_audiences() -> None:
    assert set(DEFAULT_OUTPUT_FORMATS) == set(Audience)
    for template in DEFAULT_OUTPUT_FORMATS.values():
        assert "{{" in template


def test_default_end_user_format_avoids_dev_vocabulary() -> None:
    template = DEFAULT_OUTPUT_FORMATS[Audience.END_USER]
    assert "{{requirements_plain}}" in template
    assert "{{requirements}}" not in template.replace("{{requirements_plain}}", "")
    assert "MoSCoW" not in template


def test_resolve_falls_back_to_default_when_unset() -> None:
    template, is_custom = resolve_output_format(_product(), Audience.DEVELOPER)
    assert template == DEFAULT_OUTPUT_FORMATS[Audience.DEVELOPER]
    assert is_custom is False


def test_resolve_falls_back_when_product_is_none() -> None:
    template, is_custom = resolve_output_format(None, Audience.PLANNER)
    assert template == DEFAULT_OUTPUT_FORMATS[Audience.PLANNER]
    assert is_custom is False


def test_resolve_prefers_registered_format() -> None:
    product = _product(output_formats={Audience.PLANNER: "# 独自\n{{requirements}}"})
    template, is_custom = resolve_output_format(product, Audience.PLANNER)
    assert template == "# 独自\n{{requirements}}"
    assert is_custom is True
    template2, is_custom2 = resolve_output_format(product, Audience.END_USER)
    assert template2 == DEFAULT_OUTPUT_FORMATS[Audience.END_USER]
    assert is_custom2 is False


def test_resolve_treats_blank_registration_as_unset() -> None:
    product = _product(output_formats={Audience.DEVELOPER: "   \n  "})
    template, is_custom = resolve_output_format(product, Audience.DEVELOPER)
    assert template == DEFAULT_OUTPUT_FORMATS[Audience.DEVELOPER]
    assert is_custom is False


def test_product_output_fields_roundtrip_json() -> None:
    product = _product(
        output_formats={Audience.DEVELOPER: "# dev"},
        check_items=[
            CheckItem(text="ログイン方式"),
            CheckItem(text="課金の有無", target=Audience.DEVELOPER),
        ],
    )
    data = product.model_dump(mode="json")
    assert data["output_formats"] == {"developer": "# dev"}
    assert data["check_items"] == [
        {"text": "ログイン方式", "target": None},
        {"text": "課金の有無", "target": "developer"},
    ]
    restored = Product.model_validate(data)
    assert restored.output_formats == {Audience.DEVELOPER: "# dev"}
    assert restored.check_items == product.check_items


def test_legacy_product_documents_default_to_empty() -> None:
    restored = Product.model_validate({"id": "prod-1", "name": "t", "owner_sub": "o"})
    assert restored.output_formats == {}
    assert restored.check_items == []


def test_legacy_check_items_str_list_is_coerced_to_check_items() -> None:
    restored = Product.model_validate(
        {"id": "prod-1", "name": "t", "owner_sub": "o", "check_items": ["ログイン方式"]}
    )
    assert restored.check_items == [CheckItem(text="ログイン方式", target=None)]


def test_max_check_items_is_ten() -> None:
    assert MAX_CHECK_ITEMS == 10


def _tagged_items() -> list[CheckItem]:
    from sanba_shared.models import Audience

    return [
        CheckItem(text="全員向け"),
        CheckItem(text="利用者向け", target=Audience.END_USER),
        CheckItem(text="企画者向け", target=Audience.PLANNER),
        CheckItem(text="開発者向け", target=Audience.DEVELOPER),
    ]


def test_check_items_for_scope_filters_by_interview_mode() -> None:
    from sanba_shared.models import InviteScope, check_items_for_scope

    assert check_items_for_scope(_tagged_items(), InviteScope.END_USER) == [
        "全員向け",
        "利用者向け",
    ]
    assert check_items_for_scope(_tagged_items(), InviteScope.DEVELOPER) == [
        "全員向け",
        "企画者向け",
        "開発者向け",
    ]


def test_check_items_for_audience_filters_for_document() -> None:
    from sanba_shared.models import Audience, check_items_for_audience

    assert check_items_for_audience(_tagged_items(), Audience.PLANNER) == [
        "全員向け",
        "企画者向け",
    ]


def test_check_points_prefer_configured_items() -> None:
    """管理者が設定した観点があればモード別デフォルトは出さない（ADR-0055）。"""
    from sanba_shared.models import DEFAULT_CHECK_POINTS, InviteScope, check_points_for_scope

    dev = check_points_for_scope(_tagged_items(), InviteScope.DEVELOPER)
    assert dev == ["全員向け", "企画者向け", "開発者向け"]
    assert dev != DEFAULT_CHECK_POINTS[InviteScope.DEVELOPER]


def test_check_points_fall_back_to_mode_defaults_when_unconfigured() -> None:
    """該当モードの設定が無ければモード別デフォルトを返す（ADR-0055）。"""
    from sanba_shared.models import (
        DEFAULT_CHECK_POINTS,
        Audience,
        InviteScope,
        check_points_for_scope,
    )

    assert (
        check_points_for_scope([], InviteScope.END_USER)
        == DEFAULT_CHECK_POINTS[InviteScope.END_USER]
    )
    assert (
        check_points_for_scope([], InviteScope.DEVELOPER)
        == DEFAULT_CHECK_POINTS[InviteScope.DEVELOPER]
    )

    only_dev = [CheckItem(text="開発者向け", target=Audience.DEVELOPER)]
    assert (
        check_points_for_scope(only_dev, InviteScope.END_USER)
        == DEFAULT_CHECK_POINTS[InviteScope.END_USER]
    )
