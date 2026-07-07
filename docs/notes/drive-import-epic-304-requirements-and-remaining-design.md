# 要件定義 & 残設計 — 参考資料の Google ドライブ取り込み（epic #304）

> 状態: **Draft（作業文書 / 非 SoT・ADR-0050 原則4）**。着地したら削除し、恒久化すべき内容は
> `reference/`・`how-to/`・ADR へ移す。
> 設計判断の一次情報は [ADR-0049](../adr/0049-upload-types-and-google-drive-import.md)
> （資料アップロード形式拡張と Google ドライブ取り込み）。本書はそれを #304 の要件定義として
> 明文化し、**残っている運用/IaC の穴（A）とコメント負債（B）を実装に入れるレベルまで設計する**。
> 各 PR は単独で `just check`（lint / 型 / test / build）が通り、デプロイ可能な状態を保つ（CLAUDE.md）。

## 0. 結論（TL;DR）

epic #304「参考情報を Drive からファイルを選べると便利」の**機能本体は ADR-0049 / PR #366 で
実装済み・main にマージ済み**。「Drive からファイルを選ぶ」体験は動く。
残るのは次の 2 点で、いずれも新規の設計判断ではなく ADR-0049 の**運用・後始末**にあたる。

- **A（P1 / production-readiness）**: Drive 連携を動かす GCP 資源が IaC 化されておらず、
  本番は既定で「利用不可」に退化する。手作業コンソール設定に依存＝CLAUDE.md「IaC を後回しに
  して手作業デプロイ」抵触。
- **B（P2 / 規約）**: 実装後に陳腐化したコメント・ADR 参照（`ADR-0007 未承認` / `ADR-0044` /
  `準備中` / `別チケット`）がコードに残り、現行仕様として誤読されうる。

---

## 1. AS-IS：#304 は何が実装済みか（要件トレーサビリティ）

「要件定義の完成」は、まず**実装済みの事実を要件として追認・明文化**することから始める
（AS-IS を一次情報とする・ADR-0050 原則6）。#304 の受理体験は下表のとおり全経路が存在する。

| # | 要件（追認） | 実装 | 実装場所 |
|---|---|:--:|---|
| FR-1 | 資料追加シートに「Google ドライブから選ぶ」導線がある | ✅ | `apps/web/components/MaterialSourceSheet.tsx`（`SourceRow` "drive"） |
| FR-2 | 準備画面（02）と会話中（05）の両方から Drive を選べる | ✅ | `EntryFlow.tsx:1037` / `SessionView.tsx:463`（`onDrive`） |
| FR-3 | 最小権限 `drive.file` + Google Picker で、選んだファイルだけ読む | ✅ | `lib/googleDrive.ts`（`openDrivePicker`）/ `lib/auth.tsx`（`DRIVE_SCOPE`） |
| FR-4 | Google ログイン時に Drive 同意を求め、拒否/失効は fail-closed | ✅ | `lib/auth.tsx`（`requestDriveAccess` / `driveGranted`、`select_by!=="auto"`） |
| FR-5 | Docs→Markdown / Sheets→xlsx / Slides→txt へ export、他は `alt=media` | ✅ | `lib/googleDrive.ts`（`EXPORT_PLANS` / `driveFetchPlan` / `importDriveFile`） |
| FR-6 | 取得はブラウザで行い既存 `POST /context/file` に合流（API に Google 資格情報を渡さない） | ✅ | `lib/googleDrive.ts` → 既存アップロード経路 |
| FR-7 | 取り込んだ資料を素材（`asset_kind="doc"`）として一級化・抽出・冪等索引 | ✅ | `apps/api/.../ingestion.py` / `storage.py` |
| FR-8 | Picker 用 API キー未設定の環境では導線を「利用不可」に退化（ローカルアップロードは無影響） | ✅ | `lib/googleDrive.ts`（`isDriveConfigured`） |
| NFR-1 | アクセストークンはクライアントメモリのみ（localStorage/Firestore に置かない） | ✅ | `lib/auth.tsx`（`driveTokenRef` / `driveExpiryRef`） |
| NFR-2 | ビルド時 `NEXT_PUBLIC_GOOGLE_API_KEY` を web バンドルへ注入する配線 | ✅ | `apps/web/Dockerfile`（ARG/ENV）/ `.github/workflows/deploy.yml`（build-arg） |

**テスト**: `lib/googleDrive.test.ts` / `lib/auth-drive-consent.test.tsx` / `lib/api.test.ts` /
`components/MaterialSourceSheet.test.tsx` などで単体カバー済み。

---

## 2. 残ギャップ A：Drive 連携を本番で動かす IaC / 運用（P1）

