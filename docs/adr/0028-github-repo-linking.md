# ADR-0028: GitHub App 個別連携・ES 索引・branch 対応

- ステータス: Accepted
- 日付: 2026-06-29（改訂: 2026-07-04）
- 関連: ADR-0027（セッション単位の GitHub repo 選択 — 本 ADR はこれを拡張する）/
  ADR-0003（Elasticsearch grounding）/ ADR-0007（外部コネクタ）/ ADR-0012（Google ログイン）/
  ADR-0014（管理・ログイン画面）/ ADR-0023（段階アップロード進捗）

> **改訂注記（2026-07-04）**: 本 ADR は当初 ADR-0025 として起票されたが、番号衝突の解消で
> ADR-0028 に振り直した。また「セッション単位の repo 選択」（`SessionMeta.github_repo`、
> `POST /api/sessions` での受理・検証、export / agent の「セッション文書→環境変数」解決、
> 02 準備の「連携リポジトリ（任意）」欄）は **ADR-0027 の決定**となったため、本 ADR の
> スコープはそれを拡張する **GitHub App によるユーザー個別連携・リポジトリの ES 索引・
> branch 対応（branch/sha/index_status）** に改訂する。repo 候補一覧
> `GET /api/github/repos` は ADR-0027 の応答形（enabled/repos/default）を基準に 1 本へ
> 統一し、App 連携済みのときは additive な `linked` / `items`（default_branch 付き）を
> 加えて App 由来の一覧を返す。

> **改訂注記（2026-07-08）**: product スコープのセッション（`SessionMeta.product_id` あり）では、
> repo passage の鮮度判定（`_is_stale_repo_passage`）の基準を「セッション作成時にコピーした
> `github_commit_sha` のスナップショット」から「product 文書の現在の `github_commit_sha`」に変更した
> （#440）。product が session 開始後に再索引されるとスナップショットが陳腐化し、新しく索引された
> passage が全件 stale 判定されて repo grounding が0件に落ちる latent バグを修正。per-session の
> repo 選択（`product_id` なし・本 ADR 本来のスコープ）の据え置きピン留め方針は変更なし。

## コンテキスト
要件サンバの深掘りは、対象プロダクトの「いま在るコード・ドキュメント・課題」を前提に
できると解像度が一段上がる。これまで GitHub 連携は環境単一 PAT の
`GitHubConnector`（ADR-0007・既定 OFF）と確定要件の Issue 書き戻し（`/export`）だけで、
**ユーザーごとの連携**も**準備画面でのリポジトリ選択**も無かった。

要望は次の 4 点:
1. アカウント設定画面で GitHub アカウント連携ができる。
2. 連携アカウントが管理するリポジトリを要件サンバ準備画面で選択できる。
3. 準備画面でリポジトリと branch を選択できる（branch は既定でデフォルトブランチ）。
4. 深掘り時に紐づけたリポジトリの情報を前提情報として扱う。

## 決定

### 連携方式 — GitHub App
OAuth App / PAT ではなく **GitHub App** を採用する。インストール単位でユーザーが対象
リポジトリを選択でき、アクセストークンは App 秘密鍵から短命発行できる。最小権限・
供給網ハードニング方針（CLAUDE.md）に最も合う。要求権限は **Contents / Metadata /
Issues すべて read-only**。書き込みは持たない（既存 `/export` の Issue 書込は別経路のまま）。

### 連携情報の保存 — Firestore `users/{sub}`
Google ID トークンの `sub` をキーに新規 `users/{sub}` コレクションを作り、
`installation_id` と `github_login` を保存する。**生のアクセストークンは保存しない**。
都度 App 秘密鍵（Secret Manager）から installation token を発行する（漏洩面を最小化）。

### ID 紐づけ — 署名 state + 所有権検証
連携開始時に、検証済み `sub` + nonce + 有効期限を既存 HMAC 署名基盤（`auth.py`）で
`state` に詰めて GitHub へ渡す。install コールバックで `state` を検証してから
`users/{sub}` に保存する。これで CSRF・誤紐づけを防ぐ。

ただし署名 `state` は Google `sub` を束縛するだけで、「その sub が当該 `installation_id`
を保有するか」は証明しない。別人が他者の `installation_id` を自分の正当な `state` と組み
合わせて callback を直接叩くと、他者の installation を奪取し得る（レビュー指摘）。そこで
**user-to-server OAuth** を併用し、install 時の `code` から取得したユーザートークンで
`GET /user/installations` を引き、選ばれた `installation_id` を当該ユーザーが保有することを
**保存前に検証**する（フェイルクローズ）。OAuth クライアント（`github_app_client_id` /
`github_app_client_secret`）が構成された本番では必須。未構成の dev/local では検証を省く
（警告ログを残す）。GitHub App 設定で "Request user authorization (OAuth) during
installation" を ON にする。

### 連携主体 — セッション owner 固定
多人数セッションでも、使うのは**セッション owner の連携アカウントのリポジトリだけ**。
「要件開始前に 1 つ紐づける」仕様に合う。

