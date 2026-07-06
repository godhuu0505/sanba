# ADR-0014: ログイン画面と管理画面（セッション/要件の運用UI）

- ステータス: Accepted
- 日付: 2026-06-24
- 関連: ADR-0012（Google ログイン）、ADR-0008（製品コンセプト / 出所メタ）、ADR-0001（技術スタック）、issue #8（招待トークン）、issue #10（同意/データガバナンス）

## コンテキスト
現状の `apps/web` は「インタビュー画面」（音声対話）のみで、UI ライブラリを持たずインライン
スタイルで実装されている。認証は ADR-0012 の Google Identity Services (GIS) + FastAPI サーバ
検証が実装済みだが、**専用のログイン画面は無く**、ID トークンは React state にしか保持されない。

また、運用面で次が欠けている:
- **セッション本体が永続化されていない**。`POST /api/sessions`（`apps/api/.../main.py`）は招待
  トークンを発行して `owner=sub` を**ログ出力するだけ**で、Firestore にセッション文書を作らない。
  utterances/requirements はエージェントが `sessions/{id}` 配下に書くが、セッションのメタ
  （所有者・タイトル・作成日時・状態）はどこにも残らない。
- **永続的なロール/管理者の概念が無い**。`role`（pm/engineer/customer）はセッション招待時の
  一時バインドのみ。
- AI が生成した **requirements を人間が確認・確定するワークフローが無い**。`Requirement`
  （`apps/agent/.../models.py`）に承認状態のフィールドが無く、`expireAt` による 30 日 TTL
  自動削除（`DATA_RETENTION_DAYS`）の対象になっている。

本 ADR では「ログイン画面」と「管理画面」を導入し、**運用者がセッションを俯瞰し、AI 生成
要件を編集・承認する**ための最小構成を確定する。

論点は次のとおり:
1. ログイン方式（既存基盤の扱い）
2. 管理者の判定（認可の源泉）
3. 管理画面のスコープ（何を管理するか / 閲覧範囲）
4. セッション一覧のデータ土台（永続化）
5. 要件の承認モデルと TTL の整合
6. UI 土台
7. クライアントのセッション持続とトークン失効

## 決定

### 1. ログイン方式 — 既存 Google OIDC を画面化（基盤は追加しない）
ADR-0012 の GIS + FastAPI 検証をそのまま使い、`/login` ルートに専用 UI を用意するだけにする。
メール+パスワードや外部 Auth マネージド（Firebase/Supabase）への移行はしない。理由は実装済みで
最小リスク、かつ「identity の検証を API に一本化」という ADR-0012 の信頼境界を崩さないため。

### 2. 管理者の判定 — 許可メールリスト（環境変数）
`ADMIN_EMAILS`（カンマ区切り）を環境変数で持ち、**検証済み Google identity の `email` を
サーバ側で照合**して管理者を判定する。Firestore のユーザー/ロール管理は今回は導入しない。
DB 不要で最速、ADR-0012 の「検証済み email」をそのまま使える。

> トレードオフ: 管理者の増減は env 更新（再デプロイ）が必要。人数が増えたら Firestore ロールへ
> 移行する（将来 issue 化）。

### 3. 管理画面のスコープ
管理者ができるのは次の 3 つに限定する:
- **セッション一覧・閲覧**: 全 owner のセッション一覧と、その requirements を見る。
- **要件の編集・承認**: AI 生成 requirements を編集（上書き）し、承認/却下する。
- **セッション作成・招待発行**: 既存 `POST /api/sessions` を UI 化（同意フローは踏襲）。

**閲覧範囲は requirements のみ**。生の発話（utterances＝録音の文字起こし）は管理画面に出さない。
issue #10 のプライバシー姿勢に沿い、運用に必要な成果物だけを露出する。ユーザー/ロール管理は
今回のスコープ外。