### 2.1 問題
Drive 導線は `isDriveConfigured()`（`NEXT_PUBLIC_GOOGLE_API_KEY` と `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
が両方揃う）で初めて有効になる。しかし本番を成立させる GCP 側資源が**コードで管理されていない**:

- `infra/terraform/main.tf` の有効 API 一覧（`google_project_service.services`）に
  **`drive.googleapis.com` が無い**。apikeys provider を使うなら `apikeys.googleapis.com` も要る。
  Google Picker API のサービス名は実装前に要確認（後述 §5）。
- Picker 用ブラウザ API キーを払い出す **`google_apikeys_key` リソースが無い**。
  HTTP リファラ制限・API ターゲット制限も未設定。
- CI 側配線（Dockerfile ARG・deploy.yml build-arg）は済んでいるが、GitHub Variable
  `NEXT_PUBLIC_GOOGLE_API_KEY` に**入れるべき値の出所が未定義**（手作業コンソール依存）。
- OAuth 同意画面への `drive.file` スコープ登録・審査状態を書いた how-to が無い
  （同意画面は Google 管理のため Terraform 化不可 → 手順書で担保する領域）。

結果、`terraform apply` してデプロイしても Drive 導線は「利用不可」のまま。CLAUDE.md の
「本番志向」「IaC を後回しにして手作業デプロイ禁止」に反する。

### 2.2 設計（実装に入れるレベル）

**方針（ヒアリング 2026-07-07 で確定）**: Terraform が「API 有効化 + リファラ/API 制限付き
ブラウザキー（箱と制約）+ 値の格納先（Secret Manager）」を所有する。値は **GitHub Variable では
なく Secret Manager を唯一の置き場**とし、web ビルドは既にある WIF 認証で Secret Manager から
読み出して build-arg に渡す。これは既存の秘匿値運用（"Secret Manager が唯一の置き場・GitHub には
非秘匿識別子のみ・Terraform は箱と参照を管理"・`terraform.yml` 注記）に倣った、より安全で
OSS（PUBLIC リポジトリ）前提の受け渡しにするため。
> ブラウザキーの本質的な防御は「隠す」ことではなく「制限する」こと（キーは JS バンドルに焼かれ
> 最終的に公開される）。Secret Manager 化は値を GitHub 全体に散らさないための衛生で、恒久的な
> 防御はリファラ制限 + API ターゲット制限にある。

1. **API 有効化**（`infra/terraform/main.tf` の `services` set に追加）
   - `drive.googleapis.com`（files.export / alt=media 取得）
   - `picker.googleapis.com`（Google Picker API・§5-1 で確定）
   - `apikeys.googleapis.com`（`google_apikeys_key` を Terraform で作る前提）

2. **ブラウザ API キー + 値の格納**（新規 `infra/terraform/`。`media.tf` 併設 or 新ファイル）
   ```hcl
   resource "google_apikeys_key" "picker" {
     name         = "sanba-picker-browser-key"
     display_name = "SANBA Google Picker (browser)"
     project      = var.project_id

     restrictions {
       browser_key_restrictions {
         # var.domain / var.web_subdomain から web オリジンを組み立てて allowed_referrers に。
         # domain 空（*.run.app 運用）のときは web の run.app オリジンを入れる。
         allowed_referrers = local.picker_allowed_referrers
       }
       api_targets { service = "drive.googleapis.com" }
       api_targets { service = "picker.googleapis.com" }
     }
     depends_on = [google_project_service.services]
   }

   # 値の唯一の置き場は Secret Manager（GitHub Variable には置かない）。
   resource "google_secret_manager_secret" "picker_api_key" {
     secret_id = "next-public-google-api-key"
     replication { auto {} }
     depends_on = [google_project_service.services]
   }
   resource "google_secret_manager_secret_version" "picker_api_key" {
     secret      = google_secret_manager_secret.picker_api_key.id
     secret_data = google_apikeys_key.picker.key_string
   }
   # web ビルドが読む deployer SA に、このシークレットの accessor を付与（最小権限）。
   resource "google_secret_manager_secret_iam_member" "picker_key_ci" {
     secret_id = google_secret_manager_secret.picker_api_key.id
     role      = "roles/secretmanager.secretAccessor"
     member    = "serviceAccount:${var.terraform_deployer_sa}" # = web ビルドの WIF SA
   }
   ```
   - **最小権限**: `api_targets` を Drive + Picker に限定し、リファラを web オリジンに固定
     （公開キーの実質的防御はここ。ADR-0049 リスク欄と整合）。
   - `allowed_referrers` は `variables.tf` の `domain` / `web_subdomain` から `locals` で導出。
     `domain=""`（*.run.app 運用）では web の run.app オリジンを許可に入れる。
     **対象範囲は External / 一般公開**（§5-4）なので本番ドメイン + 必要ならデモ用オリジンを許可に。
   - **透明性（許容する残リスク）**: Terraform がキーを作る以上 `key_string` は state（GCS・
     限定アクセス）に平文で残る（provider 仕様上不可避）。露出前提の低機微値であり private state
     上の保持は許容する。より厳格にするなら「キーは gcloud で作成し Secret Manager にだけ入れ、
     Terraform は制約を持たない」変種があるが、制約が IaC から外れ再現性が落ちるため非推奨。

3. **CI（`.github/workflows/deploy.yml` の web ビルド）**
   - 現状の build-arg `NEXT_PUBLIC_GOOGLE_API_KEY = vars.NEXT_PUBLIC_GOOGLE_API_KEY`（GitHub
     Variable 参照）を廃し、既存の `auth`/`setup-gcloud`（WIF）の後で
     `gcloud secrets versions access latest --secret=next-public-google-api-key` で取得して
     build-arg へ渡す。→ **値はリポジトリにも GitHub Variables にも載らない**（OSS 安全・ログはマスク）。
   - 未取得（シークレット未作成の環境）でも空 build-arg で Dockerfile 既定に落ち、Drive 導線は
     「利用不可」に退化するだけ（fail-safe・ローカルアップロードは無影響）。

4. **OAuth 同意画面（手順書で担保・Terraform 化不可）**
   - 既存の同意画面（**External / 一般公開**・ログインで `openid/email/profile` を使用）の
     スコープ一覧に `.../auth/drive.file` を 1 つ追加するだけ。§5-4 のとおり `drive.file` は
     **非センシティブ**で、非センシティブのみなら **OAuth アプリ審査は不要**・未確認アプリ警告も
     出ない（`drive.readonly` のような restricted 審査/CASA を回避＝ADR-0049 決定3の狙い）。

5. **how-to 追記**（`docs/how-to/deploy-gcp.md`）
   - 「Drive 連携を有効化する」節を新設し、(a) API 有効化・キー・Secret は Terraform が行う、
     (b) 同意画面に `drive.file` を追加（手動・審査不要）、(c) web ビルドは Secret Manager から
     値を取得する（GitHub Variable 不要）、(d) 未構成時は導線が利用不可に退化する（fail-safe）
     ことを列挙。
   - 既存の `deploy-gcp.md:148` の一文（API キーは任意 / GitHub Variable）を、この節へのリンクと
     Secret Manager 運用に更新する。

### 2.3 受け入れ条件（A）
- `terraform plan` に Drive/Picker/apikeys API 有効化・`google_apikeys_key.picker`・
  `google_secret_manager_secret(.version) picker_api_key`・deployer SA への accessor が現れる。
- `google_apikeys_key.picker` はリファラ制限 + API ターゲット制限（Drive/Picker のみ）を持つ。
- キー値は GitHub Variables に存在しない（`vars.NEXT_PUBLIC_GOOGLE_API_KEY` 参照が deploy.yml から消える）。
- Secret 投入済み環境の web ビルドで `isDriveConfigured()` が真になり Picker が開く
  （手動 E2E: デプロイ環境で Docs を 1 件取り込み、資料一覧に `asset_kind="doc"` で出る）。
- Secret 未投入環境では従来どおり「利用不可」案内に退化し、ローカルアップロードは無影響（回帰なし）。

---

## 3. 残ギャップ B：陳腐化コメント・ADR 参照ずれの整理（P2）

ADR-0049 で承認・実装され、`onDrive` は実文脈（EntryFlow / SessionView）で常に注入済みなのに、
コードは「未承認 / 準備中 / 別チケット / ADR-0007 / ADR-0044」を今も参照している。CLAUDE.md
「触った古い what/経緯コメントは削除」「コメントだけが古びて嘘をつく」に反する。実際の齟齬:

| ファイル | 現状のコメント/文言 | 是正 |
|---|---|---|
| `MaterialSourceSheet.tsx:16` | 「ADR-0044 / ADR-0007 の保留を解除」 | 参照を **ADR-0049** に修正 |
| `MaterialSourceSheet.tsx:44-45` | 「ADR-0007 未承認のため既定は準備中」「別チケット」 | ADR-0049 で実装済みに合わせ、`onDrive` 未注入は「再利用文脈のフォールバック」であって未承認ではない旨に修正 |
| `MaterialSourceSheet.tsx:78` | 「Drive 未承認（ADR-0007）」 | 「未注入文脈のフォールバック案内」に文言修正 |
| `MaterialSourceSheet.tsx:198-200` | ユーザー向け「準備中です（別チケット・ADR-0007）」 | 実運用では onDrive 注入済みで出ない分岐。文言を「この画面では未対応」等に見直し、ADR 参照を除去 or 0049 に |
| `lib/googleDrive.ts:3` | ヘッダ「ADR-0044」 | **ADR-0049** に修正 |
| `lib/auth.tsx:77`,`348` 付近 | 「ADR-0044」 | **ADR-0049** に修正 |

**設計判断（ヒアリング 2026-07-07 で確定）**: `MaterialSourceSheet` の「準備中」フォールバック
分岐は、`onDrive` が全実文脈（EntryFlow / SessionView）で注入済みの今、本番では**到達しない
死んだ枝**で、しかも文言が実態（ADR-0049 で実装済み）と矛盾する。さらに「未構成（APIキー無し）」
ケースは `isDriveConfigured()` が `handleDriveImport` 内で正しい案内を出すため機能的にも重複。
→ **分岐ごと削除して簡素化する（案 ii）**。`onDrive` 未注入時の `driveNotice` 状態・案内 UI・
`onDrive ?? (() => setDriveNotice(true))` の握りつぶしを撤去し、Drive 行の実行は注入された
`onDrive` に一本化する（未構成時の退化は `isDriveConfigured()` 側に委ねる）。

### 3.1 受け入れ条件（B）
- コード内の `ADR-0007` / `ADR-0044` の Drive 関連参照が `ADR-0049` に統一される。
- `MaterialSourceSheet` の「準備中 / 別チケット」フォールバック分岐（`driveNotice` state・案内文・
  `?? setDriveNotice` フォールバック）が削除され、実態と矛盾する文言が残らない。
- `MaterialSourceSheet.test.tsx` の該当（フォールバック文言）アサーションを削除/追随させる。
- Drive 導線の実挙動は不変（注入済み `onDrive` 経由。`just check` green）。

---

## 4. スコープ外（記録・将来）— C

ADR-0049 が明示的に見送った/触れていない拡張。#304 epic の子として別 issue 化する候補。

- **サーバ側 refresh token 保管による常時同期**（ADR-0049 §5 で保留）。GitHub App 型の
  資格情報保管が要る要件（Drive の変更を継続追従）が出たら ADR を追補する。
- **フォルダ選択・複数階層の一括取り込み・更新検知/再取り込み**（現状は単発の選択→取得）。
- **他コネクタ**（Notion / Slack 等・ADR-0007 外部コネクタ）。#304 とは別軸。

---

## 5. 未決事項 → すべて解決（ヒアリング 2026-07-07）

1. **Google Picker API のサービス名** → **`picker.googleapis.com`** で確定。有効化対象は
   `drive.googleapis.com` / `picker.googleapis.com` / `apikeys.googleapis.com` の 3 つ。
   （出典: [Cloud Console API Library](https://console.cloud.google.com/apis/library/picker.googleapis.com)）
2. **API キーの管理** → **Terraform 所有**で確定。ただし値は GitHub Variable ではなく
   **Secret Manager を唯一の置き場**とし、web ビルドは WIF で Secret Manager から読む（§2.2）。
   既存の秘匿値運用に倣い、OSS（PUBLIC）前提でより安全な受け渡しにする。state への `key_string`
   残存は露出前提の低機微値として許容。
3. **B のフォールバック分岐** → **削除して簡素化**で確定（§3・案 ii）。
4. **`drive.file` の審査要否** → **審査不要**で確定。`drive.file` は非センシティブスコープで、
   非センシティブのみのアプリは OAuth 審査不要・未確認警告なし（2026 時点）。同意画面の
   **User type は External / 一般公開**（デモ含む）。運用は同意画面へ `drive.file` を 1 つ追加するだけ。
   （出典: [Choose Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) /
   [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)）

---

## 6. 提案する PR 分割

| PR | 内容 | 主な差分 | 依存 |
|---|---|---|---|
| PR-1（A） | Drive/Picker/apikeys API 有効化 + `google_apikeys_key.picker`（リファラ/API 制限）+ Secret Manager 格納 + deployer SA accessor + deploy.yml を Secret Manager 取得へ + deploy-gcp.md 手順 | `infra/terraform/main.tf`・新規 apikeys/secret 定義・`.github/workflows/deploy.yml`・`docs/how-to/deploy-gcp.md` | 解決済み（§5-1,2,4） |
| PR-2（B） | Drive 関連コメント/ADR 参照の是正（0007/0044→0049）+ `MaterialSourceSheet` フォールバック分岐の削除 + テスト追随 | `MaterialSourceSheet.tsx`・`googleDrive.ts`・`auth.tsx`・`MaterialSourceSheet.test.tsx` | 解決済み（§5-3） |

PR-1 と PR-2 は独立。いずれも単独で `just check` が通り、Drive の実挙動を変えない（PR-1 は
Secret 未投入環境で無影響、PR-2 は到達しない死枝の削除とコメント是正）ことを受け入れ条件とする。
