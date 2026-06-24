# ADR-0014: ログイン画面と管理画面（セッション/要件の運用UI）

- ステータス: Proposed
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

## 却下案
- **メール+パスワード認証の新設 / Firebase・Supabase Auth への移行**: 実装・運用負荷が大きく、
  ADR-0012 で確立した「検証を API に一本化」という境界を作り直すことになる。
- **Firestore に users/roles コレクションを新設**: 今回の管理者数では過剰。許可リストで足り、
  必要になってから移行する。
- **管理者が utterances（生の発話）まで閲覧**: 全員の会話を読める権限はプライバシー懸念が大きく、
  運用に必須でもない。requirements に限定する。
- **承認済み要件も 30 日で TTL 削除**: 人間が確定した成果物が消えるのは運用上不可。承認で解除する。
- **トークンを localStorage に保存**: 実装は楽だが XSS でのトークン漏えいリスクがあり推奨しない。

## 保留（未解決リスク）
- セッション一覧のページング/フィルタは MVP では未設計。件数増加で一覧 API が重くなる可能性。
- `ADMIN_EMAILS` 運用（再デプロイ必要）。管理者が増えたら #2 を Firestore ロールへ移行検討。
