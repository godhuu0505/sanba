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
| `use_vertexai` | `true`（本番はキーレス推奨。`false` なら SM に `google-api-key` を別途投入） |
| `livekit_url` | LiveKit Cloud の `wss://...`（§4 で取得） |
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

# deploy.yml / terraform.yml の vars.WIF_PROVIDER に入れる完全パス（識別子なので Variable）
echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
```

> セキュリティ: `attribute-condition` で `repository` を固定する。
>
> ただし fork PR の判別はここではできない。`pull_request` イベントの OIDC token の
> `assertion.repository` クレームは **base リポジトリ** (`godhuu0505/sanba`) になるため、
> fork からの PR でも条件を満たしうる。fork 由来の改変コードに plan を走らせない一次防御は
> **ワークフロー側の起動ガード** (`terraform.yml` / `deploy.yml` の job `if:` に
> `github.event.pull_request.head.repo.fork == false`) で担保する (#149)。WIF はあくまで
> 「正規リポジトリの token か」を担保する多層防御の一段目と位置づける。
>
> さらに厳格化する場合の選択肢:
> - `&& assertion.ref=='refs/heads/main'` を加えると **PR 文脈の token をすべて拒否**できる
>   (fork/同一リポジトリを問わず)。ただし PR での `terraform plan` も GCP 認証できなくなり、
>   plan コメント機能が使えなくなるトレードオフがある。plan-on-PR を捨てて apply を main 限定に
>   寄せる運用ならこちらが最も堅い。
> - plan-on-PR を残す場合は本書の構成 (repository 固定 + ワークフロー起動ガード) を用いる。

---

## 4. LiveKit Cloud（実音声経路に必須）

1. [LiveKit Cloud](https://cloud.livekit.io/) でプロジェクトを作成。
2. **Settings → Keys** で API Key / Secret を発行。
3. WebSocket URL（`wss://<project>.livekit.cloud`）を控える。
4. `livekit_url` は §2 の `terraform.tfvars` に記載。API Key / Secret は **§6.7 の `gcloud secrets versions add`** で Secret Manager に直接投入する（terraform.tfvars に書かない。`livekit_api_key` / `livekit_api_secret` 変数は廃止済み）。

---

## 5. GitHub の Variables / Secrets を登録

**Settings → Secrets and variables → Actions** で登録する。

### Repository variables（`vars.*`）
| 名前 | 値 |
|---|---|
| `GCP_PROJECT_ID` | `$PROJECT_ID`（**これが空だと `deploy.yml` は skip される**） |
| `NEXT_PUBLIC_API_URL` | §2 の `terraform output api_url`（web ビルドに必須・空だと fail fast） |
| `NEXT_PUBLIC_LIVEKIT_URL` | §4 の `wss://...` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth Web クライアント ID（API の `GOOGLE_OAUTH_CLIENT_ID` にも同値を注入。web ビルドに必須・**空だと fail fast**。焼き漏らすと web が dev モード化し認証経路が 401/503） |
| `NEXT_PUBLIC_GOOGLE_API_KEY` | Google Picker 用のブラウザ API キー（任意 / ADR-0049）。同プロジェクトで Drive API・Picker API を有効化し、HTTP リファラ制限を推奨。未設定なら「Google ドライブから選ぶ」が利用不可の案内になる |
| `WIF_PROVIDER` | §3 末尾で出力した WIF プロバイダの完全パス（秘匿値ではなく識別子なので Variable） |
| `DEPLOY_SA` | §3 の `$DEPLOY_SA`（`gh-deployer@...iam.gserviceaccount.com`。SA email は公開識別子） |
| `TF_DEPLOY_SA` | §6.6 の `tf-deployer@…`（未設定なら `DEPLOY_SA` にフォールバック） |

### Repository secrets（`secrets.*`）
| 名前 | 値 |
|---|---|
| （CI 認証に秘匿 Secret は不要） | WIF はキーレス。SA email / WIF パスは Variable。`CLAUDE_CODE_OAUTH_TOKEN` 等のみ Secret |

> WIF プロバイダのパスと SA email は**公開識別子**であり秘匿値ではない（GitHub 公式 / Google も
> Variable 推奨）。アプリの秘匿値は GitHub に置かず Secret Manager に直接投入する（§6.7）。

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