### 4. セッション一覧のデータ土台 — create 時にセッション文書を作る
`create_session` で `sessions/{id}` 文書を作成し、`id / title / owner(sub, email) / created_at /
status / roles` を保存する。一覧・閲覧・承認 API はこの文書を読む。サブコレクションの存在から
逆算する案は owner/title が取れず不完全、かつクエリも重くなるため却下。

### 5. 要件の承認モデルと TTL — ステータスフラグ + 承認時 TTL 解除
`Requirement` に `status`（`draft` / `approved` / `rejected`）と承認者・承認日時を追加する。編集は
上書き（版管理・変更履歴は今回持たない）。**承認した要件は `expireAt` を解除/延長**して 30 日
自動削除の対象から外す。「生の発話は 30 日で消す、確定要件は残す」という自然な線引きにする。

### 6. UI 土台 — Tailwind + shadcn/ui を導入
複数の運用画面（テーブル・フォーム・バッジ・ダイアログ）を作るため、`apps/web` に Tailwind +
shadcn/ui を導入する。インラインスタイル継続は実装量が増え見た目も揃いにくいため却下。

### 7. クライアントのセッション持続 — GIS 再取得 + 401 再認証
ID トークンは localStorage に保存しない（XSS でのトークン漏えいリスクを避ける）。代わりに GIS の
auto_select / One Tap でリロード時に静かに再取得し、API が 401 を返したら再サインインを促す。
真の認可は常に API 側（#2 の `ADMIN_EMAILS` 照合）が源泉で、クライアントのルートガードは UX 用。

**更新（#217 / PR #225）**: `useGoogleAuth` をルートごとに呼ぶと credential が各 hook インスタンスに
閉じ、ログイン直後の遷移先（例: `/login`→`/`）が `null` 始まりになり auto_select が skip される環境で
ログインループしうる。これを解消するため、アプリ単一の **`AuthProvider`（React Context）** を
`app/layout.tsx` に置き、全ルートが `useAuth()` で同一インスタンスの credential を読む。
**トークンは依然 in-memory のみで localStorage には保存しない**（本節の方針は不変。共有するのは
同一ページセッション内のクライアント遷移をまたぐ連続性のみで、フルリロードでは消える）。

**更新（ログイン判定の誤リダイレクト修正）**: フルロード時の「未ログイン確定」フォールバックが
固定 2.5s だったため、GIS スクリプトのロード＋auto_select 再取得がそれより遅い環境では、
ログイン済みユーザーが保護 URL に直アクセスしても毎回 `/login` へ誤送→復元後に元ページへ戻る、
という往復が起きていた。対策として **非機微なログイン痕跡ヒント**（`localStorage` の
`sanba.auth.hint.v1`、値は "1" のみ。トークン・PII は一切含まない）を導入した:
- credential 到着でヒントを書き、ログアウト（別タブ伝播含む / ADR-0030）で消す。
- ヒントがあるブラウザは復元成功が見込めるため settle フォールバックを 8s に延長し、
  待っている間は `RequireAuth` が空白ではなく「確認中」スピナーを表示する。
- 延長上限まで待っても復元できなければヒントを消し、次回ロードは従来どおり 2.5s で解決する。
これにより「ログイン済みならアクセスした URL に直接入る／未ログインなら `/login` へ送る／
ログイン済みで `/login` に来たらトップ（or `?next`）へ送る」が成立する。ID トークンを
localStorage に置かない方針（XSS 回避）は不変。

## 根拠
- 既存の検証境界（API でのサーバ検証）を崩さず、最小差分で「画面」と「運用機能」だけを足す。
- 管理者判定をサーバ側 env 照合にすることで、クライアントを信頼しない（ADR-0012 と同じ原則）。
- セッション永続化は一覧・承認・監査すべての前提であり、ここを起点に観測性を通せる。
- 承認時 TTL 解除により、データ最小化（issue #10）と成果物の保全を両立する。

