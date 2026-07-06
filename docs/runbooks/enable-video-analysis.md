# Runbook: 動画解析パイプラインの本番有効化（ADR-0040）

アップロード動画の非同期解析（GCS 直送 → Cloud Tasks → worker → grounding 投入）を本番で
live にするための**意図的なオペレーション手順**。コード（api / worker / web / Terraform）は
実装済みで、ここに書くのは有効化の順序と `gcloud` / GitHub 操作のみ。

> 関連: ADR-0040 / 実装計画 `docs/design/video-and-screen-analysis-implementation-plan.md`
> 関連リソース: `infra/terraform/media.tf`（バケット・キュー・worker SA・gated worker service）

## なぜ「1 回のマージで全自動」にしないか

`deploy.yml` はマージ時に **migrate（`terraform apply`）→ build → deploy** の順で走る。
worker は**新規**の Cloud Run サービスなので、Terraform がこれを作るには worker イメージが
Artifact Registry に**先に**存在していなければならない。しかし build は migrate の後段のため、
`enable_video_analysis=true` を自動 apply に含めると「イメージ未ビルドで worker service 作成が
失敗」というブートストラップのデッドロックになる。加えて有効化は**課金される解析パイプライン**を
動かすため、明示的なゲートが妥当。よって有効化は下記の順序での**手動 apply 1 回**で行う。

## 前提

- PR-V1〜V3 がマージ済み（バケット・キュー・SA・api/worker/web コードが本番に入っている）。
- `enable_video_analysis` は既定 `false`（api は enqueue せず、worker service も未作成）。

## 手順

1. **worker イメージをビルドして push する**（Terraform が参照できるようにする）。
   GitHub Actions の `deploy.yml` を `workflow_dispatch` で起動し、対象に `worker` を含める
   （または main へ worker 変更を含むコミットをマージ済みなら既に push 済み）。
   Artifact Registry に `.../sanba/worker:<sha>` が出来ていることを確認する:
   ```sh
   gcloud artifacts docker images list \
     "$REGION-docker.pkg.dev/$PROJECT_ID/sanba/worker" --limit 1
   ```

2. **フラグを立てて Terraform を手動 apply する**。`terraform.tfvars`（または CI の変数）で
   `enable_video_analysis = true` にし、`terraform.yml` の `workflow_dispatch`（action=apply）を
   実行する。これで:
   - `google_cloud_run_v2_service.worker` が作成される（イメージは手順 1 で存在）。
   - api の `ENABLE_VIDEO_ANALYSIS=true` が反映され、以後 api が動画を enqueue する。
   - api runtime SA の署名鍵レス署名（`iam.serviceAccountTokenCreator` on self）は PR-V3 で
     既に付与済みなので、直送の署名付き URL 発行が動く。

3. **worker サービスを最新イメージにデプロイする**（Terraform は image を無視するため）。
   `deploy.yml` の worker deploy、または:
   ```sh
   gcloud run deploy sanba-worker \
     --image "$REGION-docker.pkg.dev/$PROJECT_ID/sanba/worker:<sha>" --region "$REGION"
   ```

4. **スモークテスト**: セッションで短い画面録画（〜5分）をアップロードし、
   - api ログに `video_upload_complete` → `video_enqueued`、
   - worker ログに `video_analyzed`、
   - 素材が `analyzing` → `done`（GET context/files / UI）に遷移、
   - `search_grounding` で当該観察が引ける、
   ことを確認する。失敗時は素材が `failed`（worker のリトライ枯渇 or reconcile）になる。

## ロールバック

`enable_video_analysis = false` に戻して `terraform apply`。api は enqueue を止め、worker service は
破棄される（バケット・キュー・SA は残る）。処理中タスクは worker 破棄後 404 になり Cloud Tasks が
リトライ枯渇 → api の reconcile が滞留素材を `failed` 化する。

## ローカル開発

`local_direct_dispatch=true` + compose の fake-gcs-server + worker で、Cloud Tasks 無しに
api → worker を直接叩いて経路全体を通せる（`docs/design/...implementation-plan.md` PR-V3 参照）。
