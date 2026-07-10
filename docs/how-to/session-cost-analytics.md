# セッション AI コスト・KPI 分析（ADR-0061）の運用

会話セッション単位の AI コストと要件品質 KPI を Elasticsearch + Kibana で分析するための
セットアップと運用手順。設計判断は
[ADR-0061](../adr/0061-session-ai-cost-kpi-analytics.md)、データ取り扱いは
[security.md §2/§5](../reference/security.md) を正とする。

## 仕組みの要約

- agent / api / worker の全 AI 呼び出し（Gemini Live 音声・ADK チーム・会話分析・LLM ジャッジ・
  タイトル/要約・vision・埋め込み）が `ai_usage` イベントを排出する。
  排出は (a) 構造化ログ（`ai_cost_event`）と (b) ES データストリーム
  `sanba-analytics-events` への直接 index の二重化。fail-soft で会話は止めない。
- セッション終了時に agent が `session_summary`（コスト合計 × KPI × LiveKit 分数推定）を
  組み立て、`session_cost_summary` ログ + ES へ排出し、Firestore
  `sessions/{id}.ai_cost` に合計・内訳・確定サマリを残す。
- 単価表は `sanba_shared.analytics.PRICING`（$/1M tokens）。**価格改定時はここだけ更新**し、
  `just analytics-setup` で ES の単価 lookup index（`sanba-pricing`）も更新する。

## 初回セットアップ

1. ES データストリーム・ILM・単価 index・Kibana ダッシュボードを冪等に投入する:

   ```bash
   ELASTICSEARCH_URL=... ELASTICSEARCH_API_KEY=... \
   KIBANA_URL=... KIBANA_API_KEY=... \
   just analytics-setup
   ```

   - `ANALYTICS_RETENTION_DAYS`（既定 365）で保持期間を変える。非 serverless は ILM、
     Elasticsearch Serverless では ILM が使えないため data stream lifecycle（`data_retention`）で削除する。
     serverless 判定はセットアップ時に自動で行い、アプリ起動時の fail-soft テンプレート作成も同じ判定に従う。
   - `KIBANA_URL` 未設定なら ES 側だけ整える（ダッシュボードは後から import 可能）。
2. Terraform を apply する（merge 後は deploy.yml の migrate ジョブが自動適用）:
   - log-based metrics `sanba/session_cost_usd` / `sanba/session_cost_count` /
     `sanba/analytics_emit_failures`
   - アラート「セッション AI コストがしきい値超過」（`var.session_cost_alert_usd`、既定 $5）と
     「分析イベント排出失敗が継続」
   - 品質ダッシュボードのコストタイル
3. ローカルで Kibana を試す場合は `just up-full` で kibana（<http://localhost:5601>）が立つ。
   `KIBANA_URL=http://localhost:5601 just analytics-setup` でダッシュボードを import する。

## Kibana ダッシュボード

`SANBA — セッション AI コスト・KPI 分析 (ADR-0061)`（saved objects:
`infra/observability/kibana/sanba-analytics.ndjson`、`just analytics-setup` で冪等 import）。

- セッション毎 AI コスト Top20（P0/P2: 横断ドリルダウンの起点）
- コンポーネント別内訳・モデル別時系列（P1）
- セッション合計コストの平均 USD / JPY（P0）
- 効率指標: 承認要件 1 件あたりコスト・解消済み深掘り 1 件あたりコスト（P4）
- product 横断: 合計コスト × 品質スコア × 承認要件数（P4）

ダッシュボードを変更したら Kibana の Saved Objects export で ndjson を上書きし、
コードレビューに乗せる（手作業だけで終わらせない）。

## 請求実額との突合（補強）

- Vertex AI 経路（`GOOGLE_GENAI_USE_VERTEXAI=true`）の `generateContent` 系呼び出しには
  billing labels（`session_id` / `product_id`）が付与される。Live API と embeddings は
  Google 側の制約で対象外（実測 usage × 公式単価の推定が唯一の手段）。
- GitHub Variable `ENABLE_BILLING_EXPORT=true`（terraform.yml が `TF_VAR_enable_billing_export`
  として渡す）で BigQuery dataset `billing_export` が作られる。
  Cloud Billing の **Detailed usage cost export** をこの dataset に向ける設定は
  請求先アカウント側（コンソール）で 1 度だけ行う
  （手順は [pre-launch-cost-controls.md §3](pre-launch-cost-controls.md)）。
- 突合クエリ例（BigQuery）: `labels` に `session_id` を持つ行を `SUM(cost)` し、
  Firestore `sessions/{id}.ai_cost.total_usd` ないし Kibana の推定値と比較する。
  乖離が継続的に大きい場合は単価表・トークン集計の見直しを行う（指標をハックしない原則）。

## 運用ノブ（env / tfvars）

| 変数 | 既定 | 意味 |
|---|---|---|
| `USD_JPY_RATE` | 150.0 | ¥ 表示の固定換算レート（agent） |
| `LIVEKIT_CONNECTION_USD_PER_MIN` | 0.0005 | LiveKit 接続分数の推定単価 |
| `LIVEKIT_AGENT_SESSION_USD_PER_MIN` | 0.01 | agent session 分数の推定単価 |
| `LIVEKIT_NOISE_CANCELLATION_USD_PER_MIN` | 0.005 | Krisp BVC 分数の推定単価 |
| `ANALYTICS_RETENTION_DAYS` | 365 | 分析イベントの保持期間（非 serverless=ILM / serverless=data stream lifecycle） |
| `TF_VAR_session_cost_alert_usd` | 5 | セッションコスト異常アラートのしきい値 |
| `ENABLE_BILLING_EXPORT`（GitHub Variable） | false | billing export 用 BigQuery dataset の作成 |

LiveKit 分数単価は推定値（実額は LiveKit ダッシュボードで確認し、乖離したら env で調整する）。