### 前提情報化 — 既存 Elasticsearch に索引（新ストアは足さない）
既存 ES は既に BM25 + kNN ハイブリッド（＝ベクトル検索）を備える。Postgres/pgvector は
新設しない（運用・IaC・二重管理の増加に見合わない）。リポジトリ情報を既存 grounding 索引へ
入れ、agent は既存 `search_grounding` で参照する。

- **索引範囲**: repo メタ + README + docs + ファイルツリー + Issue + manifest +
  **コード本体**を chunk 索引。
- **関連度優先 + 総量キャップ**: README/docs/manifest/ソースを優先し、
  `node_modules`/`vendor`/`build`/lockfile/binary/巨大ファイルを除外。総ファイル数・
  総バイトに上限を設け、超過分はスキップして log + UI に表示する。
- **コードのシークレット混入対策**: 索引前に gitleaks 相当の秘匿スキャンを掛けて
  検出部をレダクトする。既存 PII マスク（`mask_pii_before_index`）と並行して通す。
- **agent への効かせ方**: retrieval 任せにせず、セッション開始時に repo 要約
  （名/説明/README 先頭/トップ階層ツリー/主要言語）を agent の初期 instructions へ
  **シード**し、詳細は `search_grounding` で深掘りさせる。要約は LLM 追加呼び出しなしの
  **機械的組み立て**で作る。

### branch と鮮度
索引は **(repo, branch, commit_sha)** でキー化し、セッション間で**共有・再利用**する
（同 commit なら再索引しない）。準備画面では既定でデフォルト branch を選び、変更時は
その branch を非同期で索引する。選択時の `commit_sha` にピン留めし、新 commit が入っても
索引は据え置く。準備画面に索引済み sha + 日時を表示し、**手動「再同期」ボタン**で更新する。
webhook 自動追従は今回スコープ外（古い索引リスクは手動再同期で緩和）。クエリ時は owner が
当該 repo の installation を持つかを検証してアクセス制御する（共有索引の越境参照を防ぐ）。

### 索引タイミングと進捗
準備画面で repo を選択した瞬間に**非同期（バックグラウンド）索引を開始**し、進捗を表示する。
会話開始までの完了を目標とし、未完でも `search_grounding` は部分結果を返せる。進捗は
LiveKit ルーム参加前のため、**SSE で push** する（Cloud Run のリクエストタイムアウト
上限があるため、長時間索引は `Last-Event-ID` 等で再接続可能に設計する）。

### 実行主体 — api 一元
api（FastAPI）が App 秘密鍵を保持し、installation token を発行、repo を取得して
既存 `ContextIndexer` パイプライン（PII マスク/観測性経由）で ES に索引する。agent は
GitHub に触れず、セッションの紐づけ repo（`SessionMeta`）を読んで要約をシードし、深掘り中は
`search_grounding` で ES を引くだけにする。秘密鍵を 1 か所（api）に集約できる。

### セッションモデル
`SessionMeta` に `github_repo`（owner/name）/ `github_branch` / `github_commit_sha` /
`github_index_status` を追加する。agent はこれを読んで要約をシードし、web は状態表示に使う。

### 連携解除（unlink）
設定画面から解除でき、`users/{sub}` の installation 記録のみ削除する。共有
(repo, branch, sha) 索引は他 installation が参照し得るため**消さず**、クエリ時の
アクセス制御で遮断する。進行中セッションのシード済み要約は残るが再同期は不可になる。

### 既存 env コネクタとの関係
ADR-0007 の env 単一 `GitHubConnector` とは**併存・新規優先**。セッションに紐づけ repo が
あればそちらを使い、無ければ従来のグローバル既定にフォールバックする。

## リスクと緩和
- 大 repo での索引長期化/コスト → 関連度優先 + 総量キャップ + 非同期 + (repo,branch,sha)
  共有再利用。
- コード中の生シークレット索引 → 索引前の秘匿スキャン + レダクト、`.env`/lock/binary 除外。
- SSE × Cloud Run のタイムアウト → `Last-Event-ID` で再接続/再開できる設計。
- 共有索引の越境参照 → クエリ時に installation 保有を検証。
- トークン漏洩 → 生トークン非保存・都度短命発行・read-only 権限。

## 影響
- `packages/sanba_shared`: `GitHubLink` モデル + `SessionMeta` 拡張 + `SessionRepository`
  に users 連携 API を追加。
- `apps/api`: `github_app.py`（App JWT・state 署名・repo 取得・秘匿レダクト・関連度
  優先選別・要約組み立て）と連携/一覧/選択/進捗/再同期/解除の各エンドポイント、SSE。
- `apps/agent`: セッション開始時に repo 要約をシード（既存 retrieval を参照）。
- `apps/web`: 設定画面の連携/解除 UI、準備画面の repo+branch 選択と索引進捗表示。
- インフラ: GitHub App ID / 秘密鍵 / slug を Secret Manager + 環境変数に追加。

## 実装方針（段階導入）
本機能は複数レイヤにまたがるため段階導入する。第 1 段（本 PR）はセキュリティ中核となる
**バックエンド基盤**（モデル/永続化/App 認証/秘匿レダクト/総量キャップの純ロジックと単体
テスト）を確定させる。API エンドポイント・SSE・agent シード・web UI の配線を後続段で
積み上げる（PoC で止めず、各段を production-ready で出す）。
