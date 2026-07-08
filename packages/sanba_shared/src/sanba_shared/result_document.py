"""要件結果ドキュメントの整形（audience 別出力フォーマット / ADR-0042・0040）。

アプリ管理画面で登録された（または既定の）出力フォーマット（Markdown テンプレート）へ、
確定要件・確認項目などを機械的に埋め込む。LLM 追加呼び出しはしない（repo 要約シードと
同じ方針）。純粋な整形関数のみで、ネットワーク・Firestore に依存しない（単体テスト対象）。

api の閲覧エンドポイント（result-document）と、api / agent 双方の GitHub Issue 起票が
同じレンダラを使う（本文整形の実装を 1 つに保つ / ADR-0043 決定3）。要件は契約 §3 の
requirement 形（dict）で受け取り、agent の `Requirement` モデルは
`requirements_to_render_dicts` で変換する。

テンプレートのプレースホルダ仕様は `output_formats` モジュールの docstring を正とする。
"""

from __future__ import annotations

import re
from typing import Any

from .models import DEFAULT_SESSION_TITLE, Requirement, RequirementStatus

_PRIORITY_ORDER = ["must", "should", "could", "wont"]
_PRIORITY_LABELS = {
    "must": "Must（必須）",
    "should": "Should（重要）",
    "could": "Could（できれば）",
    "wont": "Won't（今回はやらない）",
}

_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def issue_title(session_title: str, session_id: str) -> str:
    """GitHub Issue 起票時の標題（api / agent で同一の形を保つ）。

    要件確定時に Vertex AI で生成したタイトル（`SessionMeta.title` に保存済み）を
    そのまま Issue タイトルに使う。生成前・生成失敗でセッションが既定タイトルのままの
    ときだけ、従来のセッションID書式へフォールバックする（起票元をたどれる目印を残す）。
    """
    title = (session_title or "").strip()
    if not title or title == DEFAULT_SESSION_TITLE:
        return f"要件定義: {session_id}"
    return title


def build_title_prompt(requirements: list[dict[str, Any]]) -> str:
    """確定要件から成果物/Issue の標題を1行生成させるプロンプト（純粋関数）。

    LLM 呼び出しは呼び出し側（api）が行う。ここは整形だけに徹し、単体テスト可能に保つ。
    """
    confirmed = _confirmed(requirements)
    statements = [str(r.get("statement", "")).strip() for r in confirmed]
    body = "\n".join(f"- {s}" for s in statements if s) or "（確定要件なし）"
    return (
        "あなたは要件定義の成果物に短い標題を付ける編集者です。以下の確定要件を読み、"
        "全体を一言で表す日本語のタイトルを1つだけ返してください。\n"
        "制約: 30文字以内、体言止め、記号・引用符・接頭辞（「要件定義:」等）を付けない、"
        "改行やコードブロックを含めない、タイトル本文のみを出力する。\n"
        f"---\n{body}\n---"
    )


def build_summary_prompt(utterances: list[dict[str, Any]]) -> str:
    """会話ログから Issue 用の短い要約を作らせるプロンプト（純粋関数 / P3・Q2 ハイブリッド）。

    LLM 呼び出しは呼び出し側（api）が行う。ここは整形のみ。発話は PII マスク済みの
    text を前提にする（保存時に mask_pii 済み）。長すぎる会話は末尾側を優先して詰める。
    """
    lines: list[str] = []
    for u in utterances:
        speaker = str(u.get("speaker", "")).strip() or "?"
        text = str(u.get("text", "")).strip()
        if text:
            lines.append(f"{speaker}: {text}")
    body = "\n".join(lines[-200:]) or "（発話なし）"
    return (
        "あなたは要件ヒアリングの議事をまとめる編集者です。以下の会話ログを読み、"
        "決まったこと・背景・保留点を第三者が把握できる日本語の要約にしてください。\n"
        "制約: 400字以内、箇条書き可、固有名詞や個人情報を新たに補わない、"
        "ログに無い事実を創作しない、要約本文のみを出力する。\n"
        f"---\n{body}\n---"
    )


def build_materials_block(materials: list[dict[str, Any]], results_url: str) -> str:
    """投入素材を Issue 本文向けに整形する（P3・Q4）。

    GitHub Issue は画像アップロード非対応のため、画像実体は載せず「ファイル名＋解析観察の
    サマリ＋SANBA 結果画面へのリンク」を記す。解析済み（extracted_texts のある）素材を対象に、
    観察は先頭数件だけ載せる（本文の肥大を防ぐ）。対象素材が無ければ空文字（節ごと省く）。
    """
    solved = [m for m in materials if m.get("extracted_texts")]
    if not solved:
        return ""
    lines: list[str] = []
    for m in solved:
        name = str(m.get("name") or m.get("id") or "素材").strip()
        obs = [str(t).strip() for t in m.get("extracted_texts", []) if str(t).strip()][:3]
        lines.append(f"- **{name}**")
        lines.extend(f"  - {o}" for o in obs)
    if results_url:
        lines.append(f"\n詳細: {results_url}")
    return "\n".join(lines).strip()


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


ISSUE_BASE_LABEL = "sanba"


def requirements_to_issue_labels(requirements: list[dict[str, Any]]) -> list[str]:
    """確定要件から GitHub Issue に付けるラベルを機械的に導く（api / agent 共通）。

    ラベルは決め打ちにせず、載っている要件の priority / category から算出する:
    - 常に `sanba`（この Issue が SANBA の起票であることの目印。運用側の絞り込み・自動化の起点）。
    - 出現した priority ごとに `priority:{must|should|could|wont}`。
    - 出現した category ごとにその値（`functional` 等の機械タグ。ダッシュボード集計と同じ語彙）。

    順序は決定的（`sanba` → priority は MoSCoW 順 → category は名前順）で重複は除く。
    リポジトリに存在しないラベルは GitHub が起票時に自動作成する。確定要件が無い場合でも
    `sanba` だけは返す（空 Issue でも起票元をたどれるようにする）。
    """
    confirmed = _confirmed(requirements)
    labels = [ISSUE_BASE_LABEL]
    labels.extend(
        f"priority:{pr}"
        for pr in _PRIORITY_ORDER
        if any(r.get("priority") == pr for r in confirmed)
    )
    labels.extend(sorted({str(r["category"]) for r in confirmed if r.get("category")}))
    return labels


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
