#!/usr/bin/env python3
"""ADR 索引を docs/adr/ の各ファイルから生成し docs/adr/README.md に書き出す。

各 ADR の先頭メタ（H1 タイトル・`- ステータス:` 行）を読み、番号順の一覧表を作る。
ステータスは制御語彙（Proposed / Accepted / Superseded by ADR-NNNN / Deprecated）の
先頭トークンで解釈し、注釈が付いていても崩れないようにする。

使い方: `just docs-index`（または `python3 scripts/gen-docs-index.py`）。
CI で `--check` を付けると、生成結果が現在の docs/adr/README.md と一致するか検証する
（差分があれば非ゼロ終了 = 索引の更新漏れを検出）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ADR_DIR = Path(__file__).resolve().parent.parent / "docs" / "adr"
OUT = ADR_DIR / "README.md"
NAME_RE = re.compile(r"^(\d{4})-.*\.md$")
H1_RE = re.compile(r"^#\s*ADR-\d{4}:\s*(.+?)\s*$")
STATUS_RE = re.compile(r"^-\s*ステータス:\s*(.+?)\s*$")
SUPERSEDE_RE = re.compile(r"(ADR-\d{4})")


def classify(raw: str) -> str:
    """ステータス行の生値から表示用ラベルを返す（制御語彙の先頭トークン）。"""
    if raw.startswith("Superseded"):
        m = SUPERSEDE_RE.search(raw)
        return f"Superseded by {m.group(1)}" if m else "Superseded"
    for token in ("Deprecated", "Accepted", "Proposed"):
        if raw.startswith(token):
            return token
    # 予期しない表記はそのまま短く出す（正規化漏れの可視化）
    return raw.split("（")[0].split("(")[0].strip() or raw


def parse(path: Path) -> tuple[str, str, str]:
    number = path.name[:4]
    title, status = "", "?"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not title:
            m = H1_RE.match(line)
            if m:
                title = m.group(1)
        m = STATUS_RE.match(line)
        if m:
            status = classify(m.group(1))
            break
    return number, title or path.stem, status


def render() -> str:
    rows = []
    for p in sorted(ADR_DIR.glob("[0-9]*.md")):
        if not NAME_RE.match(p.name):
            continue
        num, title, status = parse(p)
        rows.append((num, title, status, p.name))

    lines = [
        "# ADR 索引",
        "",
        "> このファイルは `just docs-index`（`scripts/gen-docs-index.py`）で生成する。",
        "> 手で編集しない。ADR を追加・改訂したら再生成する。",
        "",
        f"設計判断記録（Architecture Decision Record）の一覧。全 {len(rows)} 件。",
        "書き方・ステータス制御語彙は [`/adr` 雛形](../../.claude/commands/adr.md) を参照。",
        "",
        "| # | タイトル | ステータス |",
        "|---|---|---|",
    ]
    for num, title, status, name in rows:
        lines.append(f"| [{num}]({name}) | {title} | {status} |")
    lines.append("")
    lines.append(
        "付随資料は [`supplements/`](supplements/) に置く（特定 ADR の実測・検証データ）。"
    )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    content = render()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != content:
            print(
                "ADR 索引が最新ではない。`just docs-index` を実行して commit すること。",
                file=sys.stderr,
            )
            return 1
        print("ADR 索引は最新。")
        return 0
    OUT.write_text(content, encoding="utf-8")
    print(
        f"生成: {OUT.relative_to(ADR_DIR.parent.parent)}（{content.count(chr(10) + '| [')} 件）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