## 影響
- **API**: `ADMIN_EMAILS` を `config.py` に追加し、`require_admin` 依存性を新設。管理用エンドポイント
  （例: `GET /api/admin/sessions`、`GET /api/admin/sessions/{id}/requirements`、
  `PATCH /api/admin/sessions/{id}/requirements/{rid}`）を追加し、いずれも `require_admin` でガード。
  `create_session` を `sessions/{id}` 文書の作成に対応させる。新経路すべてに観測性
  （trace / 構造化ログ / メトリクス）を通す（CLAUDE.md 原則3）。
- **データモデル**: `Requirement` に `status` / `approved_by` / `approved_at` を追加。承認時に
  `expireAt` を解除/延長するリポジトリ操作を追加（`apps/agent/.../repository.py`、`models.py`）。
  セッションメタ用のスキーマを定義。
- **Web**: `/login`（GIS ログイン UI）と `/admin`（セッション一覧 / 要件編集・承認 / セッション作成）を
  追加。Tailwind + shadcn/ui を導入。管理ルートはクライアントガード + API 401 ハンドリング。
  `useGoogleAuth` を auto_select 再取得に対応。
- **env / IaC**: `ADMIN_EMAILS`(api) を `.env.example` / docker-compose / `deploy.yml` /
  `infra/terraform` に追加（秘匿物ではないため平文 env）。
- **テスト**: `require_admin` の単体（許可/非許可 email、未ログイン）、セッション永続化と一覧の結合、
  要件の編集・承認と TTL 解除の結合テストを追加。

## 実装方針（補遺: grill 第2ラウンド 2026-06-24）
高レベルの決定（#1〜7）を実装に落とす際の方針を確定した。特に共有パッケージとビルド構成は
アーキ的影響が大きいためここに残す。

### 8. 永続化コードとモデルの共有 — `sanba_shared` パッケージに抽出
セッション/要件の永続化は agent（書き込み）と admin API（読み取り・更新）の両方が触る。コードと
モデルの二重管理を避けるため、Pydantic モデル（`Requirement` / セッションメタ / `Utterance`）と
`SessionRepository` を新パッケージ `packages/sanba_shared` に抽出する。agent は既存実装を
これへ移行し、API は読み取り・更新メソッド（セッション文書作成、一覧、要件の status 更新と
`expireAt` 解除）を追加する。

### 9. Docker ビルド構成 — build context をリポジトリ直下へ変更
現状、各アプリの Docker ビルドコンテキストは自分のディレクトリ（`./apps/api` / `./apps/agent`）で、
`COPY` がコンテキスト外（`packages/`）に出られない。共有パッケージを両イメージへ同梱するため、
**build context をリポジトリ直下に変更**し、各 Dockerfile が `packages/sanba_shared` と自身の
`src` を COPY するようにする。`docker-compose.yml` / 両 `Dockerfile` / `deploy.yml` /
`justfile` / session-start hook を一括で改修する（どれか一つでも漏れると CI/デプロイが割れる）。

### 10. 要件の編集スコープ — `statement` / `priority` / `category` のみ
管理者が上書きできるのはこの 3 つに限定する。`id` / `created_at` / `source_speaker` /
`confidence` は AI 出所メタとして保全し、人手で書き換えない（ADR-0008 の provenance と整合、
評価データを汚さない）。要件には `status`（`draft` / `approved` / `rejected`、既定 `draft`）と
`approved_by` / `approved_at` を追加する。旧データ（`status` フィールド無し）は読み込み時に
`draft` 既定でフォールバックする。

### 11. TTL ライフサイクル — approved のみ解除
`approved` で `expireAt` を解除（成果物として保全）、`draft` / `rejected` は TTL を維持して
30 日で自動削除する（データ最小化と整合、承認しない限り消える運用を周知する）。

### 12. UI 版 — Tailwind v4 + shadcn 最新
web は Next 16.2 / React 19.2。shadcn 現行標準の Tailwind v4（`@tailwindcss/postcss`、CSS-first
設定）を導入する。

### 13. ローカル開発の管理者 — 許可リストを dev でも照合
`require_admin` は `AUTH_DEV_BYPASS=true` でも `ADMIN_EMAILS` を照合する（特別扱いしない）。
`.env.example` の `ADMIN_EMAILS` に `dev@sanba.local` を記載し、`just up` で管理画面を開ける
状態を保つ。

