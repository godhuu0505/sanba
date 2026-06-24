# Runbook: Google Cloud デプロイ & 公開化セットアップ

SANBA を Cloud Run に本番デプロイし、リポジトリを安全に public 化するための**人手作業の手順書**。
コード側（`deploy.yml` / Terraform）は実装済みで、ここに書くのは GUI / `gcloud` / GitHub 設定のみ。

> 関連 issue: #36（Cloud Run 実デプロイ）/ #67・#68（public 化セキュリティ）/ #54（CI/CD 再設計）
> 関連 ADR: `docs/adr/0006-cloudrun-and-livekit.md`

所要時間の目安: GCP/WIF で約 40 分、LiveKit で約 10 分、GitHub 設定で約 15 分。

---

## 0. 前提

- GCP プロジェクトを作れる課金アカウント。
- `gcloud` CLI ログイン済み（`gcloud auth login`）。
- リポジトリ owner 権限（`godhuu0505`）。

---

## 1. GCP プロジェクトと API

```bash
export PROJECT_ID=sanba-prd            # 任意。Artifact Registry 等で使う
export REGION=us-central1             # deploy.yml / tfvars と一致させること
gcloud projects create "$PROJECT_ID"  # 既存を使うなら不要
gcloud config set project "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account=XXXXXX-XXXXXX-XXXXXX
```

API の有効化は Terraform（`main.tf` の `google_project_service`）が行うので、ここでは課金リンクまででよい。

---

## 2. Terraform でインフラを作成

`infra/terraform/` で実行する。Secret Manager・Cloud Run・Artifact Registry・Firestore・予算アラート等が一度に作られる。

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # terraform.tfvars は gitignore 済（機微値・コミット禁止）
```

`terraform.tfvars` を編集（最低限）:

| 変数 | 設定値 |
|---|---|
| `project_id` | 上の `$PROJECT_ID` |
| `region` | `us-central1`（`deploy.yml` の `REGION` と一致） |
| `billing_account` | 予算アラートを使うなら課金アカウント ID |
| `use_vertexai` | `true`（本番はキーレス推奨。`false` なら `google_api_key` 必須） |
| `livekit_url` | LiveKit Cloud の `wss://...`（§4 で取得） |
| `livekit_api_key` / `livekit_api_secret` | LiveKit Cloud のキー（§4） |
| `session_signing_secret` | 空でよい（空なら強い値を自動生成して Secret Manager に格納） |

```bash
terraform init
terraform plan
terraform apply
```

apply 後、出力を控える（後で GitHub `vars` に使う）:

```bash
terraform output api_url   # → NEXT_PUBLIC_API_URL に使う
terraform output web_url   # 公開 URL（README に掲載）
terraform output image_repository runtime_service_account managed_secrets
```

> 注: `deploy.yml` は **イメージ差し替えのみ**で env/secret は触らない設計。env/secret はこの Terraform が唯一の管理者。

---

## 3. Workload Identity Federation（キーレス認証）

GitHub Actions が SA キー無しで GCP にデプロイするための WIF を作る。

```bash
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export POOL=github-pool
export PROVIDER=github-provider
export REPO=godhuu0505/sanba

# デプロイ用 SA（Terraform が作っていなければ作成）
gcloud iam service-accounts create gh-deployer --display-name="GitHub Actions Deployer"
export DEPLOY_SA=gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com

# 必要ロール（Cloud Run デプロイ + Artifact Registry push + SA 借用）
for ROLE in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role="$ROLE"
done

# WIF プール + プロバイダ
gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" \
  --display-name="GitHub OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='${REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# main ブランチからのデプロイだけ SA を借用できるよう限定（ADR-0011 §10）
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"

# deploy.yml の secrets.WIF_PROVIDER に入れる完全パス
echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
```

> セキュリティ: `attribute-condition` で `repository` を固定。より厳格にするなら `attribute.ref=='refs/heads/main'` も条件に加える。

---

## 4. LiveKit Cloud（実音声経路に必須）

