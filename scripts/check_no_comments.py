#!/usr/bin/env python3
"""Fail if a source file contains a comment other than an allowed pragma.

Covers Python (tokenize), YAML and Terraform (quote-aware line scan).
Rationale lives in CLAUDE.md and ADR-0068: comments drift from the code they
describe, so design rationale belongs in commit messages / PR descriptions /
ADRs / docs instead.
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
    "external-agents/src",
    "external-agents/tests",
    "a2a-facade/src",
    "a2a-facade/tests",
    "a2a-facade/sidecar",
    "a2a-facade/cloudbuild.yaml",
    "infra/terraform-ops",
    ".github",
    "infra/terraform",
    "infra/observability",
    "docker-compose.yml",
    "docker-compose.tools.yml",
]

PY_KEEP_PATTERNS = [
    re.compile(r"^\s*-\*-.*coding.*-\*-"),
    re.compile(r"^\s*noqa\b"),
    re.compile(r"^\s*type:\s*ignore\b"),
    re.compile(r"^\s*pragma:\s*no\s*cover\b"),
    re.compile(r"^\s*pylint:"),
    re.compile(r"^\s*ruff:"),
]

YAML_KEEP_PATTERNS = [
    re.compile(r"^\s*shellcheck\b"),
    re.compile(r"^\s*yamllint\b"),
]

TF_KEEP_PATTERNS = [
    re.compile(r"^\s*tflint-ignore\b"),
    re.compile(r"^\s*checkov:skip\b"),
    re.compile(r"^\s*trivy:ignore\b"),
    re.compile(r"^\s*nosemgrep\b"),
]

ACTION_PIN_LINE = re.compile(r"\buses:\s*\S+@[0-9a-f]{6,}")
ACTION_PIN_NOTE = re.compile(r"^\s*v?\d[\w.\-]*\s*$")

EXCLUDE_DIRS = {".venv", "__pycache__", "node_modules", ".git", ".terraform"}

SUFFIX_CHECKERS: dict[str, str] = {
    ".py": "py",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".tf": "tf",
}


def iter_files(root: Path):
    for path in sorted(root.rglob("*")):
        if any(part in EXCLUDE_DIRS for part in path.parts):
            continue
        if path.is_file() and path.suffix in SUFFIX_CHECKERS:
            yield path


def is_py_pragma(comment_text: str, line_no: int) -> bool:
    body = comment_text[1:]
    if line_no <= 2 and (body.startswith("!") or "coding" in body):
        return True
    return any(p.search(body) for p in PY_KEEP_PATTERNS)


def check_py_file(path: Path) -> list[tuple[int, str]]:
    violations = []
    src = path.read_bytes()
    tokens = tokenize.tokenize(io.BytesIO(src).readline)
    for tok in tokens:
        if tok.type == tokenize.COMMENT and not is_py_pragma(tok.string, tok.start[0]):
            violations.append((tok.start[0], tok.string.strip()))
    return violations


def split_hash_comment(line: str) -> str | None:
    in_single = False
    in_double = False
    i = 0
    while i < len(line):
        ch = line[i]
        if in_double:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_double = False
        elif in_single:
            if ch == "'":
                in_single = False
        elif ch == '"':
            in_double = True
        elif ch == "'":
            in_single = True
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[i:]
        i += 1
    return None


def is_yaml_pragma(line: str, comment: str) -> bool:
    if comment.startswith("#!"):
        return True
    body = comment.lstrip("#")
    if ACTION_PIN_LINE.search(line) and ACTION_PIN_NOTE.match(body):
        return True
    return any(p.search(body) for p in YAML_KEEP_PATTERNS)


def check_yaml_file(path: Path) -> list[tuple[int, str]]:
    violations = []
    text = path.read_text(encoding="utf-8")
    for line_no, line in enumerate(text.splitlines(), 1):
        comment = split_hash_comment(line)
        if comment is None:
            continue
        if is_yaml_pragma(line, comment):
            continue
        violations.append((line_no, comment.strip()))
    return violations


HEREDOC_START = re.compile(r"<<-?\"?(\w+)\"?")


def scan_tf_line(line: str) -> tuple[str | None, bool, str | None]:
    in_string = False
    i = 0
    while i < len(line):
        ch = line[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "#":
            return line[i:], False, None
        elif line.startswith("//", i):
            return line[i:], False, None
        elif line.startswith("/*", i):
            return line[i:], "*/" not in line[i:], None
        elif ch == "<":
            m = HEREDOC_START.match(line, i)
            if m:
                return None, False, m.group(1)
        i += 1
    return None, False, None


def check_tf_file(path: Path) -> list[tuple[int, str]]:
    violations = []
    text = path.read_text(encoding="utf-8")
    heredoc_end: str | None = None
    in_block_comment = False
    for line_no, line in enumerate(text.splitlines(), 1):
        if heredoc_end is not None:
            if line.strip() == heredoc_end:
                heredoc_end = None
            continue
        if in_block_comment:
            violations.append((line_no, line.strip()))
            if "*/" in line:
                in_block_comment = False
            continue
        comment, opens_block, heredoc_end = scan_tf_line(line)
        if opens_block:
            in_block_comment = True
        if comment is None:
            continue
        body = comment.lstrip("#/").lstrip("*")
        if any(p.search(body) for p in TF_KEEP_PATTERNS):
            continue
        violations.append((line_no, comment.strip()))
    return violations


CHECKERS = {
    "py": check_py_file,
    "yaml": check_yaml_file,
    "tf": check_tf_file,
}


def main(argv: list[str]) -> int:
    repo_root = Path(__file__).resolve().parent.parent
    targets = argv or DEFAULT_PATHS
    exit_code = 0
    for target in targets:
        target_path = repo_root / target
        if not target_path.exists():
            continue
        files = (
            [target_path] if target_path.is_file() else list(iter_files(target_path))
        )
        for f in files:
            checker = CHECKERS.get(SUFFIX_CHECKERS.get(f.suffix, ""))
            if checker is None:
                continue
            try:
                rel = f.relative_to(repo_root)
            except ValueError:
                rel = f
            try:
                results = checker(f)
            except (tokenize.TokenError, SyntaxError, UnicodeDecodeError) as exc:
                print(
                    f"{rel}: コメント検査に失敗しました（検査不能）: {exc}",
                    file=sys.stderr,
                )
                exit_code = 1
                continue
            for line_no, comment_text in results:
                print(f"{rel}:{line_no}: disallowed comment: {comment_text}")
                exit_code = 1
    if exit_code:
        print(
            "\nコメントは原則禁止です（CLAUDE.md / ADR-0068）。設計判断の理由はコミット"
            "メッセージ/PR説明/ADR/docs に書いてください。機能的プラグマ（noqa, type: ignore, "
            "pragma: no cover, shellcheck, tflint-ignore, checkov:skip 等）と Action の "
            "SHA ピンに併記するバージョン注記（uses: ...@<sha> # vX.Y.Z）は許可されています。",
            file=sys.stderr,
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
