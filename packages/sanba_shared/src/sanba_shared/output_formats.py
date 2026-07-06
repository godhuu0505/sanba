"""要件結果の出力フォーマット（利用者/企画者/開発者）の既定テンプレートと解決。

出力フォーマットはアプリ管理画面（web /products/{id}）で audience ごとに 1 つ登録でき、
未登録の audience はここの既定テンプレートへフォールバックする。テンプレートは Markdown
で、`{{placeholder}}` を api 層のレンダラ（apps/api の result_document）が機械的に
置換する（LLM 追加呼び出しなし / repo 要約シードと同じ方針）。

利用できるプレースホルダ:
- `{{session_title}}` セッション標題
- `{{app_name}}`      対象アプリ名（product 未従属なら「（未設定）」）
- `{{goal}}`          準備フォームのゴール（未入力なら「（未設定）」)
- `{{date}}`          作成日 (YYYY-MM-DD)
- `{{requirements}}`  確定要件（MoSCoW 見出しでグループ化した Markdown）
- `{{requirements_plain}}` 確定要件（優先度語彙を出さないフラットな箇条書き。利用者向け）
- `{{check_items}}`   セッションで確認する項目として登録されていた項目の箇条書き
"""

from __future__ import annotations

from .models import Audience, Product

# audience ごとの既定テンプレート。登録が無いときに必ずこれが使われる（「セットしなければ
# デフォルト」の要求）。利用者向けは開発語彙（MoSCoW・非機能等）を出さない（ADR-0032 の
# end_user 語彙方針と同じ倒し方）。
DEFAULT_OUTPUT_FORMATS: dict[Audience, str] = {
    Audience.END_USER: """\
# {{app_name}} についてお聞きした内容のまとめ

- お話のテーマ: {{session_title}}
- 日付: {{date}}

## お聞きしたご要望・お困りごと

{{requirements_plain}}

## お話のなかで確認させていただいた項目

{{check_items}}

ご協力ありがとうございました。いただいたお話はサービスの改善に活用します。
""",
    Audience.PLANNER: """\
# 要件サマリー（企画者向け）: {{session_title}}

- 対象アプリ: {{app_name}}
- ゴール: {{goal}}
- 作成日: {{date}}

## 実現したいこと（優先度順）

{{requirements}}

## セッションで確認した項目

{{check_items}}

## 次のアクション

- 上記要件の優先度・スコープをステークホルダーと合意する
- 未確定の論点があれば次回セッションで深掘りする
""",
    Audience.DEVELOPER: """\
# 要件定義書（開発者向け）: {{session_title}}

- 対象アプリ: {{app_name}}
- ゴール: {{goal}}
- 作成日: {{date}}

## 確定要件（MoSCoW）

{{requirements}}

## セッションで確認した項目

{{check_items}}

## 備考

- 各要件の分類（functional / non_functional / constraint / scope / open_question）は
  要件行の先頭タグを参照。
- 出所・引用はセッションの要件絵巻（web）で確認できる。
""",
}


def resolve_output_format(product: Product | None, audience: Audience) -> tuple[str, bool]:
    """audience の出力フォーマットを解決する。

    戻り値は `(template, is_custom)`。product 未従属（単発セッション）・未登録・
    空文字登録はいずれも既定テンプレートへフォールバックする（is_custom=False）。
    """
    if product is not None:
        custom = (product.output_formats.get(audience) or "").strip()
        if custom:
            return custom, True
    return DEFAULT_OUTPUT_FORMATS[audience], False
