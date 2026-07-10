from __future__ import annotations

import argparse
import json
import os
from collections import Counter

CAT_LABEL = {
    "A1": "アクセス制御/IDOR/BOLA",
    "A2": "認証・セッション",
    "A3": "インジェクション/XSS",
    "A4": "プロンプトインジェクション/過剰エージェンシー",
    "A5": "SSRF",
    "A6": "暗号・秘密の扱い",
    "A7": "機微情報の露出/PII",
    "A8": "入力検証・逆シリアライズ・ファイル処理",
    "A9": "設定ミス",
    "A10": "コメント内機微情報",
    "B": "バグ/境界/並行性/リソースリーク",
    "C": "過度な複雑性",
    "D": "デッドコード/不要処理",
    "E": "可用性・耐障害性",
    "F": "サプライチェーン/CI",
}


def sev(f):
    return (f.get("verdict") or {}).get("severity") or f.get("severity") or "P2"


def esc(s):
    return (s or "").replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()


def bar(s):
    return esc(s).replace("|", "\\|")


def cats_present(conf):
    return sorted(set(f.get("category", "?") for f in conf), key=lambda c: (c[0], c))


def matrix(conf, out):
    out.append("| 観点 | 説明 | P0 | P1 | P2 | 計 |")
    out.append("|---|---|--:|--:|--:|--:|")
    for c in cats_present(conf):
        cf = [f for f in conf if f.get("category") == c]
        p0 = sum(1 for f in cf if sev(f) == "P0")
        p1 = sum(1 for f in cf if sev(f) == "P1")
        p2 = sum(1 for f in cf if sev(f) == "P2")
        out.append(f"| {c} | {CAT_LABEL.get(c, c)} | {p0} | {p1} | {p2} | {len(cf)} |")
    tp0 = sum(1 for f in conf if sev(f) == "P0")
    tp1 = sum(1 for f in conf if sev(f) == "P1")
    tp2 = sum(1 for f in conf if sev(f) == "P2")
    out.append(f"| **計** | | **{tp0}** | **{tp1}** | **{tp2}** | **{len(conf)}** |")


