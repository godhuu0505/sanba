# ADR-0040: アプリ slug によるアプリ従属 URL と複合アクセスエラー表示

- ステータス: Accepted
- 日付: 2026-07-06
- 関連: [ADR-0039](0039-home-app-selection-gate.md)（ホームのアプリ選択ゲート — 本 ADR が
  URL 構造を拡張）/ [ADR-0031](0031-product-entity-and-invite-links.md)（product エンティティ —
  決定5(b)「アプリ名のグローバル一意性や推測可能な URL を避ける」を本 ADR が一部改訂）/
  [ADR-0036](0036-product-members-and-invitations.md)（メンバーシップ・存在秘匿）/
  [ADR-0017](0017-figma-canonical-onepath-archaic-copy.md)（一本道の入口フロー）

## コンテキスト

壁打ち（要件サンバ）は常に「どのアプリの要件か」が起点になった（ADR-0039）が、URL は
`/prepare` のままアプリ非従属で、会話中に至っては固有 URL が無かった。ユーザー要望
（2026-07）として、

1. アプリ管理でグローバル一意の **slug キーワード**を登録し、
2. セッション準備は `/{slug}/prepare`、会話中は `/{slug}/sessions/{id}` という
   **アプリ従属 URL** にし、
3. 対象アプリの権限がないユーザーには**権限エラーの画面**を表示する

ことが求められた。ADR-0031 決定5(b) は「アプリ名のグローバル一意性・推測可能な URL」を
テナント 1 つ前提の作りとして避けていたが、これは**未認証で消費される深掘りリンク**の
文脈だった。slug URL は認証・認可（owner / member / admin）の内側にあり、開いても
メンバーでなければ中身に到達できないため、列挙リスクの性質が異なる。

## 決定

1. **`Product.slug` を新設する（グローバル一意）**。形式は小文字英数とハイフン・2〜40 文字
   （先頭末尾は英数）。web の既存ルート（`products` / `prepare` / `sessions` / `results` /
   `login` / `api` 等）は予約語として取れない。新規登録では必須、既存アプリは未設定
   （None）のまま残り、**設定するまで壁打ちを開始できない**（アプリ管理の設定導線を案内）。
   一意性の担保はリポジトリ層: Firestore は `product_slugs/{slug}` レジストリ文書の
   存在チェック・作成・旧 slug の解放を同一トランザクションで行い、in-memory はロックで
   直列化する。API は形式・予約語違反を 400、使用済みを 409 に写像する。slug は owner /
   admin が変更できる（変更すると URL も変わる。旧 URL の転送は持たない）。
2. **URL をアプリ従属に再編する。**
   - 準備: `/{slug}/prepare`（旧 `/prepare` は `/` へリダイレクトし、ADR-0039 の
     ホーム選択ゲートに合流）
   - 会話中: `/{slug}/sessions/{session_id}`。開始成功時に History API で積む
     （remount しない一本道 / ADR-0017 の維持）。リロード・直アクセスは会話へ再入場
     できない（join トークンは入口フロー内で消費済み）ため、slug の権限確認のうえ
     `/results/{id}` へ送る。
   - 過去の要件閲覧: `/results/{id}`（旧 `/sessions/{id}` から移設・リダイレクトで互換維持）。
     「sessions = 会話中」「results = 成果物」の名前空間に分離する。
3. **権限エラーは複合メッセージで表示する。**
   slug が本人のアプリ一覧（owner / member）に解決できないとき、web は
   「**指定された URL が存在しないか、アクセスする権限がありません**」の画面
   （`AccessErrorScreen`）を出す。「不存在」と「権限なし」を意図的に区別しない:
   API の存在秘匿（非関係者は 404 に平す / ADR-0036）と整合し、応答差で slug の実在を
   漏らさない。判定はクライアントで `GET /api/products/mine` に slug が含まれるかで行い、
   新しい認可経路（by-slug エンドポイント等）を増やさない（認可の源泉は既存の
   `_require_product_access` のまま）。
4. **ADR-0031 決定5(b) の一部改訂**: アプリ slug に限りグローバル一意な人間可読 URL を
   認める（登録時の重複エラーで slug の使用有無は推測可能になる）。深掘りリンク・
   メンバー招待のランダム ID ＋署名は不変。将来テナントを導入する場合、slug の一意性
   スコープをテナント単位へ変える（`product_slugs` レジストリの キー構造の変更で足りる）。

## 却下した代替案

- **product_id をそのまま URL に使う**（/prod-xxxx/prepare）: 推測不能だが人間可読でなく、
  「アプリの URL を配る・口頭で伝える」という slug の動機を満たさない。
- **権限なしを 403 として明示する**: アプリの存在が第三者に確定的に分かる。存在秘匿
  （ADR-0036）を崩す利得がない（ユーザーへの案内は複合メッセージで足りる）。
- **未設定アプリへの slug 自動生成**: 意図しない名前が URL として公開され、後から変える
  動機（＝リンク切れ）を量産する。owner の明示設定に寄せ、未設定は開始不可で促す。
- **会話中 URL のリロードで会話へ再入場**: join トークンの再発行・再接続の別設計が要る。
  需要が立ってから別 ADR（当面は /results/{id} へ送って成果物で受ける）。

## 影響 / フォローアップ

- `packages/sanba_shared`: `Product.slug`・`ProductSlugTaken`・`get_product_by_slug`・
  slug レジストリのトランザクション（作成/変更/削除のカスケード）。
- `apps/api`: `_clean_slug`（形式・予約語）・POST 必須/PATCH 変更・409。応答に slug。
- `apps/web`: アプリ管理（登録フォーム必須・詳細で編集）、`/[slug]/prepare`・
  `/[slug]/sessions/[id]`・`/results/[id]` ルート、`AccessErrorScreen`、EntryFlow の
  URL 同期（pushState/popstate/authGate next）。旧 `/prepare`・`/sessions/{id}` は
  リダイレクト。
- 観測性: `product_created` ログに slug を追加。複合エラー・巻き戻しは既存の
  構造化ログ（#232 で配線）に乗せる。
- 予約語リスト（`_RESERVED_SLUGS`）は web のトップレベルルートを増やしたら更新する
  （怠ると新ルートと同名の slug が先取りされ、ルートが到達不能になる）。web 側の
  複製（`apps/web/lib/slug.ts` — 送信前のその場指摘用）も同時に更新する。
- **Firestore 実クライアント経路の結合テストが未整備**（レビュー指摘）: slug の
  トランザクション（作成・変更・削除）は in-memory 経路の単体テスト＋コード読解での
  確認に留まる。リポジトリ全体で Firestore 実経路のテストが無い既存ギャップであり、
  Firestore エミュレータを使った結合テストの導入を別 PR で行う（CLAUDE.md テスト方針
  「結合: API ↔ Firestore」）。
- **会話中 URL の戻る/進むの実ブラウザ検証**（レビュー指摘）: History API 直書きと
  App Router の popstate 共存は `/prepare`（ADR-0017）で実績のある方式だが、
  `/{slug}/sessions/{id}` は直アクセス時に副作用（/results への転送）を持つルートが
  同居するため、「会話中に戻る/進むを押す」シナリオを Playwright E2E に追加する。
