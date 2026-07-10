#!/usr/bin/env python3
"""Fail if a Python file contains a comment other than an allowed pragma.

Rationale lives in CLAUDE.md: comments drift from the code they describe, so
design rationale belongs in commit messages / PR descriptions / ADRs instead.
"""

from __future__ import annotations

import io
import re
import sys
import tokenize
from pathlib import Path

DEFAULT_PATHS = [
    "apps/agent/src",
    "apps/agent/tests",
    "apps/api/src",
    "apps/api/tests",
    "apps/worker/src",
    "apps/worker/tests",
    "packages/sanba_shared/src",
    "packages/sanba_shared/tests",
    "infra/four-keys/collector/src",
    "infra/four-keys/collector/tests",
]

KEEP_PATTERNS = [
    re.compile(r"^\s*-\*-.*coding.*-\*-"),
    re.compile(r"^\s*noqa\b"),
    re.compile(r"^\s*type:\s*ignore\b"),
    re.compile(r"^\s*pragma:\s*no\s*cover\b"),
    re.compile(r"^\s*pylint:"),
    re.compile(r"^\s*ruff:"),
]

EXCLUDE_DIRS = {".venv", "__pycache__", "node_modules", ".git"}


def iter_py_files(root: Path):
    for path in root.rglob("*.py"):
        if any(part in EXCLUDE_DIRS for part in path.parts):
            continue
        yield path


def is_pragma(comment_text: str, line_no: int) -> bool:
    body = comment_text[1:]
    if line_no <= 2 and (body.startswith("!") or "coding" in body):
        return True
    return any(p.search(body) for p in KEEP_PATTERNS)


def check_file(path: Path) -> list[tuple[int, str]]:
    violations = []
    src = path.read_bytes()
    tokens = tokenize.tokenize(io.BytesIO(src).readline)
    for tok in tokens:
        if tok.type == tokenize.COMMENT and not is_pragma(tok.string, tok.start[0]):
            violations.append((tok.start[0], tok.string.strip()))
    return violations


def main(argv: list[str]) -> int:
    repo_root = Path(__file__).resolve().parent.parent
    targets = argv or DEFAULT_PATHS
    exit_code = 0
    for target in targets:
        target_path = repo_root / target
        if not target_path.exists():
            continue
        files = (
            [target_path] if target_path.is_file() else list(iter_py_files(target_path))
        )
        for f in files:
            try:
                rel = f.relative_to(repo_root)
            except ValueError:
                rel = f
            try:
                results = check_file(f)
            except (tokenize.TokenError, SyntaxError, UnicodeDecodeError) as exc:
                print(
                    f"{rel}: コメント検査に失敗しました（検査不能）: {exc}",
                    file=sys.stderr,
                )
                exit_code = 1
                continue
            for line_no, text in results:
                print(f"{rel}:{line_no}: disallowed comment: {text}")
                exit_code = 1
    if exit_code:
        print(
            "\nコメントは原則禁止です（CLAUDE.md）。設計判断の理由はコミットメッセージ/"
            "PR説明/ADRに書いてください。lint/型チェックのpragma（noqa, type: ignore, "
            "pragma: no cover 等）は許可されています。",
            file=sys.stderr,
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
