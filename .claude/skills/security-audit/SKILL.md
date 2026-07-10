---
name: security-audit
description: >
  リポジトリ全体（全ソースコード）のセキュリティ監査を、マルチエージェント並列オーケストレーション
  （発見→敵対的検証）で実行し、事実ベースのレポート・GitHub issue・方法論 ADR の PR を作成する。
  ユーザーが「セキュリティ監査」「全コードのセキュリティチェック」「脆弱性チェック」「security audit」
  「監査して issue と ADR を作って」などと言ったときに使う。事実記述のみで対応方針は含めない。
  ブランチ差分だけを見る組込みの /security-review とは別物（本スキルは全ソース＋issue＋ADR）。
---

# security-audit — 全コード監査 → GitHub issue + ADR PR

このリポジトリの全ソースを静的にセキュリティ監査するスキル。判断根拠は現在のソースコードのみ
（docs/ADR・コメントの説明は挙動判断に使わない。コメントは機微情報漏洩の観点でのみ精査）。監査は
**事実記述のみ**で、対応方針は書かない（判断は人間が行う）。

駆動は「決定的な Python スクリプト（`bin/partition.py` / `bin/aggregate.py` / `bin/render.py`）」と
「Workflow ツールに渡すオーケストレーション（`bin/audit_workflow.mjs`）」の組み合わせ。Workflow は
harness 依存で単体実行できないため、**Workflow ツール経由**で起動する。

参照プランと指示プロンプトは `reference/PLAN.md` / `reference/prompts.md`（観点 A〜F と
発見/検証プロンプト・スキーマの一次情報）。

パスはリポジトリルートからの相対。スキル本体は `.claude/skills/security-audit/`。
作業ファイルはスクラッチ用作業ディレクトリ（例 `/tmp/.../scratchpad/audit`）に置く。

## 前提

追加インストール不要（`python3` / Node ランタイムはコンテナに同梱）。GitHub 操作は
`mcp__github__*` ツール、PR は指定作業ブランチへ push して作成する。

## 手順（agent パス）

作業ディレクトリを決める（`WORK=/tmp/.../audit` 等）。以下は本コンテナで実行して動作確認済み。

### 1. 監査対象の列挙と単位分割

```bash
python3 .claude/skills/security-audit/bin/partition.py --repo . --out "$WORK"
```

`$WORK/audit_targets.txt`（テスト/ロック/バイナリ/md を除く全ソース）と `$WORK/units.json`
（モジュール/ディレクトリ境界で ~25 ファイル/単位に分割）を生成する。標準出力に単位一覧と件数。

### 2. 監査 Workflow を起動（発見 → 敵対的検証）

`$WORK/units.json` の中身に `repo` を足したものを Workflow の `args` に渡し、`scriptPath` に
`bin/audit_workflow.mjs` を指定して **Workflow ツール**で起動する（バックグラウンド）。

- args の形: `{"repo": "<絶対パス>", "units": [ ...units.json の units 配列... ]}`
- 発見エージェントが担当ファイルを全行 Read → 生指摘、各指摘を検証エージェントが該当コード
  再読で敵対的検証（REFUTED を既定に懐疑的）。
- フル実行は大きなトークン消費（数百万規模）。小さく試すときは `units` を1〜2単位に絞る。
- 注意: `audit_workflow.mjs` は `args` が文字列で届く場合に備え `JSON.parse` する防御を入れてある。

完了すると結果オブジェクト（`confirmedFilesByUnit` / `totals` / `confirmed` / `uncertain` /
`refuted`）を返す。タスクの `.output` ファイル（通知に出るパス）を次段の入力にする。

### 3. 結果を正規化

```bash
python3 .claude/skills/security-audit/bin/aggregate.py \
  --input <workflow .output ファイル> --repo . --out "$WORK"
```

`$WORK/audit.json`（ID 採番・パス正規化・重大度集計込み）を生成。標準出力に確定/要確認/棄却の件数。

### 4. レポート3点を生成