## 6.5. 独自ドメインを当てる（ADR-0013）

Global 外部 HTTPS LB + Google 管理証明書 + Cloud DNS。`infra/terraform/domain.tf` が実装済みで、
ここの手作業は **ドメイン取得・GitHub Variable 設定・レジストラの NS 設定・Google OAuth 登録**。
ログイン（Google Identity Services）を新ドメインで成立させるには **D の OAuth 登録が必須**。

> **OSS なのでドメインはコードに焼かない。** 各自が `PROD_DOMAIN`（apex）と任意の
> `PROD_WEB_SUBDOMAIN` を GitHub Variables で設定する（`.github/workflows/terraform.yml` の
> `TF_VAR_domain` / `TF_VAR_web_subdomain`）。
> - `PROD_WEB_SUBDOMAIN` 空 = apex 配信（web=`<domain>`/`www`、api=`api.<domain>`）。
> - 設定時 = web=`<sub>.<domain>`、api=`api.<sub>.<domain>`、apex/`www` は web へ 301。
>
> **以下はメンテナ環境の例**: `PROD_DOMAIN=sanba.net` / `PROD_WEB_SUBDOMAIN=youken`
> → ログインは **`https://youken.sanba.net`**、API は `https://api.youken.sanba.net`、
> `sanba.net`/`www.sanba.net` は `youken.sanba.net` へ 301。`.net` は HSTS preload TLD ではない
> （証明書発行前も HTTP は通常どおり動く）。フォーク先は自分のドメインに読み替えること。

実施は **A → B → C → D → E → F → G** の順。証明書は DNS が LB を指してから発行されるため、順番が重要。

### A. ドメインを取得する
- 任意のレジストラ（Cloud Domains / Squarespace / お名前.com 等）で apex ドメインを購入する
  （メンテナ環境は `sanba.net`、約 $14/年）。サブドメイン（`youken`）は購入不要・DNS レコードで足す。
- 取得後すぐは DNS 未設定。NS の差し替えは C で行う。

### B. GitHub Variable を設定して Terraform を apply（LB + DNS ゾーン作成）
1. **Settings → Secrets and variables → Actions → Variables** で設定（メンテナ環境の例）:
   | 名前 | 値 |
   |---|---|
   | `PROD_DOMAIN` | `sanba.net` |
   | `PROD_WEB_SUBDOMAIN` | `youken`（apex 配信なら未設定/空） |
   - `manage_dns` は既定 `true`、ゾーン名は既定 `sanba` のままでよい（変えるなら変数を追加）。
2. **Actions → Terraform (infra) → Run workflow → `action=apply`** を実行（`production` 環境に
   required reviewers があれば承認後に反映）。
3. 反映後、出力を控える（GCP コンソール or ローカル `terraform output`）:
   ```bash
   terraform output lb_ip            # LB の Anycast IP（別 DNS 運用時に使う）
   terraform output dns_name_servers # Cloud DNS のネームサーバ（次の C で使う）
   terraform output public_urls      # web / api / (subdomain 時) apex リダイレクト元の URL
   terraform output cert_domains     # 証明書がカバーするドメイン（youken/api.youken/apex/www）
   ```

### C. レジストラのネームサーバを Cloud DNS に向ける（手作業）
- レジストラの管理画面で、apex ドメイン（`sanba.net`）の **NS レコード**を `dns_name_servers` の
  4 つ（`ns-cloud-XX.googledomains.com.`）に置き換える。
- 各ホスト（`youken` / `api.youken` / apex / `www`）の A レコードは Terraform が Cloud DNS 側に
  作成済み（すべて LB IP を指す）。レジストラ側で個別 A レコードを足す必要はない。
- 反映（伝播）に最大 24〜48h。通常は数十分。

> 別 DNS を使い続けたい場合は `manage_dns = false`（変数追加が必要）にし、`terraform output lb_ip`
> の IP を自前 DNS に各ホストの A レコードとして登録する（`cert_domains` の全ホスト）。

