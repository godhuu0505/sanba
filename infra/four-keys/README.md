# Four Keys / DORA メトリクス

Findy ドメイン直撃の「開発生産性の可視化」。本リポジトリ自身の開発を計測し、
**指標をハックせず**ボトルネック発見に使う（佐藤将高CTOの原則）。

## 計測する 4 指標
| 指標 | データ源 | 算出 |
|---|---|---|
| デプロイ頻度 | `deploy.yml` の成功イベント | 単位期間あたりのデプロイ数 |
| 変更のリードタイム | コミット時刻 → デプロイ時刻 | 中央値 |
| 変更失敗率 | デプロイ後の incident / rollback | 失敗デプロイ / 全デプロイ |
| 平均復旧時間 (MTTR) | incident open → close | 中央値 |

## 実装方針
- GitHub の `deployment` / `pull_request` / `issues(label: incident)` Webhook を収集。
- Google の OSS [Four Keys](https://github.com/dora-team/fourkeys) を Cloud Run + BigQuery で稼働、
  または軽量に GitHub Actions → BigQuery へ直接書き込み。
- Grafana の BigQuery データソースでダッシュボード化し、`infra/observability` の Grafana に統合。

> Phase 4 で本実装。まずはデプロイイベントの記録から始める。