def cmd_reports(audit, units, targets, dest, head):
    conf = audit["confirmed"]
    byfile = {}
    for f in conf:
        byfile.setdefault(f["file"], []).append(f)

    L = []
    L.append("# セキュリティ監査 — 詳細調査結果（findings）\n")
    L.append(f"- 対象 HEAD: `{head}`")
    L.append(
        "- 方法: マルチエージェント並列（発見 → 敵対的検証）。事実記述のみ、対応方針は含めない。"
    )
    t = audit["totals"]
    L.append(
        f"- 確定 {t['confirmed']} 件（P0 {t.get('p0', 0)} / P1 {t['p1']} / P2 {t['p2']}） / 要確認 {t['uncertain']} / 棄却 {t['refuted']}\n---\n"
    )
    for label, sv in [
        ("P0（緊急）", "P0"),
        ("P1（重大度高）", "P1"),
        ("P2（重大度中〜低）", "P2"),
    ]:
        grp = [f for f in conf if sev(f) == sv]
        L.append(f"## {label} — {len(grp)} 件\n")
        for c in cats_present(grp):
            cf = [f for f in grp if f.get("category") == c]
            L.append(f"### 観点 {c}｜{CAT_LABEL.get(c, c)} — {len(cf)} 件\n")
            for f in cf:
                L.append(
                    f"#### {f['_id']} `{f['file']}:{f.get('line')}` — {esc(f.get('title'))}"
                )
                L.append(f"- 観点/フレームワーク: {c} / {f.get('framework') or '-'}")
                L.append(f"- 事実: {esc(f.get('fact'))}")
                L.append(f"- なぜ問題か: {esc(f.get('why'))}")
                L.append(f"- 顕在化する条件: {esc(f.get('trigger'))}")
                vr = esc((f.get("verdict") or {}).get("reasoning"))
                if vr:
                    L.append(f"- 検証（敵対的再読の判定根拠）: {vr}")
                L.append("")
        L.append("---\n")
    L.append(f"## 要確認（UNCERTAIN） — {len(audit['uncertain'])} 件\n")
    for i, f in enumerate(audit["uncertain"], 1):
        L.append(
            f"#### U-{i:02d} `{f['file']}:{f.get('line')}` — {esc(f.get('title'))}"
        )
        L.append(
            f"- 観点/フレームワーク: {f.get('category')} / {f.get('framework') or '-'}"
        )
        L.append(f"- 事実: {esc(f.get('fact'))}")
        L.append(f"- 検証判定の根拠: {esc((f.get('verdict') or {}).get('reasoning'))}")
        L.append("")
    L.append("---\n")
    L.append(f"## 検証で棄却（REFUTED・非該当） — {len(audit['refuted'])} 件\n")
    L.append("| # | ファイル:行 | 棄却された指摘 | 棄却理由（要約） |")
    L.append("|---|---|---|---|")
    for i, f in enumerate(audit["refuted"], 1):
        reason = esc((f.get("verdict") or {}).get("reasoning")).replace("|", "\\|")
        if len(reason) > 220:
            reason = reason[:217] + "…"
        title = esc(f.get("title")).replace("|", "\\|")
        L.append(f"| {i} | `{f['file']}:{f.get('line')}` | {title} | {reason} |")
    L.append("")
    os.makedirs(dest, exist_ok=True)
    open(os.path.join(dest, "findings.md"), "w").write("\n".join(L))

    L = []
    L.append("# セキュリティ監査 — コードログ（全ファイル確認証跡）\n")
    L.append(f"- 対象 HEAD: `{head}`")
    L.append(
        f"- 監査対象ファイル総数: **{len(targets)}**（テスト・ロック・バイナリ・md を除く全ソース）"
    )
    L.append(
        "- ✓=担当エージェントが全行 Read。指摘数はそのファイルに紐づく確定 finding 件数。\n"
    )
    confirmed_by_unit = audit.get("confirmedFilesByUnit") or {}
    checked = 0
    unconfirmed = []
    for u in units["units"]:
        unit_scope = set(u["files"])
        unit_confirmed = set(confirmed_by_unit.get(u["name"], [])) & unit_scope
        L.append(f"## {u['name']} — {len(u['files'])} ファイル\n")
        L.append("| ファイル | 確認 | 指摘数 | finding ID |")
        L.append("|---|:--:|:--:|---|")
        for rf in u["files"]:
            fids = [x["_id"] for x in byfile.get(rf, [])]
            seen = rf in unit_confirmed
            if seen:
                checked += 1
            else:
                unconfirmed.append(rf)
            mark = "✓" if seen else "—"
            L.append(
                f"| `{rf}` | {mark} | {len(fids)} | {', '.join(fids) if fids else '-'} |"
            )
        L.append("")
    L.append("---\n## 集計\n")
    L.append(f"- 対象総数: **{len(targets)}**")
    L.append(f"- 確認済み（confirmedFiles にあるもの）: **{checked}**")
    L.append(f"- 未確認: **{len(unconfirmed)}**")
    L.append(
        f"- 確定 finding が紐づくファイル数: **{len(byfile)}** / 確定 finding 総数: **{len(conf)}**\n"
    )
    if unconfirmed:
        L.append(
            "### 未確認ファイル（発見エージェントが confirmedFiles に含めなかったもの）\n"
        )
        for rf in unconfirmed:
            L.append(f"- `{rf}`")
        L.append("")
    open(os.path.join(dest, "coverage-log.md"), "w").write("\n".join(L))
    print(
        f"wrote {dest}/findings.md, {dest}/coverage-log.md (targets {len(targets)}, checked {checked})"
    )


def cmd_summary(audit, units, targets, dest, head):
    conf = audit["confirmed"]
    t = audit["totals"]
    L = []
    L.append("# セキュリティ監査 — サマリー\n")
    L.append(f"- 対象 HEAD: `{head}`")
    L.append(f"- 対象規模: 監査対象ソース **{len(targets)} ファイル**")
    L.append(
        "- 方法: マルチエージェント並列（発見単位が担当ファイルを全行読了 → 生指摘 → 各指摘を独立エージェントが該当コード再読で敵対的検証）。"
    )
    L.append(
        "- 制約: 判断根拠は現在のソースコードのみ。docs/ADR・ソース中コメントの説明は挙動判断に不使用。対応方針は含めない。\n"
    )
    L.append("## 結果総数\n")
    L.append("| 区分 | 件数 |\n|---|---|")
    L.append(f"| 生指摘（発見フェーズ） | {t.get('raw')} |")
    L.append(f"| 確定（CONFIRMED） | {t['confirmed']} |")
    L.append(f"| 　└ P0 | {t.get('p0', 0)} |")
    L.append(f"| 　└ P1 | {t['p1']} |")
    L.append(f"| 　└ P2 | {t['p2']} |")
    L.append(f"| 要確認（UNCERTAIN） | {t['uncertain']} |")
    L.append(f"| 検証で棄却（REFUTED） | {t['refuted']} |\n")
    L.append("## 観点 × 重大度 マトリクス（確定のみ）\n")
    matrix(conf, L)
    L.append("")
    L.append("## 単位別 確定指摘数\n")
    L.append("| 監査単位 | 確定指摘 |\n|---|--:|")
    for u, n in Counter(f.get("unit") for f in conf).most_common():
        L.append(f"| {u} | {n} |")
    L.append("")
    L.append("## P0 / P1 一覧（詳細は findings.md）\n")
    L.append("| ID | 重大度 | ファイル:行 | 観点 | 指摘 |\n|---|---|---|---|---|")
    for f in [x for x in conf if sev(x) in ("P0", "P1")]:
        L.append(
            f"| {f['_id']} | {sev(f)} | `{f['file']}:{f.get('line')}` | {f.get('category')} | {bar(f.get('title'))} |"
        )
    L.append("")
    os.makedirs(dest, exist_ok=True)
    open(os.path.join(dest, "summary.md"), "w").write("\n".join(L))
    print(f"wrote {dest}/summary.md")