### D. Google OAuth に web オリジンを登録（ログインの本体・手作業）
ログインは Google Identity Services（ADR-0012、`apps/web/lib/auth.ts`）。**承認済み JavaScript
生成元**に web のオリジンを足さないと、ドメインが繋がっても GIS が `origin not allowed` で失敗する。

- **GCP Console → API とサービス → 認証情報** で、`NEXT_PUBLIC_GOOGLE_CLIENT_ID` に対応する
  OAuth 2.0 クライアント ID を開く。
- **承認済みの JavaScript 生成元**に **web を配信するオリジン**を追加（メンテナ環境）:
  - `https://youken.sanba.net`
  - ※ apex 配信構成なら `https://<domain>` と `https://www.<domain>` を入れる。
  - ※ subdomain 構成では apex/`www` は 301 されオリジンにならないので入れなくてよい。
- **OAuth 同意画面 → 承認済みドメイン**に apex（`sanba.net`）を追加。
- リダイレクト URI は credential フローのため不要（追加しない）。

### E. 証明書の発行を待つ
A レコードが LB IP を指すと Google 管理証明書が自動発行される（`PROVISIONING` → `ACTIVE`、数分〜数十分）。
```bash
gcloud compute ssl-certificates describe sanba-cert --global --format='value(managed.status)'
```
`ACTIVE` になれば `https://youken.sanba.net` / `https://api.youken.sanba.net` が開く。

### F. web ビルドを API ホストに向け直す（手作業・GitHub Variables）
`NEXT_PUBLIC_*` はビルド時に焼き込まれるため、向き先変更には **web の再ビルドが必須**（`apps/web/Dockerfile`）。
- **Settings → Secrets and variables → Actions** の `vars.NEXT_PUBLIC_API_URL` を
  `https://api.youken.sanba.net`（apex 配信なら `https://api.<domain>`）に更新。
- （任意）`vars.NEXT_PUBLIC_LIVEKIT_URL` はそのまま。
- 更新後に **Actions → Deploy (Cloud Run) → Run workflow**（`apps=web`）で web を焼き直す。
  CORS（`ALLOWED_ORIGINS`）は Terraform 側が web ホスト（`youken.sanba.net`）を許可済み。

### G. 確認
- `https://youken.sanba.net` を開く → Google ログインボタン表示 → ログイン成功。
- `https://sanba.net` が `https://youken.sanba.net` へ 301 リダイレクトされる。
- ログイン後の操作で `https://api.youken.sanba.net` への呼び出しが 200（401/CORS エラーが出ないこと）。

---

## 6.6. Terraform を CI/CD で回す（PR で plan・main マージで自動 apply）

`infra/terraform` の変更を **PR で `terraform plan` 自動確認**し、**main マージで自動 `apply`**
するためのワークフロー `.github/workflows/terraform.yml`（ADR-0026）。env/secret/LB/DNS など
**インフラそのもの**を反映する（このプロダクトのマイグレーション工程に相当）。

### フロー
- **PR（`infra/terraform/**` を変更）** → `plan` を実行し、結果を PR にコメント。人間が plan を
  確認してマージ。
- **main マージ** → `deploy.yml` の `migrate` ジョブが `terraform.yml` を workflow_call で呼び、
  その場で plan → 保存した plan を `apply`（＝「plan で問題なければ apply」）。**apply 成功後に**
  変更 app のイメージ差し替え（`deploy` ジョブ）へ進む。infra 変更が無いマージでは `migrate` は
  skip され、イメージ差し替えだけが走る。
- **手動反映（ロールバック・初回構築用）** → GitHub Mobile の
  **Actions → Terraform (infra) → Run workflow → `action=apply`**。
- 安全弁: `production` 環境に **required reviewers** を付ければ、apply 実行時（自動・手動とも）に
  承認ゲートが入る（**Settings → Environments → New environment `production`** で設定）。
  承認されるまで後段の deploy も待つ。

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
            roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$TF_SA" --role="$ROLE"
done
# 予算アラート (google_billing_budget) を CI で管理する場合のみ。billing 系ロールは
# プロジェクトではなく「課金アカウント」スコープなので別コマンドで付与する。
gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
  --member="serviceAccount:$TF_SA" --role="roles/billing.costsManager"
