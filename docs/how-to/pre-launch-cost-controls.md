# プレスリリース前のコスト最小化運用

公開前（アクセス可能だが未告知）の本番環境で、固定費を最小化しつつデモ・検証はすぐできる状態を
保つための運用手順。数値は 2026-07 時点の目安（us-central1 / 各社公表単価ベース）。
実額の把握は billing export（§3）と Kibana の AI コスト分析
（[session-cost-analytics.md](session-cost-analytics.md)）を正とする。

## 1. コスト構造の要約

| 費目 | アイドル時の月額目安 | 性質 |
|---|---|---|
| Cloud Run `sanba-agent`（min-instances=1, 2vCPU/2Gi 常時割当） | ~$105 | **固定**。min-instances=0 で $0 になる（§2） |
| 外部 LB + Cloud Armor + Cloud DNS | ~$25 | 固定。独自ドメイン・OAuth・Cookie が依存するため公開前でも維持する |
| Artifact Registry（イメージ保管） | ~$2 | cleanup policy 済み（直近 5 世代 + 30 日超削除） |
| Vertex AI（Gemini Live / reasoning） | 従量 | セッション実測 $0.05〜0.40/回。アイドル $0 |
| LiveKit Cloud（Build プラン） | $0 | 完全従量。無料枠: agent 1,000 分/月・参加者 5,000 分/月 |
| Elastic Cloud Serverless | ~$25〜 | ingest はゼロスケールするが **search VCU はアイドルでもベースライン課金**（§4） |

api / web / worker は min-instances=0 + リクエスト課金のため、トラフィックが無ければほぼ無料枠内。

## 2. agent の warm / sleep 切り替え

`sanba-agent` は LiveKit へ outbound WebSocket で worker 登録する pull 型のため、
min-instances=0 の間は**音声セッションを開始できない**（コールドスタートが遅いのではなく、
起こすきっかけとなる inbound リクエストが存在しない）。公開前は sleep(=0) を既定とし、
使う直前だけ warm(=1) にする。

手順（GitHub Mobile からも可）:

1. Actions → **Agent standby (warm/sleep)** → Run workflow → `warm` を選択。
2. 1〜2 分待つ（インスタンス起動 → worker の LiveKit 登録）。
3. デモ・検証を行う。
4. 終わったら同じワークフローで `sleep` を実行する。

ワークフロー（`agent-standby.yml`）は GitHub Variable `AGENT_MIN_INSTANCES` の更新と
gcloud での即時反映をまとめて行う。反映は 2 段構えで、順序に意味がある:

1. **先に** Variable `AGENT_MIN_INSTANCES` を更新する（以後の terraform apply が巻き戻さない
   ようにする。deploy.yml の migrate は Variable の値で apply する）。
2. `gcloud run services update` で本番へ即時反映する（terraform apply を待たない）。

Variable 更新が失敗したら gcloud には進まない（drift を作らない fail fast）。standby の連打は
concurrency で直列化される（terraform apply とは別系統）。

手動で切り替える場合も**両方**行うこと（Variable を更新しないと、次の
terraform apply（deploy.yml の migrate）が min-instances を巻き戻す）:

```bash
gh variable set AGENT_MIN_INSTANCES --body "1"
gcloud run services update sanba-agent \
  --project=sanba-prd --region=us-central1 --min-instances=1 --quiet
```

プレスリリース時は `warm` を実行して常態化する（`AGENT_MIN_INSTANCES=1` が terraform 経由でも
維持される）。以後この運用自体が不要になったら、本ドキュメントとワークフローの要否を見直す。

## 3. billing export（実額の可視化）

GitHub Variable `ENABLE_BILLING_EXPORT=true` で terraform が BigQuery dataset
`billing_export` を作成する（ADR-0061）。**エクスポート自体の配線は請求先アカウント側の
コンソールで一度だけ**行う:

1. GCP コンソール → お支払い（Billing）→ 課金データのエクスポート（Billing export）。
2. **詳細な使用料金データ（Detailed usage cost）** → プロジェクト `sanba-prd` の
   dataset `billing_export` を指定して保存。
3. 反映は翌日以降。Vertex AI 呼び出しの billing labels（session_id / product_id）との突合は
   [session-cost-analytics.md](session-cost-analytics.md) を参照。

## 4. Elastic Cloud Serverless の固定費を下げる

Search VCU はアイドルでもベースラインが課金される。ベースラインは **Search Power** 設定で
下げられる（[公式: billing dimensions](https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/elasticsearch-billing-dimensions)）:

1. [cloud.elastic.co](https://cloud.elastic.co/) → 対象プロジェクト → Manage → Search Power。
2. `Performant`（既定）→ **`On-demand`** に変更（検索レイテンシは多少変動するが、
   grounding / analytics の用途では許容範囲）。
3. 実額は Organization → Billing → Usage で確認する。

分析データの保持期間（`ANALYTICS_RETENTION_DAYS`、既定 365 日）はストレージ課金が
$0.047/GB-月と安いため、公開前のデータ量では削っても効果がほぼ無い。触らなくてよい。

## 5. LiveKit Cloud のプラン

課金は完全従量でアイドル時 $0。**Build プラン（無料）** の無料枠
（agent session 1,000 分/月・参加者 5,000 分/月・転送 50GB/月、同時 agent 5）で
公開前の利用は収まる。[cloud.livekit.io](https://cloud.livekit.io/) → Settings → Billing で
プランを確認し、Ship（$50/月固定）以上になっていたら Build に下げる。
公開後、同時 agent 数 5 が足りなくなった時点で Ship に上げる。
