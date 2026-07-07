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

**方針**: Terraform が「API 有効化 + リファラ制限付きブラウザキー（箱と制約）」を所有し、
キー値（ブラウザ露出前提・リファラ制限で守るため秘匿ではない）は既存の識別子と同じく
GitHub Variable へ公開して web ビルドへ焼き込む。`google_oauth_client_id` の扱いに揃える。

1. **API 有効化**（`infra/terraform/main.tf` の `services` set に追加）
   - `drive.googleapis.com`（files.export / alt=media 取得）
   - `apikeys.googleapis.com`（`google_apikeys_key` の前提）
   - Google Picker API（サービス名 §5 で確認のうえ追加）

2. **ブラウザ API キー**（新規 `infra/terraform/` に定義。`media.tf` 併設 or `main.tf` 追記）
   ```hcl
   resource "google_apikeys_key" "picker" {
     name         = "sanba-picker-browser-key"
     display_name = "SANBA Google Picker (browser)"
     project      = var.project_id

     restrictions {
       browser_key_restrictions {
         # var.domain / var.web_subdomain から web オリジンを組み立てて allowed_referrers に。
         # domain 空（*.run.app 運用）のときは run.app の web オリジンを入れる。
         allowed_referrers = local.picker_allowed_referrers
       }
       api_targets { service = "drive.googleapis.com" }
       api_targets { service = "picker.googleapis.com" } # §5 で確認した正式名
     }
     depends_on = [google_project_service.services]
   }

   output "picker_api_key" {
     value       = google_apikeys_key.picker.key_string
     sensitive   = true
     description = "Browser key for Google Picker. Publish to GitHub Variable NEXT_PUBLIC_GOOGLE_API_KEY."
   }
   ```
   - **最小権限**: `api_targets` を Drive + Picker に限定し、リファラを web オリジンに固定する
     （キーはバンドルに焼かれ公開されるため、制限が実質的な防御。ADR-0049 リスク欄と整合）。
   - `allowed_referrers` は `variables.tf` の `domain` / `web_subdomain` から `locals` で導出。
     カスタムドメイン未使用（`domain=""`）の環境では web の `run.app` オリジンを許可に入れる。

3. **値の公開経路（境界の明示）**
   - `NEXT_PUBLIC_*` は Next.js のビルド時に焼き込まれ、Terraform とビルドは別工程。よって
     `terraform apply` 後に **一度だけ** `terraform output -raw picker_api_key` を GitHub Variable
     `NEXT_PUBLIC_GOOGLE_API_KEY` に登録する（`NEXT_PUBLIC_GOOGLE_CLIENT_ID` と同じ運用）。
   - キーはリファラ制限済みで秘匿ではないため Variable 管理でよい（Secret Manager 不要）。
     この判断根拠を deploy-gcp.md に 1 行残す。

4. **OAuth 同意画面（手順書で担保・Terraform 化不可）**
   - 同意画面のスコープに `.../auth/drive.file` を追加。`drive.file` は Picker 経由の
     ユーザー選択ファイル限定のため、`drive.readonly` のようなセンシティブ全閲覧審査を避けられる
     （ADR-0049 決定3の根拠）。審査要否は Google 側ポリシー次第なので確認結果を how-to に明記。

5. **how-to 追記**（`docs/how-to/deploy-gcp.md`）
   - 「Drive 連携を有効化する」節を新設し、(a) 上記 API 有効化は Terraform が行う、
     (b) 同意画面スコープ追加（手動）、(c) `terraform output` → GitHub Variable 登録、
     (d) 未設定時は導線が利用不可に退化する（fail-safe）ことを列挙。
   - 既存の `deploy-gcp.md:148` の一文（API キーは任意）を、この節へのリンクに更新。

### 2.3 受け入れ条件（A）
- `terraform plan` に Drive/apikeys/Picker API 有効化と `google_apikeys_key.picker` が現れる。
- `google_apikeys_key.picker` はリファラ制限 + API ターゲット制限（Drive/Picker のみ）を持つ。
- GitHub Variable 登録後の web ビルドで `isDriveConfigured()` が真になり、Picker が開く
  （手動 E2E: デプロイ環境で Docs を 1 件取り込み、資料一覧に `asset_kind="doc"` で出る）。
- 未登録環境では従来どおり「利用不可」案内に退化し、ローカルアップロードは無影響（回帰なし）。

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

**設計判断（要確認 §5）**: `MaterialSourceSheet` の「準備中」フォールバック分岐は、`onDrive` が
全実文脈で注入済みの今、本番では到達しない。(i) ADR 参照と文言だけ直して残す（02 準備以外の
再利用に備える）か、(ii) 分岐ごと削除するか。既定は **(i)**（部品の汎用性を壊さない・変更最小）。

### 3.1 受け入れ条件（B）
- コード内の `ADR-0007` / `ADR-0044` の Drive 関連参照が `ADR-0049` に統一される。
- 「未承認 / 準備中 / 別チケット」が実態（実装済み）と矛盾しない表現になる。
- `MaterialSourceSheet.test.tsx` のフォールバック文言アサーションを新文言へ追随。
- 挙動は不変（コメント/文言のみ。`just check` green）。

---

## 4. スコープ外（記録・将来）— C

ADR-0049 が明示的に見送った/触れていない拡張。#304 epic の子として別 issue 化する候補。

- **サーバ側 refresh token 保管による常時同期**（ADR-0049 §5 で保留）。GitHub App 型の
  資格情報保管が要る要件（Drive の変更を継続追従）が出たら ADR を追補する。
- **フォルダ選択・複数階層の一括取り込み・更新検知/再取り込み**（現状は単発の選択→取得）。
- **他コネクタ**（Notion / Slack 等・ADR-0007 外部コネクタ）。#304 とは別軸。

---

## 5. 未決事項（実装前に確認したい）

1. **Google Picker API の正式サービス名**（`picker.googleapis.com` か）。`google_project_service`
   と `api_targets` に入れる前に `gcloud services list --available | grep -i picker` で確定する。
2. **API キーを Terraform 所有にするか**（§2.2 案）／それとも API 有効化のみ Terraform 化し
   キーはコンソール手動のままにするか。既定は Terraform 所有（IaC 徹底）。
3. **B のフォールバック分岐**は残す（文言修正のみ・既定）か削除するか。
4. `drive.file` スコープの Google 審査要否（同意画面のブランド審査状況）。how-to に確認結果を反映。

---

## 6. 提案する PR 分割

| PR | 内容 | 主な差分 | 依存 |
|---|---|---|---|
| PR-1（A） | Drive/apikeys/Picker API 有効化 + `google_apikeys_key.picker`（リファラ/API 制限）+ output + deploy-gcp.md 手順 | `infra/terraform/main.tf`・新規 apikeys 定義・`outputs.tf`・`docs/how-to/deploy-gcp.md` | §5-1,2 の確定 |
| PR-2（B） | Drive 関連コメント/ADR 参照/フォールバック文言の是正 + テスト追随 | `MaterialSourceSheet.tsx`・`googleDrive.ts`・`auth.tsx`・対応 test | §5-3 の確定 |

PR-1 と PR-2 は独立。いずれも単独で `just check` が通り、機能挙動を変えない（PR-1 は
未登録環境で無影響、PR-2 は文言のみ）ことを受け入れ条件とする。
