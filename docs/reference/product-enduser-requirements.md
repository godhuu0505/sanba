# 要件定義 — アプリ実体・深掘りリンク・利用者モード

> 状態: **Draft**。由来: [personas-and-use-cases.md](../explanation/personas-and-use-cases.md)（ユースケース分解）。
> 実装の切り方は [product-enduser-implementation-plan.md](../notes/product-enduser-implementation-plan.md) を参照。
> 本書の FR/NFR 番号を ADR・Issue・PR から参照する。

## 1. 目的

アプリの**利用者**（GitHub リポジトリを知らず、アプリ名しか知らない人）から要件・困りごとを
引き出せるようにする。そのために、開発者 / PdM が「アプリ登録 → 前提情報の紐づけ →
深掘りリンクの発行」を準備し、利用者は **URL を開くだけ**でセッションを開始できるようにする。
利用者の声と技術的前提は、開発者の技術深掘りセッション（UC-D1）で合流する。

## 2. 決定事項と前提

[personas-and-use-cases.md §7](../explanation/personas-and-use-cases.md#7-adr-に切り出すべき決定) の論点に対する本要件の前提。
ADR 未起票のものは実装計画の Step 0 で起票する。

| 論点 | 本要件での前提 |
|---|---|
| product エンティティ | **導入する**。セッションは `product_id` で従属。repo 解決は「セッション明示 > product > 環境変数」の優先順 |
| ユーザー管理 | **最小限**。product に `owner_sub`。役割は product owner ＋ 既存 admin（`ADMIN_EMAILS`）の 2 値。ユーザー管理画面・招待フロー・ロールモデルは作らない |
| 利用者のアカウント | **作らない**。ゲスト入場（出所メタ＋TTL）。利用者をユーザー化しない |
| org / テナント管理 | **作らない**（デプロイ単位＝1 チーム）。ただし認可判定の API 一点集約・「テナント 1 つ」前提の作りの回避（名前一意性・連番 URL 禁止）で将来の挿入余地を担保 |
| 生成プレビュー（画面イメージ生成） | **本要件のスコープ外**。Stage 3 着手前に別 ADR で採否を決める |

## 3. 機能要件

受け入れ基準（AC）は「これを満たせば PR をマージできる」検証可能な条件として書く。

### Stage 1 — アプリ実体と深掘りリンク

| ID | 要件 | 受け入れ基準（AC） |
|---|---|---|
| FR-1.1 | **アプリ登録**: ログイン済みユーザーが name / description を登録し `products/{id}` を作成できる。`owner_sub` は作成者 | 作成後 `GET /api/products/mine` に現れる。name 空は 400 |
| FR-1.2 | **アプリの閲覧・更新**: owner と admin のみ更新できる。閲覧は owner / admin | 非所有・不存在の GET/PATCH/DELETE はどちらも **404 に平す**（応答差で他人の product ID の存在を漏らさない。`/api/sessions/mine/{id}` と同方針）。`/github` の owner-only のみ 403。認可判定は API の単一ヘルパー経由（web 側判定は表示制御のみ） |
| FR-1.3 | **repo 紐づけの product 持ち上げ**: product に GitHub repo / branch / 索引状態（ADR-0027/0028 と同じ形）を持たせ、既存の (repo, branch, sha) 索引・GitHub App 経路を再利用する | product に repo を紐づけると既存 `repo_indexing` パイプラインで索引される。同一 (repo, branch, sha) は再索引しない |
| FR-1.4 | **セッションの product 従属**: `SessionMeta.product_id` を追加。product 経由で作られたセッションは repo 設定を product から継承する（セッション個別指定・環境変数フォールバックは互換維持） | product 従属セッションで 02 準備の repo 初期値が product の設定になる。`product_id` の無い旧セッションは従来どおり動く |
| FR-1.5 | **深掘りリンクの発行**: owner が product に対しリンクを発行できる。リンクは HMAC 署名付き・`expires_at` / `max_uses` / `revoked` を持ち、一覧・失効ができる | 期限切れ・失効・回数超過のリンクは開けない（明確なエラー画面）。URL は推測不可（ランダム ID、連番禁止） |
| FR-1.6 | **リンクからのセッション開始**（Stage 1 はログイン済みユーザーのみ）: リンクを開く → 検証 → `product_id` 従属セッションを自動作成 → join token を得てそのまま会話開始。02 準備の入力は不要 | リンクから会話開始まで、準備画面の操作なしで到達できる。`max_uses` の消費は同時アクセスでも上限を超えない |
| FR-1.7 | **観測性**: `product_created` / `invite_created` / `invite_redeemed` / `invite_revoked` を構造化ログ＋トレースで記録。`session_created` に `product_id` を含める | ローカル（Tempo）でトレースが確認できる |

### Stage 2 — 利用者モード

| ID | 要件 | 受け入れ基準（AC） |
|---|---|---|
| FR-2.1 | **ゲスト入場**: `scope=end_user` のリンクは Google ログインなしで開ける。ゲストの participant identity（`guest:{random}`）を発番し、発話・要件の出所メタに残す。セッションの `owner_sub` は **product owner**（閲覧・管理権限のため） | ログインなしで会話開始まで到達できる。発話・確定要件にゲスト identity が残る |
| FR-2.2 | **同意ゲート**: ゲストにも録音・AI 処理の同意（既存 `consent_acknowledged`）を必須で提示する。文言は利用者向け（技術用語なし） | 同意なしでルームに入れない |
| FR-2.3 | **インタビュー・モード**: `SessionMeta.interview_mode: "developer" \| "end_user"`（既定 developer）。リンクの scope から決まり、agent がプロンプトを分岐する | end_user セッションで agent の質問が「いつ・どの画面で・何をしようとして・何に困ったか」軸になる |
| FR-2.4 | **利用者向け語彙**: product に glossary（画面名・機能の呼び名）を登録でき、end_user モードのプロンプトにシードされる。技術用語（API・DB・非機能・MoSCoW 等）を利用者に見せない | glossary の語が質問に使われる。MoSCoW 等の内部分類は UI・発話に露出しない |
| FR-2.5 | **grounding 出力制御**: end_user モードでは repo 由来の grounding を「質問計画の背景」に限定し、応答・引用として内部情報（コード片・未公開機能）を露出しない | end_user セッションの応答・引用イベントに repo 由来 passage が含まれない（結合テストで検証） |
| FR-2.6 | **abuse 対策**: リンク単位・IP 単位のセッション作成レート制限。`max_uses` 消費は Firestore トランザクションでアトミック | 制限超過は 429。既定値は設定で変更可能 |
| FR-2.7 | **ゲストデータの保持**: ゲストセッションにも既存 30 日 TTL を適用し、利用者向けに保持期間を同意文言で明示する | TTL フィールドが設定される。同意画面に保持期間の記載がある |
| FR-2.8 | **プロンプト回帰**: end_user モードの Langfuse 評価データセット（技術用語を使わない・一問一答維持・画面語彙の使用）を追加し CI 回帰に載せる | 評価データセットが存在し、しきい値割れで CI が落ちる |

### Stage 3 — 成果物と集約

| ID | 要件 | 受け入れ基準（AC） |
|---|---|---|
| FR-3.1 | **利用者向け結果確認**: セッション終端で「あなたの声はこう整理されました」を**ユースケース記述**（いつ・どの画面で・困りごと・望む結果）中心に返し、訂正・承認の機会を与える。要件リスト（MoSCoW ボード）は見せない | end_user セッションの結果画面にユースケース記述が出る。訂正が発話として記録される |
| FR-3.2 | **横断集約ビュー**: owner / admin が product 配下のセッションを横断し、困りごとのテーマ・頻度を見られる | product 詳細から配下セッション一覧と集約が見られる。他人の product は見えない |
| FR-3.3 | **技術深掘りへの接続（UC-D1）**: developer モードのセッション開始時、同じ product の利用者セッション（要件・発話）が grounding として呼び戻される | developer セッションで「利用者の声」由来の引用つき問いが出る（既存の過去セッション呼び戻しの product スコープ版） |

## 4. 非機能要件

| ID | 要件 |
|---|---|
| NFR-1 | **セキュリティ**: リンクは既存 HMAC 署名基盤（`apps/api/src/sanba_api/auth.py`）と同水準の署名・期限・検証。ゲスト join token の権限は当該セッションの読取＋既存 write 系（`user.selection` 等）のみ。PII マスク（`mask_pii_before_index`）は全経路で維持 |
| NFR-2 | **情報漏洩の遮断**: private repo 由来の索引内容は end_user モードの出力に露出しない（FR-2.5）。`GITHUB_REPO_ALLOWLIST`（ADR-0027）は product の repo 紐づけにも一貫適用 |
| NFR-3 | **観測性**: 新規処理はすべて OTel トレース＋構造化ログを通す。LLM 入出力（end_user プロンプト含む）は Langfuse へ（CLAUDE.md 原則 3） |
| NFR-4 | **ステートレス維持**: invite の消費カウント等の状態は Firestore に置き、Cloud Run のワーカーはステートレスのまま |
| NFR-5 | **互換性**: `product_id` を持たない既存セッション・既存 02 準備フロー・env 単一コネクタ（ADR-0007）は挙動を変えない |
| NFR-6 | **将来の org 挿入余地**: 認可判定（sub → product）を API の単一モジュールに集約。product ID・リンク ID はランダムで、名前のグローバル一意性を仮定しない |

## 5. データモデル変更

```
products/{productId}                # 新設
  ├─ name, description, owner_sub, created_at
  ├─ glossary: string[]             # Stage 2（利用者向け語彙）
  ├─ github_repo / github_branch / github_commit_sha / github_index_status / github_summary
  │                                 # ADR-0027/0028 の形を product に持ち上げ
  └─ invites/{inviteId}             # 新設（深掘りリンク）
       ├─ scope: "developer" | "end_user"
       ├─ expires_at, max_uses, use_count, revoked, created_at

sessions/{sessionId}                # 既存に追加
  ├─ product_id: str | None        # 新規（None = 従来どおり）
  └─ interview_mode: "developer" | "end_user" = "developer"   # Stage 2
```

モデルの正本は `packages/sanba_shared/src/sanba_shared/models.py` に置き、
`SessionRepository`（同 `repository.py`）に products / invites の永続化 API を足す。

## 6. API 変更（apps/api）

| メソッド / パス | 認可 | 目的 |
|---|---|---|
| `POST /api/products` | ログイン | FR-1.1 アプリ登録 |
| `GET /api/products/mine` | ログイン | FR-1.1 自分のアプリ一覧 |
| `GET /api/products/{id}` / `PATCH` / `DELETE` | owner / admin | FR-1.2 |
| `POST /api/products/{id}/github` | owner | FR-1.3 repo 紐づけ＋索引キック（既存 `POST /api/sessions/{id}/github` と同型） |
| `POST /api/products/{id}/invites` | owner | FR-1.5 リンク発行 |
| `GET /api/products/{id}/invites` / `POST …/invites/{iid}/revoke` | owner | FR-1.5 一覧・失効 |
| `POST /api/products/join` | 署名リンク（Stage 1 は＋ログイン、Stage 2 で `scope=end_user` はゲスト可） | FR-1.6 / FR-2.1 リンク検証→セッション自動作成→join token |
| `GET /api/products/{id}/sessions` | owner / admin | FR-3.2 横断一覧 |

既存 `POST /api/sessions/join`（セッション単位 invite）はそのまま残す。

## 7. 画面（apps/web）

| ルート | 対象 | 内容 |
|---|---|---|
| `/products` | 開発者 | 自分のアプリ一覧・新規登録（FR-1.1） |
| `/products/[id]` | 開発者 | 詳細・repo 紐づけ・glossary 編集・リンク発行/失効（FR-1.2/1.3/1.5）。Stage 3 で配下セッション集約（FR-3.2） |
| `/join/[token]` | 利用者 / 開発者 | リンク入場。検証 → （Stage 2: 同意ゲート）→ セッション自動作成 → 会話へ（FR-1.6/2.1/2.2）。失効・期限切れの明確なエラー表示 |
| `/sessions/[id]`（既存） | 両方 | end_user モードでは検知カード等の文言を利用者向けに切替（FR-2.3/2.4）、結果画面を FR-3.1 に差し替え |

## 8. スコープ外（やらないこと）

- org / テナント管理、ユーザー管理画面、ロールモデル（§2 の前提）
- 利用者のアカウント作成・利用者の履歴閲覧
- リンクの配布手段（メール送信・アプリ内バナー等は SANBA の外）
- repo 索引の webhook 自動追従（ADR-0028 のスコープ外を踏襲・手動再同期のみ）
- 画面イメージの生成（生成プレビュー）— 別 ADR で採否決定後に要件化
- 多人数（N 人）での利用者セッション — 既存ロードマップ Phase 2 の話者識別に合流させる
