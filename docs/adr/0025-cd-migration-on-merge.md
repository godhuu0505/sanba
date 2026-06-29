# ADR-0025: main マージ→本番デプロイ時のマイグレーション実行設計

- ステータス: Proposed（提案中）
- 日付: 2026-06-29
- 関連: #36（Cloud Run 実デプロイ）/ ADR-0016（CI/CD 戦略・public 化）/ ADR-0006（Cloud Run + LiveKit）/
  ADR-0003（Elasticsearch グラウンディング）/ `docs/runbooks/deploy-gcp.md` / `.github/workflows/deploy.yml`
- 下敷き: CLAUDE.md「本番志向（production-ready）」「観測できないものは運用できない」「設計判断とレビューは人間が行う」

## コンテキスト

要望は2つ:

1. **main にマージされたら本番（Cloud Run）にデプロイされるようにしたい。**
2. **デプロイに合わせてマイグレーションも走るようにしたい。**

### 現状（コード/IaC 上の事実）

1 の **「main マージ→本番デプロイ」は既に実装済み**である。`.github/workflows/deploy.yml` が
`on: push: branches:[main]` で、変更のあった app（agent/api/web）だけを Cloud Run に
デプロイする（WIF キーレス認証・Buildx GHA キャッシュ・**イメージ差し替えのみ**で env/secret は
Terraform 管理、ADR-0016）。ただし起動ガード `if: ${{ vars.GCP_PROJECT_ID != '' }}` があり、
**GCP が未配線（Variable 未設定）の間はスキップされ何も起きない**。実 GCP の配線状態は
`docs/runbooks/deploy-gcp.md` の §1–§6 と、下記「GCP 状態の確認手順」で点検する。

2 の **「マイグレーション」に相当する明示的な step は CD に存在しない**。SANBA には SQL DB /
Alembic は無く、永続層は **Firestore（Native mode）+ Elasticsearch** の2つ。それぞれの
「スキーマ」相当の扱いは現状ばらついている:

| 対象 | スキーマ相当 | 現状の扱い | ギャップ |
|---|---|---|---|
| Firestore | TTL ポリシー / 複合インデックス / セキュリティルール | TTL は Terraform `google_firestore_field` で宣言済み（`main.tf`）。複合インデックスは現クエリが単純（`.stream()` / 単一 doc `.get()`、`order_by`+`where` 併用なし）で**現状不要**。ルールはサーバ側 SA アクセスのみで不要。 | 概ね Terraform で吸収済み。ただし **`terraform.yml` の手動 apply** であり「デプロイで自動」ではない |
| Elasticsearch | インデックスのマッピング（`text`/`keyword`/`dense_vector` 等） | `apps/agent/.../retrieval.py` と `apps/api/.../ingestion.py` が**アプリ起動/初回書き込み時に遅延 auto-create**（`if indices.exists: return`） | **マッピング進化（`EMBED_DIM` 変更・項目追加）が既存インデックスに反映されない。マッピング定義が2ファイルに重複。明示的なマイグレーション機構が無い** ← 本 ADR が埋める対象 |

つまり本 ADR が扱う実体は **「Elasticsearch インデックスの明示的・冪等なマイグレーションを、
main マージ時のデプロイパイプラインに、サービス切替の前に組み込む」** ことである。Firestore は
引き続き Terraform 宣言で扱う（後述）。

### GCP 状態の確認手順（実 GCP は CI/エージェントから見られないため人手で点検）

`PROJECT_ID` を環境に合わせて置換して実行する:

```bash
export PROJECT_ID=sanba-prd REGION=us-central1
gcloud config set project "$PROJECT_ID"

gcloud run services list --region="$REGION"          # sanba-api/web/agent が Ready か（空＝未配線）
gcloud firestore databases list                       # Firestore の有無/モード
gcloud firestore indexes composite list               # 既存複合インデックス（要否判断）
gcloud artifacts repositories list --location="$REGION" # デプロイ先イメージ repo
gcloud run jobs list --region="$REGION"               # マイグレーション実行基盤の有無
# GitHub → Settings → Variables: GCP_PROJECT_ID / WIF_PROVIDER / DEPLOY_SA / TF_STATE_BUCKET
```

`gcloud run services list` が空なら 1（自動デプロイ）はまだ動いていない（コードはあるがガードで
スキップ）。その場合は runbook §1–§6 の初期配線が先。

## 決定

### 1. デプロイ（要望1）は現状維持を正とし、配線の有無だけ点検する

`deploy.yml`（main push → 変更 app を Cloud Run へ）を CD の正とする。**新規実装はしない**。
未配線なら runbook の手順で GitHub Variables（`GCP_PROJECT_ID` ほか）と WIF を入れるだけで有効化される。

### 2. Elasticsearch マイグレーションを「冪等な migrate コマンド」として実体化する

- `apps/api` に `python -m sanba_api.migrate` を新設する（api イメージに ES クライアントと
  マッピング定義が既にあるため再利用）。性質:
  - **冪等**: 何度流しても安全。インデックス/エイリアスを現行マッピングで保証する。
  - **expand-contract**: マッピング進化は **versioned index（`sanba-passages-vN`）+ alias（`sanba-passages`）+ reindex** で扱う。
    既存フィールドの型変更を破壊的に当てない（ES のマッピングは原則不変のため）。
  - **フェイルクローズ**: 失敗時は非ゼロ終了し、後続のサービス切替を止める。
  - **ES 未設定環境（`ELASTICSEARCH_URL` 空）では no-op 成功**（ローカル/未配線を壊さない）。
