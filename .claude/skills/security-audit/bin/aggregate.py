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
    p = path.replace(repo + "/", "").replace(repo, "")
    return p.lstrip("/")


def sev(f: dict) -> str:
    return (f.get("verdict") or {}).get("severity") or f.get("severity") or "P2"


def main() -> int:
    ap = argparse.ArgumentParser(description="Aggregate workflow audit output into a normalized audit.json.")
    ap.add_argument("--input", required=True, help="workflow output file (task .output or raw result json)")
    ap.add_argument("--repo", default=".", help="repository root (for path normalization)")
    ap.add_argument("--out", required=True, help="output work directory")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    os.makedirs(args.out, exist_ok=True)
    data = load_result(args.input)
    confirmed = data.get("confirmed", [])
    uncertain = data.get("uncertain", [])
    refuted = data.get("refuted", [])

    for coll in (confirmed, uncertain, refuted):
        for f in coll:
            f["file"] = rel(str(f.get("file", "")), repo)

    order = {"P1": 0, "P2": 1}
    confirmed.sort(key=lambda f: (order.get(sev(f), 9), f.get("unit", ""), f.get("file", ""), f.get("line", 0)))
    for i, f in enumerate(confirmed, 1):
        f["_id"] = f"SEC-{i:03d}"

    cfbu = {}
    for u, fl in (data.get("confirmedFilesByUnit") or {}).items():
        cfbu[u] = [rel(str(x), repo) for x in fl]

    out = {
        "totals": {
            "raw": (data.get("totals") or {}).get("raw"),
            "confirmed": len(confirmed),
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
    print(f"confirmed: {t['confirmed']} (P1 {t['p1']} / P2 {t['p2']})  uncertain: {t['uncertain']}  refuted: {t['refuted']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