```bash
B=.claude/skills/security-audit/bin/render.py
python3 $B reports --audit "$WORK/audit.json" --units "$WORK/units.json" --targets "$WORK/audit_targets.txt" --dest security-audit --head "$(git rev-parse --short HEAD)"
python3 $B summary --audit "$WORK/audit.json" --units "$WORK/units.json" --targets "$WORK/audit_targets.txt" --dest security-audit --head "$(git rev-parse --short HEAD)"
```

`security-audit/{coverage-log.md, findings.md, summary.md}` を生成する。

### 5. GitHub issue 本文と ADR を生成

```bash
python3 $B issue-body --audit "$WORK/audit.json" --head "$(git rev-parse --short HEAD)" --out "$WORK/issue.md"
NNNN=$(printf '%04d' $(( 10#$(ls docs/adr/ | grep -Eo '^[0-9]{4}' | sort -n | tail -1) + 1 )))
python3 $B adr --audit "$WORK/audit.json" --next "$NNNN" --adr-dir docs/adr --head "$(git rev-parse --short HEAD)"
python3 scripts/gen-docs-index.py   # docs/adr/README.md 索引を再生成（CI docs-check 対策）
```

- issue 本文: 確定指摘の事実サマリー＋観点×重大度マトリクス＋P0/P1/P2 追跡チェックボックス（remediation なし）。
- ADR: 監査プロセス（手法・方針）を採用として記録する方法論 ADR（`docs/adr/NNNN-codebase-security-audit-process.md`）。
  生成後、`- 日付:` 行の `TODO` を起票日に置換すること。**ADR を追加したら必ず `scripts/gen-docs-index.py`
  （= `just docs-index`）で `docs/adr/README.md` 索引を再生成する**。索引が古いと CI の docs-check が落ちる。

### 6. コミット → PR → issue 起票

```bash
git add security-audit/ docs/adr/
git commit -m "docs: 全コード セキュリティ監査（結果 + プロセス ADR）"
git push -u origin <作業ブランチ>
```

- `mcp__github__create_pull_request` で PR（ready for review、`.github/pull_request_template.md` の節を踏襲）。
- `mcp__github__issue_write` で `$WORK/issue.md` を本文に issue を起票し、PR と相互リンクする。
- マージ済み PR には積み増さない。指定作業ブランチが既にマージ済みなら、最新 default から作り直して新規 PR にする。

## Gotchas（この監査で踏んだ罠）

- **Workflow の `args` が文字列で届く**ことがある。`audit_workflow.mjs` は先頭で `typeof args==='string'`
  を `JSON.parse` する。これが無いと `units.length===0` で即終了し、0エージェントで空結果になる。
- **`bin/*.py` はコメント禁止**。CLAUDE.md 規約の `scripts/check_no_comments.py` が `.claude/` も含む
  全 `*.py` を走査するため、機能プラグマ以外のコメントを書くと `just check-comments` が落ちる。
- **`node --check bin/audit_workflow.mjs` は失敗する**（top-level `return` と `phase/agent/pipeline`
  フックのため）。これは正常。構文検証は Workflow ツールでの起動（スモーク）で行う。
- **フル実行は高コスト**（本リポジトリの前回実行で ~5M トークン / 124 エージェント）。スモークは
  `units` を1〜2単位に絞って発見→検証が最後まで通ることだけ確認する。
- **PII/秘密の非転記**: レポート・issue には file:line と事実のみ。実シークレット値は書かない。
- **ADR 連番の 8 進数トラップ**: `$(( 0065 + 1 ))` は bash が `0065` を 8 進数と解釈して誤値になる。
  手順5のように `10#` を前置して 10 進強制する。

## Troubleshooting

- `partition.py` の `partitioned != targets` 警告: フィルタ対象外の拡張子が混じっている。
  `EXCLUDE_EXT` / `TEST_PATTERNS` を調整する。
- `render.py adr` が `--next required`: 次番号を渡していない。手順5の `NNNN` を確認。
- Workflow が空結果で即終了: 手順2の args に `units` が入っているか、`.output` の `totals.units` を確認。

## 参照

- `reference/PLAN.md` — 監査の参照プラン（対象範囲・観点 A〜F・成果物・検証）。
- `reference/prompts.md` — 発見/検証エージェントの指示プロンプトとスキーマ（一次情報）。