- マッピング定義の**重複を解消**する: 現在 `retrieval.py` と `ingestion.py` に重複しているインデックス名/
  `EMBED_DIM`/マッピングを `packages/sanba_shared`（または api 内の単一モジュール）へ集約し、
  migrate・retrieval・ingestion が同一の source of truth を参照する。アプリ側の遅延 auto-create は
  「migrate 前提・同一マッピングのフォールバック」として冪等に残す。

### 3. 実行基盤は Cloud Run Job `sanba-migrate`（Terraform 宣言）

- Terraform で `google_cloud_run_v2_job sanba-migrate` を宣言する（runtime SA / ES secret 参照を
  サービスと共有）。observable（実行ログ・履歴が Cloud Run Jobs に残る）で、失敗時の再実行も容易。
- `deploy.yml` は新しい api イメージで `gcloud run jobs deploy --image ... && gcloud run jobs execute --wait`
  を実行する（`--wait` で完了を待ち、失敗で pipeline を止める）。

### 4. パイプライン順序は expand-contract（マイグレーション→切替）

```
build/push（変更 app の image） → sanba-migrate 実行（失敗で停止） → 各 service の revision デプロイ
```

- 後方互換（additive）マイグレーションを先に当ててからサービスを切り替えるため、無停止で進む。
- api/agent/web のいずれの変更でも、ES マッピングに関わる migrate は**毎デプロイ実行**してよい
  （冪等・差分なしなら即終了）。コスト最適化として「ES に関係する変更時のみ」へ絞るのは将来検討。

### 5. Firestore は引き続き Terraform 宣言（`terraform.yml`）

- TTL（`google_firestore_field`）は既存どおり。複合インデックスが必要になったら
  `google_firestore_index` をコードに足し、`terraform.yml` の plan/apply で反映する。
- アプリのデータ系マイグレーション（ES）と、インフラ宣言（Firestore index/TTL/ルール）は層を分ける。
  前者は `sanba-migrate` Job、後者は Terraform。混在させない。

## 理由 / 検討した代替案

- **Cloud Run Job（採用）**: 実行が観測可能（履歴/ログ）、再実行容易、サービスと同一イメージ・SA・
  secret 参照を共有でき権限が最小。CLAUDE.md「観測できないものは運用できない」に合致。
- **deploy.yml 内インラインステップ（不採用）**: Job を作らず一時コンテナ/`gcloud` で直接 migrate を
  回す案。軽量だが実行履歴が GitHub Actions ログにしか残らず、運用時の再実行・監査が弱い。
- **アプリ起動時の遅延 auto-create のまま（不採用）**: 新規インデックス作成は賄えるが、**マッピング
  進化を反映できない**（`if exists: return`）。要望「マイグレーションが走る」を満たさない。ただし
  フォールバックとしては冪等で無害なので残す。
- **Firestore をアプリ migrate に含める（不採用）**: Firestore のスキーマ相当（index/TTL/rule）は
  IaC で宣言するのが GCP の定石で、state 管理・plan レビューの恩恵が大きい。Terraform に寄せる。

## 影響 / フォローアップ

- **観測性**: `sanba-migrate` の実行は Cloud Run Jobs の履歴/ログに残る。失敗は deploy pipeline を
  赤にする（CI 失敗シグナル）。Four Keys の「変更失敗率/MTTR」とも整合（マイグレーション失敗も
  変更失敗として観測される）。
- **権限/IAM**: deploy 用 SA に `run.jobs` 実行権限（`roles/run.developer` 相当 or 限定ロール）を
  追加する必要がある（runbook §3 のロール一覧に追記）。runtime SA は現状の `datastore.user` /
  `secretmanager.secretAccessor` を流用（ES は外部・secret 経由）。
- **コスト**: Job は実行時のみ課金。毎デプロイ実行でも数秒で、差分なしなら即終了するため軽微。
- **セキュリティ**: ES マッピングに PII は乗らない（本文は `mask_pii_before_index` でマスク済み・ADR-0003/#10）。
  migrate は構造のみ操作し値を持たないため、`/security-review` の対象は IAM 追加と reindex 経路に限定。
- **実装範囲（本 ADR 受理後）**:
  1. `apps/api/src/sanba_api/migrate.py`（冪等 runner、alias/versioned index/reindex、ES 未設定 no-op）
  2. マッピング定義の集約（`sanba_shared` へ）と retrieval/ingestion の参照差し替え
  3. Terraform `google_cloud_run_v2_job.migrate` + deploy 用 SA への jobs 実行権限
  4. `deploy.yml` に migrate 実行ジョブを追加（build→migrate→deploy の順、`--wait`・失敗で停止）
  5. runbook（`deploy-gcp.md`）にマイグレーションの運用節を追記
- 本 ADR は提案中。実 GCP 状態（上記確認手順）の点検結果を踏まえ、人間レビューを経て Accepted とする。
</content>
</invoke>