def cmd_issue_body(audit, head, out):
    conf = audit["confirmed"]
    t = audit["totals"]
    L = []
    L.append(
        f"セキュリティ監査（HEAD `{head}`）で確定した指摘の追跡 issue。**事実の記述のみ**で対応方針は含めない。詳細は `security-audit/findings.md`。\n"
    )
    L.append("## 総数\n")
    L.append(
        f"- 確定 **{t['confirmed']}** 件（P0 {t.get('p0', 0)} / P1 {t['p1']} / P2 {t['p2']}） / 要確認 {t['uncertain']} / 棄却 {t['refuted']}"
    )
    L.append(f"- 生指摘 {t.get('raw')} 件を敵対的検証で絞り込み\n")
    L.append("## 観点 × 重大度\n")
    matrix(conf, L)
    L.append("")
    p0 = [x for x in conf if sev(x) == "P0"]
    if p0:
        L.append("## P0 追跡（緊急）\n")
        for f in p0:
            L.append(
                f"- [ ] **{f['_id']}** `{f['file']}:{f.get('line')}` ({f.get('category')}/{f.get('framework') or '-'}) — {esc(f.get('title'))}"
            )
        L.append("")
    L.append("## P1 追跡\n")
    for f in [x for x in conf if sev(x) == "P1"]:
        L.append(
            f"- [ ] **{f['_id']}** `{f['file']}:{f.get('line')}` ({f.get('category')}/{f.get('framework') or '-'}) — {esc(f.get('title'))}"
        )
    L.append("")
    L.append("## P2 追跡\n")
    for f in [x for x in conf if sev(x) == "P2"]:
        L.append(
            f"- [ ] {f['_id']} `{f['file']}:{f.get('line')}` ({f.get('category')}) — {esc(f.get('title'))}"
        )
    L.append("")
    body = "\n".join(L)
    if out:
        open(out, "w").write(body)
        print(f"wrote {out}")
    else:
        print(body)


