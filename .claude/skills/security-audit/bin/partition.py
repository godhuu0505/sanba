from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

EXCLUDE_EXT = {
    "md",
    "lock",
    "png",
    "ico",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "gitkeep",
    "map",
}
EXCLUDE_BASENAMES = {
    "package-lock.json",
    "uv.lock",
    ".terraform.lock.hcl",
    "poetry.lock",
    "yarn.lock",
    "pnpm-lock.yaml",
}
TEST_PATTERNS = [
    re.compile(r"(^|/)tests?/"),
    re.compile(r"(^|/)test_[^/]+\.py$"),
    re.compile(r"[^/]+_test\.py$"),
    re.compile(r"\.test\.(ts|tsx|js|jsx|py)$"),
    re.compile(r"\.spec\.(ts|tsx|js|jsx)$"),
    re.compile(r"(^|/)e2e/"),
    re.compile(r"(^|/)__mocks__/"),
]


def is_target(path: str) -> bool:
    base = path.rsplit("/", 1)[-1]
    if base in EXCLUDE_BASENAMES:
        return False
    ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
    if ext in EXCLUDE_EXT:
        return False
    for pat in TEST_PATTERNS:
        if pat.search(path):
            return False
    return True


def module_key(path: str) -> str:
    parts = path.split("/")
    if parts[0] in {"apps", "packages", "services", "libs"} and len(parts) >= 2:
        return "/".join(parts[:2])
    if parts[0] in {".github", "infra", "scripts", "docs", "tools", "deploy"}:
        return parts[0] if len(parts) == 1 else "/".join(parts[:2])
    if len(parts) == 1:
        return "(root)"
    return parts[0]


def sub_key(path: str, mod: str) -> str:
    rest = path[len(mod) :].lstrip("/")
    seg = rest.split("/")
    if len(seg) >= 2:
        return seg[0]
    return "_"


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "unit"


def partition(files: list[str], max_per_unit: int) -> list[dict]:
    groups: dict[str, list[str]] = {}
    for f in files:
        groups.setdefault(module_key(f), []).append(f)
    units: list[dict] = []
    for mod, mfiles in sorted(groups.items()):
        mfiles.sort()
        if len(mfiles) <= max_per_unit:
            units.append({"name": slug(mod), "files": mfiles})
            continue
        subs: dict[str, list[str]] = {}
        for f in mfiles:
            subs.setdefault(sub_key(f, mod), []).append(f)
        bucket: list[str] = []
        idx = 1
        for _sk, sfiles in sorted(subs.items()):
            for f in sfiles:
                bucket.append(f)
                if len(bucket) >= max_per_unit:
                    units.append({"name": f"{slug(mod)}-{idx}", "files": bucket})
                    bucket = []
                    idx += 1
        if bucket:
            name = f"{slug(mod)}-{idx}" if idx > 1 else slug(mod)
            units.append({"name": name, "files": bucket})
    return units


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build audit target list and unit partition from git ls-files."
    )
    ap.add_argument("--repo", default=".", help="repository root")
    ap.add_argument("--out", required=True, help="output work directory")
    ap.add_argument("--max-per-unit", type=int, default=25)
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    os.makedirs(args.out, exist_ok=True)
    tracked = subprocess.run(
        ["git", "-C", repo, "ls-files", "-z"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split("\0")
    targets = sorted(f for f in tracked if f.strip() and is_target(f))
    with open(os.path.join(args.out, "audit_targets.txt"), "w") as fh:
        fh.write("\n".join(targets) + "\n")
    units = partition(targets, args.max_per_unit)
    total = sum(len(u["files"]) for u in units)
    payload = {"repo": repo, "total": total, "units": units}
    with open(os.path.join(args.out, "units.json"), "w") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    print(f"targets: {len(targets)}  units: {len(units)}  partitioned: {total}")
    if total != len(targets):
        print("WARNING: partitioned count != targets", file=sys.stderr)
        return 1
    for u in units:
        print(f"  {len(u['files']):>3}  {u['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