# WIF からこの SA を借用できるよう許可（§3 の POOL/REPO を流用）
gcloud iam service-accounts add-iam-policy-binding "$TF_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"
```

### 環境変数・シークレットの格納場所
**アプリの秘匿値は Secret Manager を唯一の置き場にする**（GitHub や terraform state に値を残さない）。

| 種別 | 置き場所 | 例 |
|---|---|---|
| 非機微の設定 / 公開識別子 | **GitHub → Variables（`vars.*`）** | `GCP_PROJECT_ID` / `GCP_REGION` / `TF_STATE_BUCKET` / `PROD_DOMAIN` / `LIVEKIT_URL` / `NEXT_PUBLIC_*` / `OTEL_EXPORTER_OTLP_ENDPOINT` / `BILLING_ACCOUNT` / `AGENT_MIN_INSTANCES` / **`WIF_PROVIDER` / `DEPLOY_SA` / `TF_DEPLOY_SA`**（SA email・WIF パスは公開識別子） / `ACTIVE_APP_SECRET_IDS`（JSON 配列） |
| CI 自身が使う秘匿値のみ | **GitHub → Secrets（`secrets.*`）** | `CLAUDE_CODE_OAUTH_TOKEN` / `LANGFUSE_*`（llm-eval 用）など、SM 経由にできないもの |
| アプリの秘匿値（真実） | **GCP Secret Manager に直接投入**（§6.7） | `livekit-api-key` / `livekit-api-secret` / `elasticsearch-api-key` / `session-signing-secret`（自動生成） |

> ポイント:
> - terraform は Secret Manager の**箱（secret）と Cloud Run 参照と IAM だけ**を管理し、**アプリ秘匿値の
>   version は管理しない**。よって値は GitHub Secrets にも terraform state にも残らない（散在を防ぐ）。
> - 値は `gcloud secrets versions add` で SM に投入し、投入済みの id を `ACTIVE_APP_SECRET_IDS`
>   （= `var.active_app_secret_ids`）に足して `apply` すると Cloud Run に注入される。
> - `session-signing-secret` だけは自動生成のため terraform が version まで作る（GitHub は経由しない）。
> - シークレットの値そのものは**コミットしない**（`terraform.tfvars` は gitignore 済）。

---

## 6.7. アプリ秘匿値を Secret Manager に投入する（値の唯一の置き場）

terraform apply で**空の箱**（`sanba-livekit-api-key` 等）と IAM は作られる。**値は手作業/別経路で SM に
投入**し、Cloud Run に注入したいものを `ACTIVE_APP_SECRET_IDS` に足す。

```bash
# 例: LiveKit のキーを SM に投入（値は端末→SM へ直接。GitHub/state を経由しない）
printf '%s' "$LIVEKIT_API_KEY"    | gcloud secrets versions add sanba-livekit-api-key    --data-file=-
printf '%s' "$LIVEKIT_API_SECRET" | gcloud secrets versions add sanba-livekit-api-secret --data-file=-
```

その後、Cloud Run に注入する id を GitHub Variable `ACTIVE_APP_SECRET_IDS`（JSON 配列）に設定して
`apply`（Actions → Terraform → `apply`）:

```
ACTIVE_APP_SECRET_IDS = ["livekit-api-key","livekit-api-secret"]
```

> ローテーション: 新しい値を `gcloud secrets versions add` で足すだけ（Cloud Run は `latest` 参照）。
> terraform 再 apply は不要。
>
> **注意 — 即時反映が必要な場合**: Cloud Run の secret env はインスタンス起動時に解決される。
> `min_instance_count=1` など常駐インスタンスがいる場合は、古い値をキャッシュし続ける。
> 古いキーを無効化するなどで即時切り替えが必要なら、新 version 追加後に新 revision をデプロイして
> インスタンスを入れ替える（`sanba-agent` と `sanba-api` の両方が同じ秘匿値を使うため、両方を再デプロイする）:
> ```bash
> REGION=us-central1
> for svc in sanba-agent sanba-api; do
>   # 現在と同じイメージで再デプロイ → 新 revision が secret の最新 version を解決する
>   IMAGE=$(gcloud run services describe "$svc" --region="$REGION" \
>     --format='value(spec.template.spec.containers[0].image)')
>   gcloud run deploy "$svc" --image="$IMAGE" --region="$REGION" --quiet
> done
> ```

### 旧構成からの一度きりの state 移行
以前は値を `TF_VAR_*` から version に書き込んでいた。**この構成の初回 apply の前に**一度だけ実行する:

**ステップ 0: `ACTIVE_APP_SECRET_IDS` を GitHub Variable に設定する（apply 前に必須）**

CI apply 時に `ACTIVE_APP_SECRET_IDS` が未設定だと `[]` として扱われ、Cloud Run から既存の
`LIVEKIT_API_KEY` 等がすべて削除される。apply 前に旧構成で投入済みの secret id を Variable に設定する:

```
# 例: 旧構成で livekit/elasticsearch/google を SM に入れていた場合
ACTIVE_APP_SECRET_IDS = ["livekit-api-key","livekit-api-secret","elasticsearch-api-key","google-api-key"]
```

GitHub リポジトリの Settings → Secrets and variables → Actions → Variables タブで設定する。

```bash
cd infra/terraform

