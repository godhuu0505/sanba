# ADR-0031: product エンティティ・所有・深掘りリンク

- ステータス: Accepted（受理・2026-07-05 確定）
- 日付: 2026-07-05
- 関連: [ADR-0008](0008-product-concept.md)（プロダクトコンセプト — 本 ADR が対象ペルソナを拡張）/
  [ADR-0027](0027-per-session-github-repo.md)（セッション単位 repo 選択 — repo 解決を product へ持ち上げ）/
  [ADR-0028](0028-github-repo-linking.md)（GitHub App・ES 索引 — 索引経路を再利用）/
  [ADR-0014](0014-admin-and-login-screens.md)（admin 認可）
- 背景文書: [personas-and-use-cases.md](../design/personas-and-use-cases.md) /
  [要件定義](../design/product-enduser-requirements.md) / [実装計画](../design/product-enduser-implementation-plan.md)

## コンテキスト

「アプリの利用者」（リポジトリを知らず、アプリ名しか知らない人）から要件を引き出すには、
**準備する人（開発者 / PdM）と話す人（利用者）の分離**が必要になる（personas-and-use-cases.md §1）。
現状は「セッションを作る本人がインタビューされる」前提で、repo 選択（ADR-0027）も
ログイン（ADR-0012）もセッション単位・本人操作に紐づいており、
「開発者が準備したものを、URL を開くだけの相手が消費する」経路が無い。

また、深掘りの対象となる「アプリ」という実体が無いため、repo 紐づけ・索引・成果の蓄積が
セッションごとに使い捨てになっている。

## 決定

1. **`products/{id}` を新設**する。name / description / owner_sub / glossary（利用者向け語彙、
   ADR-0032 で使用）/ github_repo・branch・commit_sha・index_status・summary
   （ADR-0027/0028 の SessionMeta の形をそのまま持ち上げ）を持つ。
2. **セッションは `SessionMeta.product_id` で product に従属**できる（`None` = 従来どおり）。
   repo 解決の優先順は **セッション明示 > product > 環境変数**。ADR-0027 の
   空文字（明示的な非連携）・`GITHUB_REPO_ALLOWLIST`・ADR-0028 の (repo, branch, sha)
   共有索引と索引パイプラインは product 経路にも一貫適用する。
3. **深掘りリンク（product invite）を新設**する。owner が発行する再利用可能な署名付き URL で、
   `products/{id}/invites/{inviteId}` に `scope`（developer / end_user）・`expires_at`・
   `max_uses`・`use_count`・`revoked` を持つ。トークンは既存 HMAC 署名基盤（`auth.py`）の
   パターンで signed、**invite_id はランダム**（連番・名前ベース URL は不可）。
   リンクを開くと検証（署名・期限・失効・回数のトランザクション消費）→ product 従属
   セッションの自動作成 → 既存 join token 発行、で 02 準備の操作なしに会話まで到達する。
   本 ADR の範囲では**ログイン必須のまま**（ゲスト入場＝`scope=end_user` の解禁は ADR-0032）。
4. **ユーザー管理は最小限**とする。権限は product owner（`owner_sub`）と既存 admin
   （`ADMIN_EMAILS`, ADR-0014）の 2 値のみ。ユーザー管理画面・招待フロー・ロールモデルは
   作らない。**利用者はユーザー化しない**（ゲストは出所メタ＋TTL のまま）。
5. **オーガニゼーション（テナント）管理は導入しない**。デプロイ単位＝1 チームを既定とする
   （ADR-0027 の allowlist と同じ前提）。ただし将来挿せるよう、
   (a) 認可判定（sub → product）を API の単一ヘルパーに集約する、
   (b) アプリ名のグローバル一意性や推測可能な URL など「テナント 1 つ」前提の作りを避ける
   — の 2 点を実装で担保する。

## 却下した代替案

- **セッション単位 invite（既存 `POST /api/sessions/join`）の流用のみ**: 配布のたびに
  セッションを先に作って個別リンクを発行する必要があり、「準備を一度して URL を配る」
  運用にならない。既存 invite は残し、product invite を追加する。
- **org / テナントを最初から導入**: 変更コストが最も高い層を、利用者ペルソナという
  未検証の仮説の上に建てることになる。単一チーム前提＋インスタンス分離で当面は足り、
  需要が立ってから別 ADR で扱う。
- **ロールモデル・ユーザー招待フローの導入**: 管理したい対象は当面 product の所有だけで、
  owner / admin の 2 値で表現できる。editors[] 等の共同編集は需要が出てから追加する。
- **リンクを短い slug（アプリ名ベース等）にする**: 列挙・推測リスクがあり、
  名前の一意性というテナント 1 つ前提も持ち込む。ランダム ID ＋署名にする。

## 影響 / フォローアップ

- `packages/sanba_shared`: `Product` / `ProductInvite` モデルと `SessionMeta.product_id`、
  `SessionRepository` の products / invites API（`use_count` はトランザクション増分）。
- `apps/api`: `products.py`（CRUD・認可ヘルパー・invite 発行/失効/join）。repo 紐づけは
  既存 `repo_indexing` を再利用。
- `apps/web`: `/products`（管理）・`/join/[token]`（入場）。
- 観測性: `product_created` / `invite_created` / `invite_redeemed` / `invite_revoked` の
  構造化ログ＋トレース。`session_created` に `product_id` を含める（CLAUDE.md 原則 3）。
- インフラ: 新しい GCP リソースは不要（Firestore コレクション追加のみ）。invites の
  TTL / 保持は Firestore TTL 設定の対象に含めるか実装時に確認する。
- ADR-0008 との整合: 利用者ペルソナは MVP コンセプトの置き換えではなく
  「PdM が現場の声を集める道具」としての拡張と位置づけ、README / roadmap の記述を
  本 ADR の Accepted 時に改訂する。
- 後続: ゲスト入場・interview_mode は [ADR-0032](0032-guest-join-and-enduser-mode.md)、
  利用者向け成果物（生成プレビュー採否）は Stage 3 着手前に別 ADR として起票する
  （番号は起票時に採番。当初 0033 を予定していたが UI デザイン刷新 v2 に採番済み）。
