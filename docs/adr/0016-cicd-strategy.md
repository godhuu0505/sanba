# ADR-0016: CI/CD 戦略 — リポジトリ public 化による無料・無制限 Actions 基盤

- ステータス: Proposed
- 日付: 2026-06-25

## コンテキスト
private リポジトリ運用時、GitHub Actions の無料枠（2,000 分/月）枯渇により
**PR の CI ジョブ群（ci / codeql / security）が数秒・`runner_id:0`・ログ 404 で即失敗**する
事象が発生した（#54）。再実行しても同じ即失敗で、`main` への push CI は成功していたため、
ワークフロー定義ではなく**アカウント層（ランナー未割当 = 枠枯渇）**が原因と判明した。

毎 PR で約 12〜13 ジョブ（とくに CodeQL / Trivy イメージビルドが重い）が起動し、
無料枠を急速に消費していた。「できる限り無料〜低価格で production-ready な CI/CD を確立する」
ことを目標に、ゼロベースで実行基盤とコストモデルを選定する必要があった。

候補は A. 消費削減のみ / B. public 化（無料・無制限）/ C. GitHub Pro($4) /
D. spending limit 従量 / E〜G. self-hosted runner / H. CircleCI 等。

## 決定
**リポジトリを public 化し、GitHub-hosted runner を継続利用する（候補 B）**。
public リポジトリは Actions 分が無料・無制限のため、枠枯渇という根本原因が恒久的に消える。
あわせて、消費削減（候補 A）の施策は public 化後も「PR ループ高速化」の観点で有効なものを
残し、すでに以下を実装済みとする:

- 多くの workflow に最小権限 `permissions: contents: read` および `concurrency: cancel-in-progress: true`（例外: `claude-review-response.yml` は write 系権限必須・`false`、`terraform.yml` は `id-token`/`pull-requests: write`・`false`）。
- uv / Docker の GHA キャッシュ（scope を `deploy.yml` と共有）。
- `ci.yml` の `quality-gate` 集約ジョブ（branch protection はこれ 1 つを必須にする / #58・#62）。
- paths 絞り込み: `llm-eval.yml`（プロンプト等変更時）/ `deploy.yml`（変更 app のみ）/ `terraform.yml`。

## 理由 / 検討した代替案
- **B. public 化（採用）**: 月額 ¥0 で実行分が無制限。導入・運用コストが最小で、枠枯渇の
  再発がそもそも構造的にあり得なくなる。SANBA はハッカソン/OSS 前提で機密資産が乏しく、
  シークレットは Secret Manager / GitHub Secrets に隔離済み（コードに平文なし; CI の gitleaks は
  `--no-git --source .` でワーキングツリーのみスキャン。過去コミット履歴は public 化前に
  `gitleaks detect`（fetch-depth 0）で手動スキャン済みを前提とする）
  のため、public 化のデメリットである「ソース秘匿性の喪失」を受容できると判断した。
- **A. 消費削減のみ**: まず必ずやる土台だが、CodeQL/Trivy を絞っても根本の枠枯渇リスクは
  残る。単独では「再発しない」を満たせない。→ B の補完として一部採用。
- **C. GitHub Pro($4) / D. 従量**: 低労力だが課金が発生し、目標「できる限り無料」に劣る。却下。
- **E〜G. self-hosted runner**: 恒久無料化はできるが、ランナーの構築・パッチ・隔離の運用負荷が
  ハッカソン規模に見合わない。却下。
- **H. CircleCI 等への移行**: 設定移行コストが高く、既存の GitHub 連携（OIDC/WIF, Code scanning,
  Dependabot）を捨てることになる。却下。

## 影響 / フォローアップ
- **コスト可観測性の取り下げ**: 当初 DoD にあった「Actions 使用量・予算アラート」は、public で
  Actions 課金が発生しないため不要として取り下げる（#54 の DoD を最新化済み）。
  GCP 側の予算アラート（`google_billing_budget`, ADR-0009/0015）はランタイムコスト用として別途維持。
- **セキュリティ**: public 化に伴い、フォーク PR には secrets が渡らない GitHub 仕様を前提に、
  `llm-eval.yml` は heuristic 評価へ自動フォールバックする実装を維持。OIDC/WIF・最小権限は継続。
  CodeQL は Code scanning 有効前提（無効化すると SARIF upload が失敗し CI が赤になる）。
  branch protection の必須チェックは `quality-gate` のみのため CodeQL 単体は merge をブロックしない
  （必要に応じて branch protection への追加を別途検討する）。
- **観測性**: 「枠枯渇による即失敗」という切り分け困難な赤が構造的に消えるため、CI 失敗の
  シグナル品質が向上する。Four Keys（変更失敗率・MTTR）との整合は維持。
- **任意の追加最適化（未実施・必須ではない）**: docs/md のみの PR を `paths-ignore` で skip、
  CodeQL/security を PR から外し main + 週次 schedule へ。いずれも効果は PR 待ち時間短縮のみで、
  分数コストの動機は public 化で消失している。
- 本 ADR は提案中。実行基盤・コストモデルの最終判断は人間レビューを経て Accepted とする。
