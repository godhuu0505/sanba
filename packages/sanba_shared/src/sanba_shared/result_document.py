"""要件結果ドキュメントの整形（audience 別出力フォーマット / ADR-0039・0040）。

アプリ管理画面で登録された（または既定の）出力フォーマット（Markdown テンプレート）へ、
確定要件・確認項目などを機械的に埋め込む。LLM 追加呼び出しはしない（repo 要約シードと
同じ方針）。純粋な整形関数のみで、ネットワーク・Firestore に依存しない（単体テスト対象）。

api の閲覧エンドポイント（result-document）と、api / agent 双方の GitHub Issue 起票が
同じレンダラを使う（本文整形の実装を 1 つに保つ / ADR-0040 決定3）。要件は契約 §3 の
requirement 形（dict）で受け取り、agent の `Requirement` モデルは
`requirements_to_render_dicts` で変換する。

テンプレートのプレースホルダ仕様は `output_formats` モジュールの docstring を正とする。
"""

from __future__ import annotations

import re
from typing import Any

from .models import Requirement, RequirementStatus

_PRIORITY_ORDER = ["must", "should", "could", "wont"]
# 企画者にもそのまま見せられるよう MoSCoW に日本語注記を併記する（閲覧ドキュメント・
# Issue 本文の両方で使うため、読み手に寄せた表記に統一する）。
_PRIORITY_LABELS = {
    "must": "Must（必須）",
    "should": "Should（重要）",
    "could": "Could（できれば）",
    "wont": "Won't（今回はやらない）",
}

_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def issue_title(session_id: str) -> str:
    """GitHub Issue 起票時の標題（api / agent で同一の形を保つ）。"""
    return f"要件定義: {session_id}"


def requirements_to_render_dicts(requirements: list[Requirement]) -> list[dict[str, Any]]:
    """agent の `Requirement` モデルを契約 §3 相当のレンダラ入力へ変換する。

    契約の会話軸と同じく、管理レビューで却下（rejected）されたものだけを非確定
    （status=draft = 文書に載せない）へ落とす（api の requirement_doc_to_contract と
    同じ倒し方）。
    """
    return [
        {
            "statement": r.statement,
            "category": r.category.value,
            "priority": r.priority.value,
            "status": "draft" if r.status is RequirementStatus.REJECTED else "confirmed",
        }
        for r in requirements
    ]


def _confirmed(requirements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """契約形（§3）の要件から確定分のみを残す（rejected は contract 上 draft に落ちている）。"""
    return [r for r in requirements if r.get("status") == "confirmed"]


def _requirements_grouped(requirements: list[dict[str, Any]]) -> str:
    """確定要件を MoSCoW 見出しでグループ化した Markdown（企画者/開発者向け）。

    テンプレート側の `##` 直下に埋まる前提で見出しは `###` にする。
    """
    confirmed = _confirmed(requirements)
    if not confirmed:
        return "（確定した要件はありません）"
    lines: list[str] = []
    for pr in _PRIORITY_ORDER:
        group = [r for r in confirmed if r.get("priority") == pr]
        if not group:
            continue
        lines.append(f"### {_PRIORITY_LABELS[pr]}")
        lines.extend(
            f"- [{r.get('category', 'functional')}] {r.get('statement', '')}" for r in group
        )
        lines.append("")
    return "\n".join(lines).strip()


def _requirements_plain(requirements: list[dict[str, Any]]) -> str:
    """確定要件のフラットな箇条書き（利用者向け。優先度・分類の開発語彙を出さない）。"""
    confirmed = _confirmed(requirements)
    if not confirmed:
        return "（お聞きした内容はありませんでした）"
    return "\n".join(f"- {r.get('statement', '')}" for r in confirmed)


def _check_items_block(check_items: list[str]) -> str:
    items = [c.strip() for c in check_items if c.strip()]
    if not items:
        return "（確認項目は登録されていません）"
    return "\n".join(f"- {c}" for c in items)


def render_result_document(
    template: str,
    *,
    session_title: str,
    app_name: str | None,
    goal: str | None,
    date: str,
    requirements: list[dict[str, Any]],
    check_items: list[str],
) -> str:
    """テンプレートの `{{placeholder}}` を埋めて Markdown 文書を返す。

    置換はテンプレート本文への単一パスで行い、埋め込んだ値（発話由来の要件文など）に
    含まれる `{{...}}` を再走査しない（利用者入力でプレースホルダを偽装されても
    そのまま文字列として残る）。未知のプレースホルダは置換せず残す（テンプレート編集時に
    気づける方が黙って消えるより安全）。
    """
    values = {
        "session_title": session_title.strip() or "（無題）",
        "app_name": (app_name or "").strip() or "（未設定）",
        "goal": (goal or "").strip() or "（未設定）",
        "date": date,
        "requirements": _requirements_grouped(requirements),
        "requirements_plain": _requirements_plain(requirements),
        "check_items": _check_items_block(check_items),
    }

    def _sub(m: re.Match[str]) -> str:
        return values.get(m.group(1), m.group(0))

    return _PLACEHOLDER.sub(_sub, template).strip() + "\n"