### 14. テスト
`SessionRepository` のメモリ fallback で単体テスト、docker-compose の Firestore emulator で
結合テスト（セッション永続化・一覧・要件の編集/承認・TTL 解除）を担保する。

### 15. API が初めて Firestore クライアントになる（実装計画レビューで判明）
現状 `apps/api` は `google-cloud-firestore` を依存に持つが**ランタイムで未使用**で、compose の
`api` サービスは `firestore` に `depends_on` していない（「API は Firestore を直接使わない」前提
だった）。本 ADR で API がセッション/要件のリーダー兼ライターになるため、次を追加する:
- `docker-compose.yml` の `api.depends_on` に `firestore` を追加。
- `apps/api/config.py` に `firestore_emulator_host` / `google_cloud_project` を追加し、
  `FIRESTORE_EMULATOR_HOST` を api コンテナにも効かせる。
- terraform で **API runtime SA に `roles/datastore.user`** が付くことを確認（agent と同一 SA なら
  確認のみ）。

### 16. `deploy.yml` の paths-filter に共有パッケージを追加
共有パッケージ化に伴い、`deploy.yml` の paths-filter を
`agent: ['apps/agent/**', 'packages/sanba_shared/**']` / `api: ['apps/api/**',
'packages/sanba_shared/**']` に拡張する。これを怠ると「`sanba_shared` だけ変更して push →
agent/api が再デプロイされず本番が古いまま」という事故になる。

### 17. `expireAt` 解除は `firestore.DELETE_FIELD` センチネルで
承認時の TTL 解除は None 代入や merge では「null フィールドが残り TTL が効き続ける」懸念がある
ため、`firestore.DELETE_FIELD` でフィールドを明示削除する。メモリ fallback には expireAt 概念が
無いため分岐し、テストも分離する。

## 却下案
- **メール+パスワード認証の新設 / Firebase・Supabase Auth への移行**: 実装・運用負荷が大きく、
  ADR-0012 で確立した「検証を API に一本化」という境界を作り直すことになる。
- **Firestore に users/roles コレクションを新設**: 今回の管理者数では過剰。許可リストで足り、
  必要になってから移行する。
- **管理者が utterances（生の発話）まで閲覧**: 全員の会話を読める権限はプライバシー懸念が大きく、
  運用に必須でもない。requirements に限定する。
- **承認済み要件も 30 日で TTL 削除**: 人間が確定した成果物が消えるのは運用上不可。承認で解除する。
- **トークンを localStorage に保存**: 実装は楽だが XSS でのトークン漏えいリスクがあり推奨しない。
- **永続化を apps/api に薄く再実装（コード共有しない）**: Docker 改修は不要だがモデル/スキーマが
  二重管理になり、agent と API でフィールドがずれる事故を招く。共有パッケージを採る。
- **共有パッケージを Artifact Registry に publish**: 正統だがバージョン管理と CI 負荷が増える。
  モノレポ内の path 依存 + root build context で足りる。

## 保留（未解決リスク）
- セッション一覧のページング/フィルタは MVP では未設計。件数増加で一覧 API が重くなる可能性。
- `ADMIN_EMAILS` 運用（再デプロイ必要）。管理者が増えたら #2 を Firestore ロールへ移行検討。
- build context 変更の波及範囲（compose / 両 Dockerfile / `deploy.yml` / `justfile` /
  session-start hook）。一つでも改修漏れがあると CI かデプロイで割れる。実装時に一括で当てる。
- セッション文書（`sessions/{id}`）自体には `expireAt` を付けていない（発話・draft 要件にのみ TTL）。
  承認済み要件があるセッションのメタは残すべきだが、空セッションのメタが無制限に蓄積しうる。
  当面は許容し、件数が増えたら「承認要件ゼロのセッションは N 日で削除」等の TTL を別途設計する。
