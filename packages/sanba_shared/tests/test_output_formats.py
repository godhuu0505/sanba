"""要件結果の出力フォーマット（既定テンプレートと解決）のテスト。"""

from __future__ import annotations

from sanba_shared.models import MAX_CHECK_ITEMS, Audience, Product
from sanba_shared.output_formats import DEFAULT_OUTPUT_FORMATS, resolve_output_format


def _product(**kwargs: object) -> Product:
    return Product(id="prod-1", name="請求アプリ", owner_sub="owner", **kwargs)  # type: ignore[arg-type]


def test_default_output_formats_cover_all_audiences() -> None:
    # 利用者/企画者/開発者それぞれに既定が 1 つずつある（「セットしなければデフォルト」の前提）。
    assert set(DEFAULT_OUTPUT_FORMATS) == set(Audience)
    for template in DEFAULT_OUTPUT_FORMATS.values():
        assert "{{" in template  # プレースホルダを持つ Markdown テンプレート


def test_default_end_user_format_avoids_dev_vocabulary() -> None:
    # 利用者向け既定テンプレートは開発語彙（MoSCoW グループの {{requirements}}）を使わない。
    template = DEFAULT_OUTPUT_FORMATS[Audience.END_USER]
    assert "{{requirements_plain}}" in template
    assert "{{requirements}}" not in template.replace("{{requirements_plain}}", "")
    assert "MoSCoW" not in template


def test_resolve_falls_back_to_default_when_unset() -> None:
    template, is_custom = resolve_output_format(_product(), Audience.DEVELOPER)
    assert template == DEFAULT_OUTPUT_FORMATS[Audience.DEVELOPER]
    assert is_custom is False


def test_resolve_falls_back_when_product_is_none() -> None:
    # 単発セッション（product 未従属）でも必ずフォーマットが解決される。
    template, is_custom = resolve_output_format(None, Audience.PLANNER)
    assert template == DEFAULT_OUTPUT_FORMATS[Audience.PLANNER]
    assert is_custom is False


def test_resolve_prefers_registered_format() -> None:
    product = _product(output_formats={Audience.PLANNER: "# 独自\n{{requirements}}"})
    template, is_custom = resolve_output_format(product, Audience.PLANNER)
    assert template == "# 独自\n{{requirements}}"
    assert is_custom is True
    # 登録していない audience は既定のまま。
    template2, is_custom2 = resolve_output_format(product, Audience.END_USER)
    assert template2 == DEFAULT_OUTPUT_FORMATS[Audience.END_USER]
    assert is_custom2 is False


def test_resolve_treats_blank_registration_as_unset() -> None:
    product = _product(output_formats={Audience.DEVELOPER: "   \n  "})
    template, is_custom = resolve_output_format(product, Audience.DEVELOPER)
    assert template == DEFAULT_OUTPUT_FORMATS[Audience.DEVELOPER]
    assert is_custom is False


def test_product_output_fields_roundtrip_json() -> None:
    # Firestore への保存形 (model_dump(mode="json")) と読み戻しで audience キーが保たれる。
    product = _product(
        output_formats={Audience.DEVELOPER: "# dev"},
        check_items=["ログイン方式", "課金の有無"],
    )
    data = product.model_dump(mode="json")
    assert data["output_formats"] == {"developer": "# dev"}
    restored = Product.model_validate(data)
    assert restored.output_formats == {Audience.DEVELOPER: "# dev"}
    assert restored.check_items == ["ログイン方式", "課金の有無"]


def test_legacy_product_documents_default_to_empty() -> None:
    # 旧文書（新フィールドなし）は空でフォールバックする（ADR-0014 §10 と同じ互換方針）。
    restored = Product.model_validate({"id": "prod-1", "name": "t", "owner_sub": "o"})
    assert restored.output_formats == {}
    assert restored.check_items == []


def test_max_check_items_is_ten() -> None:
    # 要求仕様: 確認項目は最大 10 個（API のバリデーションと agent シードが参照する定数）。
    assert MAX_CHECK_ITEMS == 10