1. [LiveKit Cloud](https://cloud.livekit.io/) でプロジェクトを作成。
2. **Settings → Keys** で API Key / Secret を発行。
3. WebSocket URL（`wss://<project>.livekit.cloud`）を控える。
4. これらを §2 の `terraform.tfvars`（`livekit_url` / `livekit_api_key` / `livekit_api_secret`）に入れて `terraform apply` し直す（Secret Manager に格納される）。

---

## 5. GitHub の Variables / Secrets を登録

**Settings → Secrets and variables → Actions** で登録する。

### Repository variables（`vars.*`）
| 名前 | 値 |
|---|---|
| `GCP_PROJECT_ID` | `$PROJECT_ID`（**これが空だと `deploy.yml` は skip される**） |
| `NEXT_PUBLIC_API_URL` | §2 の `terraform output api_url`（web ビルドに必須・空だと fail fast） |
| `NEXT_PUBLIC_LIVEKIT_URL` | §4 の `wss://...` |

### Repository secrets（`secrets.*`）
| 名前 | 値 |
|---|---|
| `WIF_PROVIDER` | §3 末尾で出力した WIF プロバイダの完全パス |
| `DEPLOY_SA` | §3 の `$DEPLOY_SA`（`gh-deployer@...iam.gserviceaccount.com`） |

---

## 6. デプロイ実行

`main` への push で `deploy.yml` が走る。手動なら:

**Actions → Deploy (Cloud Run) → Run workflow**（`workflow_dispatch` は全 app を再デプロイ）。

確認:
```bash
gcloud run services list --region="$REGION"   # sanba-api / sanba-agent / sanba-web が Ready
```
`terraform output web_url` をブラウザで開き、インタビューが開始できることを確認 → README の「公開 URL」に掲載。

---

## 6.5. 本番ドメイン（sanba.com）を当てる（ADR-0013）

Global 外部 HTTPS LB + Google 管理証明書 + Cloud DNS。`infra/terraform/domain.tf` が実装済みで、
ここの手作業は **ドメイン取得とレジストラ設定だけ**。

### A. ドメインを取得する（未取得なら）
- [Cloud Domains](https://console.cloud.google.com/net-services/domains)（GCP 内で完結・Cloud DNS と統合が楽）
  または任意のレジストラ（Google Domains 後継の Squarespace / お名前.com 等）で **sanba.com** を購入。
- `.com` は誰でも取得可。商標・既存利用がないかは購入前に確認。

### B. Terraform で LB と DNS ゾーンを作る
`terraform.tfvars` に追記して `apply`:
```hcl
domain     = "sanba.com"
manage_dns = true        # Cloud DNS でゾーン管理（A レコードを LB IP に自動で向ける）
```
```bash
terraform apply
terraform output lb_ip            # LB の Anycast IP
terraform output dns_name_servers # Cloud DNS のネームサーバ（次で使う）
terraform output public_urls
```

### C. レジストラのネームサーバを Cloud DNS に向ける（手作業）
- レジストラの管理画面で、sanba.com の **NS レコード**を `terraform output dns_name_servers` の
  4 つ（`ns-cloud-XX.googledomains.com.`）に置き換える。
- Cloud Domains で買った場合は最初から Cloud DNS を使う設定にできる。
- 反映（伝播）に最大 24〜48h。通常は数十分。

> 別 DNS を使い続けたい場合は `manage_dns = false` にして、`terraform output lb_ip` の IP を
> 自前 DNS に `A @ / www / api` として登録する。

### D. 証明書の発行を待つ
A レコードが LB IP を指すと Google 管理証明書が自動発行される（`PROVISIONING` → `ACTIVE`、数分〜数十分）。
```bash
gcloud compute ssl-certificates describe sanba-cert --global --format='value(managed.status)'
```
`ACTIVE` になれば `https://sanba.com` / `https://api.sanba.com` が開く。

### E. web ビルドを api.sanba.com に向け直す（手作業・GitHub Variables）
- **Settings → Secrets and variables → Actions** の `vars.NEXT_PUBLIC_API_URL` を
  `https://api.sanba.com` に更新。
- （任意）`vars.NEXT_PUBLIC_LIVEKIT_URL` はそのまま。
- 更新後に **Actions → Deploy (Cloud Run) → Run workflow**（`apps=web`）で web を焼き直す。
  CORS（`ALLOWED_ORIGINS`）は Terraform 側が `sanba.com` を許可済み。

---

## 6.6. Terraform を CI/CD で回す（PR で plan・GitHub Mobile で apply）

`infra/terraform` の変更を **PR で `terraform plan` 自動確認**し、**GitHub Mobile から `apply`** で
本番反映するためのワークフロー `.github/workflows/terraform.yml`。`deploy.yml`（イメージ差し替え）
とは別物で、こちらは env/secret/LB/DNS など**インフラそのもの**を反映する。

### フロー
- **PR（`infra/terraform/**` を変更）** → `plan` を実行し、結果を PR にコメント。人間が plan を
  確認してマージ。
- **本番反映** → GitHub Mobile の **Actions → Terraform (infra) → Run workflow → `action=apply`**。
  その場で plan → 保存した plan を `apply`（＝「plan で問題なければ apply」）。
- 安全弁: `production` 環境に **required reviewers** を付ければ、apply 実行時に承認ゲートが入る
  （**Settings → Environments → New environment `production`** で設定）。

### 事前準備（一度きりの手作業）

**(a) Terraform state 用 GCS バケット**（リモート state・ロック）
```bash
gsutil mb -l "$REGION" -b on "gs://${PROJECT_ID}-tfstate"
gsutil versioning set on "gs://${PROJECT_ID}-tfstate"
```

**(b) Terraform 用 SA（apply は LB/DNS/Secret/IAM を作るので deploy 用より広い権限）**
```bash
gcloud iam service-accounts create tf-deployer --display-name="Terraform Deployer"
export TF_SA=tf-deployer@${PROJECT_ID}.iam.gserviceaccount.com
for ROLE in roles/run.admin roles/compute.admin roles/dns.admin \
            roles/secretmanager.admin roles/datastore.owner \
            roles/artifactregistry.admin roles/iam.serviceAccountAdmin \
            roles/resourcemanager.projectIamAdmin roles/serviceusage.serviceUsageAdmin \
            roles/storage.admin roles/billing.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$TF_SA" --role="$ROLE"
done
# WIF からこの SA を借用できるよう許可（§3 の POOL/REPO を流用）
gcloud iam service-accounts add-iam-policy-binding "$TF_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"
```

### 環境変数・シークレットの格納場所（提案）
**「設定値は GitHub Variables、機微は GitHub Secrets、ランタイムの真実は Secret Manager」** の3層。

| 種別 | 置き場所 | 例 |
|---|---|---|
| 非機微の設定 | **GitHub → Variables（`vars.*`）** | `GCP_PROJECT_ID` / `GCP_REGION` / `TF_STATE_BUCKET`（=`<project>-tfstate`）/ `PROD_DOMAIN`（`sanba.com`）/ `LIVEKIT_URL` / `ELASTICSEARCH_URL` / `OTEL_EXPORTER_OTLP_ENDPOINT` / `BILLING_ACCOUNT` |
| CI 認証 | **GitHub → Secrets（`secrets.*`）** | `WIF_PROVIDER` / `TF_DEPLOY_SA`（=`tf-deployer@…`。未設定なら `DEPLOY_SA` にフォールバック） |
| アプリの機微値 | **GitHub → Secrets（`secrets.*`）→ `TF_VAR_*` で Terraform に渡す** | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `ELASTICSEARCH_API_KEY` / `GCP_GOOGLE_API_KEY`（`use_vertexai=false` のときのみ）/ `SESSION_SIGNING_SECRET`（空可・自動生成） |
| ランタイム参照の真実 | **GCP Secret Manager**（`secrets.tf` が作成） | Cloud Run はここを参照。値の出所は上の `TF_VAR_*`。`apply` で同期される |

> 注意:
> - `apply` 時に機微 `TF_VAR_*` を渡し忘れると、`secrets.tf` の任意シークレットが空になり
>   **Secret Manager から消える**。CI で apply する場合は GitHub Secrets に必ず登録しておく。
> - `SESSION_SIGNING_SECRET` は空のままで良い（state に保存された乱数が再利用され、毎回ローテート
>   されない）。リモート state（GCS）が前提。
> - シークレットの値そのものは**コミットしない**（`terraform.tfvars` は gitignore 済）。

---

## 7. public 化に伴う GitHub 設定ハードニング（#68）

リポジトリを public にする**前後**に、GUI で以下を有効化する（コード化されない運用手順）。

1. **Settings → Actions → General → Fork pull request workflows**: 「Require approval for **all outside collaborators**」（未信頼コードの CI を承認制に）。
2. **同 → Workflow permissions**: 「Read repository contents and packages permissions」（read-only 既定）＋「Allow GitHub Actions to create and approve pull requests」を**オフ**。
3. **Settings → Code security**: Secret scanning と Push protection を **Enable**（public は無料、CI の gitleaks と多層化）。
4. **Settings → Branches**: `main` に branch protection（#62）— PR 必須・人間 1 承認・必須チェック `quality-gate`・「最新 push の再承認要求」・bot は approve/merge 不可。
5. **特権ワークフローの確認**: `claude-review-response.yml` の author_association ガード＋fork ガード（**PR #74 をマージ**）が入っていること（#67）。

> 実施したら設定スクショを #68 にコメントで残す（実施者・日時も）。

---

## 8. 完了チェック

- [ ] `terraform apply` 成功・3 サービスが Cloud Run で Ready。
- [ ] 公開 URL でインタビュー開始できる（README に掲載）。
- [ ] `deploy.yml` が GitHub Actions / GitHub Mobile から再現デプロイできる。
- [ ] LiveKit 実キーで音声経路が通る（#35 と連携）。
- [ ] #68 のリポジトリ設定が全て有効。PR #74（#67）がマージ済み。
- [ ] （§6.5）sanba.com 取得・NS を Cloud DNS に向け済み・`sanba-cert` が `ACTIVE`。
- [ ] （§6.5）`vars.NEXT_PUBLIC_API_URL` = `https://api.sanba.com` で web 再デプロイ済み。
</content>
