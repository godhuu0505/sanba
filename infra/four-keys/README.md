# Four Keys / DORA 自己計測

Findy ドメイン直撃の「開発生産性の可視化」。**本リポジトリ自身の開発**を計測し、
**指標をハックせず**ボトルネック発見に使う（CLAUDE.md 原則4／佐藤将高CTOの主張）。

「まわす」軸の中核。CI/CD（`deploy.yml`）と可観測性スタック（Prometheus + Grafana）を
そのまま使い、外部 SaaS / BigQuery 無しで完結する軽量実装にした。

## 計測する 4 指標

| 指標 | データ源 | 算出 |
|---|---|---|
| デプロイ頻度 | `deploy.yml` workflow run（success/failure） | ウィンドウ内デプロイ数 / 日数 |
| 変更のリードタイム | 出荷コミットの authored_at → デプロイ完了 | 成功デプロイの中央値 |
| 変更失敗率 | 失敗した workflow run + incident | 失敗デプロイ / 全デプロイ |
| 平均復旧時間 (MTTR) | `incident` ラベルの Issue（open→close） | 復旧時間の中央値 |

DORA「State of DevOps」の Elite / High / Medium / Low バンドで自動ランク付けする
（`fourkeys_performance_level` メトリクス）。

## アーキテクチャ

```
GitHub REST API ──> collector (stdlib only) ──> /metrics ──> Prometheus ──> Grafana
  deploy.yml runs                 :9301              scrape 60s     dashboard: "SANBA — Four Keys (DORA)"
  incident issues
```

- **`collector/`**: 依存ゼロ（標準ライブラリのみ）の Python パッケージ。非 root コンテナ。
  - `dora.py` — 純粋関数の DORA 算出（I/O なし・ユニットテスト対象）。
  - `github_source.py` — GitHub から deploy run / incident を収集。到達不能・実績ゼロ時は
    `sample_events.json` にフォールバックし、`source=sample` ラベルで**正直に**明示する。
  - `exporter.py` — Prometheus テキスト形式で `/metrics` を提供（スクレイプ毎に再計算）。
- **Grafana**: `infra/observability/grafana/provisioning/dashboards/four-keys.json` を自動プロビジョン。

## 使い方

```bash
# スタックごと（推奨）: Grafana http://localhost:3001 → "SANBA — Four Keys (DORA)"
just up

# 単体で一度だけ確認（JSON / Prometheus テキスト）
cd infra/four-keys/collector
uv run python -m fourkeys collect --json
uv run python -m fourkeys collect          # Prometheus exposition

# テスト
uv run pytest -q
```

環境変数:

- `GITHUB_REPOSITORY`（既定 `godhuu0505/ai-hackathon2`）
- `GITHUB_TOKEN`（任意。API レート制限を緩和。未設定でも public repo は読める）

## 設計判断

- **BigQuery を使わない**: 公式 OSS [dora-team/fourkeys](https://github.com/dora-team/fourkeys) は
  Cloud Run + BigQuery 構成だが、本プロジェクト規模では over-engineering。既存の Prometheus +
  Grafana に相乗りする方が「観測できないものは運用できない」の原則に対し費用対効果が高い。
- **incident は Issue ラベルで表現**: 専用の incident 管理基盤を持たず、`incident` ラベルの
  Issue を single source of truth とする（運用が軽く、トレーサブル）。
- **指標ハック禁止**: 見栄えのための PR 分割やデプロイ水増しはしない。ボトルネック発見が目的。