# 1. livekit / elasticsearch / google-api-key の app version を管理外に外す
#    （新構成では version を管理しないので、destroy されないよう state rm する）
terraform state rm 'google_secret_manager_secret_version.app["livekit-api-key"]'     2>/dev/null || true
terraform state rm 'google_secret_manager_secret_version.app["livekit-api-secret"]'  2>/dev/null || true
terraform state rm 'google_secret_manager_secret_version.app["elasticsearch-api-key"]' 2>/dev/null || true
terraform state rm 'google_secret_manager_secret_version.app["google-api-key"]'      2>/dev/null || true

# 2. session-signing-secret の version を新リソース名に引き継ぐ（destroy/recreate を回避）
terraform state mv \
  'google_secret_manager_secret_version.app["session-signing-secret"]' \
  google_secret_manager_secret_version.session_signing
```

> **session-signing-secret のローテーションに注意**: `state mv` 後の初回 apply では
> `random_password.session_signing` が新規作成されランダム値を生成する。
> もし旧 SM version のペイロードと異なれば terraform が新 version を作成し、
> **既存の招待トークン・セッション署名が無効になる**。
> 既存値を保持したい場合は初回 apply 前に `terraform.tfvars` へ一時的に設定する:
> ```hcl
> # 現在の値を確認してから設定（apply 後は削除してよい）
> # gcloud secrets versions access latest --secret=sanba-session-signing-secret
> session_signing_secret = "<current_value>"
> ```

---

## 7. public 化に伴う GitHub 設定ハードニング（#68）

リポジトリを public にする**前後**に、GUI で **コード化されないリポジトリ設定**を有効化する
（fork PR の承認制・`GITHUB_TOKEN` read-only・Secret scanning / Push protection・`main` の
branch protection・特権ワークフローの確認）。

**手順・望ましい状態・実施台帳は [`../reference/security.md §8.1`](../reference/security.md) を正とする**
（本 runbook では再掲しない）。実施したら設定スクショを #68 にコメントで残す（実施者・日時も）。

---

## 8. 完了チェック

- [ ] `terraform apply` 成功・3 サービスが Cloud Run で Ready。
- [ ] 公開 URL でインタビュー開始できる（README に掲載）。
- [ ] `deploy.yml` が GitHub Actions / GitHub Mobile から再現デプロイできる。
- [ ] LiveKit 実キーで音声経路が通る（#35 と連携）。
- [ ] #68 のリポジトリ設定が全て有効。PR #74（#67）がマージ済み。
- [ ] （§6.5）apex 取得・`vars.PROD_DOMAIN`（+ 必要なら `vars.PROD_WEB_SUBDOMAIN`）設定・apply 済み・NS を Cloud DNS に向け済み・`sanba-cert` が `ACTIVE`。
- [ ] （§6.5）Google OAuth の承認済み JavaScript 生成元に web オリジン（例 `https://youken.sanba.net`）を追加済み。
- [ ] （§6.5）`vars.NEXT_PUBLIC_API_URL`（例 `https://api.youken.sanba.net`）で web 再デプロイ済み・ログイン疎通確認済み。
</content>