def cmd_adr(audit, number, adr_dir, head):
    t = audit["totals"]
    nnnn = f"{int(number):04d}"
    slug = "codebase-security-audit-process"
    path = os.path.join(adr_dir, f"{nnnn}-{slug}.md")
    L = []
    L.append(
        f"# ADR-{nnnn}: 全コード セキュリティ監査プロセス（マルチエージェント並列 + 敵対的検証）\n"
    )
    L.append("- ステータス: Proposed")
    L.append("- 日付: TODO(YYYY-MM-DD を起票時に記入)\n")
    L.append("## コンテキスト\n")
    L.append(
        "全ソースコードに対する定期的なセキュリティ監査を、再現可能で網羅性を機械的に追える形で回したい。"
    )
    L.append(
        "単一エージェントでの逐次レビューは大規模コードベースで漏れ・見落としが生じやすく、指摘の真偽（誤検知）も判別しづらい。\n"
    )
    L.append("## 決定\n")
    L.append("`/security-audit` スキルの手順を標準の監査プロセスとして採用する:")
    L.append(
        "1. `partition.py` で監査対象（テスト/ロック/バイナリ/md を除く全ソース）を列挙し、モジュール/ディレクトリ境界で単位分割する。"
    )
    L.append(
        "2. Workflow オーケストレーションで、発見エージェントが担当ファイルを全行読了し、観点 A〜F（OWASP Top10 / CWE Top25 / API Security Top10 / LLM・Agentic Top10 / ASVS / GitHub Actions hardening）で指摘する。"
    )
    L.append(
        "3. 各指摘を独立した検証エージェントが該当コードを再読して敵対的に検証し、誤検知を棄却する。"
    )
    L.append(
        "4. 確定指摘・全ファイル確認証跡・サマリーを `security-audit/` に出力し、GitHub issue（事実の追跡）と本 ADR（プロセス記録）に反映する。"
    )
    L.append(
        "- 監査は事実記述のみとし、対応方針は含めない（判断は人間が行う。CLAUDE.md 原則1）。"
    )
    L.append(
        "- 判断根拠は現在のソースコードのみ。ソース中コメントは挙動判断に使わず、機微情報漏洩の観点でのみ走査する。\n"
    )
    L.append(
        f"直近の実行結果: 確定 {t['confirmed']} 件（P0 {t.get('p0', 0)} / P1 {t['p1']} / P2 {t['p2']}）、要確認 {t['uncertain']}、棄却 {t['refuted']}。詳細は issue と `security-audit/` を参照。\n"
    )
    L.append("## 検討したが採用しなかった選択肢\n")
    L.append(
        "- 単一エージェントの逐次レビュー: 網羅性・スケールと誤検知判別に難があり却下。"
    )
    L.append(
        "- SAST ツールのみ: パターン検出は有効だがビジネスロジック・LLM 特有のプロンプトインジェクション・過剰エージェンシーの判定に弱く、補完に留める。"
    )
    L.append(
        "- 監査時に対応方針まで自動生成: 設計判断は人間が行う原則に反するため、事実提示までをスコープにする。\n"
    )
    L.append("## 影響\n")
    L.append(
        "- 観測性: 監査は静的解析であり実行時トレースは追加しない。実行時挙動（デプロイ env 値・IAM・Firestore ルール）は監査対象外で、条件付き事実として記述する。"
    )
    L.append(
        "- テスト/CI: 監査は CI ゲートではなくオンデマンド/定期実行。フル実行は大きなトークン消費を伴うため、単位分割と縮小スモークを併用する。"
    )
    L.append(
        "- フォローアップ: 確定指摘は issue で追跡し、対応は別 PR で行う。監査結果スナップショットは別途 ADR 化しない（本 ADR はプロセスの記録）。\n"
    )
    os.makedirs(adr_dir, exist_ok=True)
    if os.path.exists(path):
        raise SystemExit(
            f"ADR already exists, refusing to overwrite: {path}. 次番号を再計算するか --next を確認してください。"
        )
    open(path, "x").write("\n".join(L))
    print(f"wrote {path}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Render audit artifacts from audit.json.")
    ap.add_argument("what", choices=["reports", "summary", "issue-body", "adr"])
    ap.add_argument("--audit", required=True)
    ap.add_argument("--units")
    ap.add_argument("--targets")
    ap.add_argument("--dest", default="security-audit")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--out")
    ap.add_argument("--next")
    ap.add_argument("--adr-dir", default="docs/adr")
    args = ap.parse_args()

    audit = json.load(open(args.audit))

    if args.what in ("reports", "summary") and (not args.units or not args.targets):
        raise SystemExit(
            f"{args.what}: --units と --targets は必須です（欠落すると対象総数 0 の偽の網羅ログを生成するため）。"
        )
    units = json.load(open(args.units)) if args.units else {"units": []}
    targets = [l.strip() for l in open(args.targets)] if args.targets else []
    targets = [t for t in targets if t]
    if args.what in ("reports", "summary"):
        if not targets:
            raise SystemExit(
                f"{args.what}: --targets が空です。監査対象ファイル一覧を確認してください。"
            )
        unit_list = units.get("units") or []
        if not unit_list:
            raise SystemExit(
                f"{args.what}: --units に監査単位がありません（units.json が空）。partition.py の出力を確認してください。"
            )
        unit_files = set()
        for u in unit_list:
            unit_files.update(u.get("files") or [])
        target_set = set(targets)
        missing = target_set - unit_files
        extra = unit_files - target_set
        if missing or extra:
            raise SystemExit(
                f"{args.what}: units.json と targets が不一致です（units に無い対象 {len(missing)} 件 / "
                f"targets に無い unit ファイル {len(extra)} 件）。別実行の units/targets を混同していないか確認してください。"
            )

    if args.what == "reports":
        cmd_reports(audit, units, targets, args.dest, args.head)
    elif args.what == "summary":
        cmd_summary(audit, units, targets, args.dest, args.head)
    elif args.what == "issue-body":
        cmd_issue_body(audit, args.head, args.out)
    elif args.what == "adr":
        if not args.next:
            print("--next NNNN required for adr", flush=True)
            return 2
        cmd_adr(audit, args.next, args.adr_dir, args.head)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
