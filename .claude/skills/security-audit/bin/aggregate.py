from __future__ import annotations

import argparse
import json
import os


def load_result(path: str) -> dict:
    raw = open(path).read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find('{"confirmedFilesByUnit"')
        if start < 0:
            start = raw.find("{")
        data = json.loads(raw[start:])
    if isinstance(data, dict) and "result" in data and "confirmed" not in data:
        res = data["result"]
        data = json.loads(res) if isinstance(res, str) else res
    if isinstance(data, str):
        data = json.loads(data)
    return data


def rel(path: str, repo: str) -> str:
    p = str(path or "")
    if p.startswith(repo + "/"):
        p = p[len(repo) + 1 :]
    elif p == repo:
        p = ""
    p = p.lstrip("/")
    while p.startswith("./"):
        p = p[2:]
    return p


def sev(f: dict) -> str:
    return (f.get("verdict") or {}).get("severity") or f.get("severity") or "P2"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Aggregate workflow audit output into a normalized audit.json."
    )
    ap.add_argument(
        "--input",
        required=True,
        help="workflow output file (task .output or raw result json)",
    )
    ap.add_argument(
        "--repo", default=".", help="repository root (for path normalization)"
    )
    ap.add_argument("--out", required=True, help="output work directory")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    os.makedirs(args.out, exist_ok=True)
    data = load_result(args.input)
    if not isinstance(data, dict) or not all(
        k in data and isinstance(data[k], list)
        for k in ("confirmed", "uncertain", "refuted")
    ):
        raise SystemExit(
            "aggregate: 入力が Workflow 監査結果の形式ではありません（confirmed/uncertain/refuted の配列が揃っていません）。"
            "入力ファイルの取り違えや Workflow 失敗の可能性があるため、空の監査を成功扱いにせず中断します。"
        )
    if "confirmedFilesByUnit" not in data or "totals" not in data:
        raise SystemExit(
            "aggregate: Workflow 結果に confirmedFilesByUnit / totals がありません。入力ファイルを確認してください。"
        )
    confirmed = data.get("confirmed", [])
    uncertain = data.get("uncertain", [])
    refuted = data.get("refuted", [])

    for coll in (confirmed, uncertain, refuted):
        for f in coll:
            f["file"] = rel(str(f.get("file", "")), repo)

    order = {"P0": 0, "P1": 1, "P2": 2}
    confirmed.sort(
        key=lambda f: (
            order.get(sev(f), 9),
            f.get("unit", ""),
            f.get("file", ""),
            f.get("line", 0),
        )
    )
    for i, f in enumerate(confirmed, 1):
        f["_id"] = f"SEC-{i:03d}"

    cfbu = {}
    for u, fl in (data.get("confirmedFilesByUnit") or {}).items():
        cfbu[u] = [rel(str(x), repo) for x in fl]

    out = {
        "totals": {
            "raw": (data.get("totals") or {}).get("raw"),
            "verified": (data.get("totals") or {}).get("verified"),
            "truncated": (data.get("totals") or {}).get("truncated", 0),
            "confirmed": len(confirmed),
            "p0": sum(1 for f in confirmed if sev(f) == "P0"),
            "p1": sum(1 for f in confirmed if sev(f) == "P1"),
            "p2": sum(1 for f in confirmed if sev(f) == "P2"),
            "uncertain": len(uncertain),
            "refuted": len(refuted),
        },
        "confirmed": confirmed,
        "uncertain": uncertain,
        "refuted": refuted,
        "confirmedFilesByUnit": cfbu,
    }
    with open(os.path.join(args.out, "audit.json"), "w") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    t = out["totals"]
    print(
        f"confirmed: {t['confirmed']} (P0 {t['p0']} / P1 {t['p1']} / P2 {t['p2']})  uncertain: {t['uncertain']}  refuted: {t['refuted']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
