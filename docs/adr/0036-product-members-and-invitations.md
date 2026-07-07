# ADR-0036: product メンバー管理・ユーザー招待・招待通知

- ステータス: Accepted（受理・2026-07-05 確定）
- 日付: 2026-07-05
- 関連: [ADR-0031](0031-product-entity-and-invite-links.md)（product エンティティ — 本 ADR が
  決定4「ユーザー管理は最小限」を部分的に改訂）/
  [ADR-0032](0032-guest-join-and-enduser-mode.md)（ゲスト入場 — 深掘りリンクは本 ADR の
  影響を受けず併存）/ [ADR-0012](0012-google-login.md)（Google ログイン — 招待の宛先照合に
  検証済み email を使う）/ [ADR-0014](0014-admin-and-login-screens.md)（admin 認可）

## コンテキスト

ADR-0031 は「管理したい対象は当面 product の所有だけ」としてユーザー管理・招待フロー・
ロールモデルの導入を見送り、「editors[] 等の共同編集は需要が出てから追加する」と留保した。
その需要が立った: アプリ（product）を設定した人が、**そのアプリで要件サンバ（product 従属
セッションでの深掘り）をできるユーザーを指定したい**。指定はメンバー本人の同意を伴う形
（招待に承諾する / 招待 URL を開く）とし、招待されたことが**メールと SANBA アプリ内の両方に
通知される**必要がある。

既存の深掘りリンク（ProductInvite）は「URL を開いた人が 1 セッションを始められる再利用可能な
入場券」であり、product の閲覧・一覧表示・継続的な実施権限（メンバーシップ）は与えられない。
入場券と会員証は別物なので、リンクの流用ではなくメンバーシップを新設する。

## 決定

1. **`product_members/{product_id}__{sub}` を新設**し、「その product で要件サンバができる人」
   を表す。メンバーは product の閲覧・自分の一覧（`/api/products/mine`、`role=member`）・
   product 従属セッションの作成ができる。管理操作（編集・削除・repo 紐づけ・リンク/招待の
   発行）は従来どおり owner / admin のみ。認可は引き続き `_require_product_access` の
   一点集約とし、`manage` フラグで 2 段の権限を判定する（非関係者は 404 に平す存在秘匿を
   維持。メンバーの manage 要求のみ 403）。ロール列挙（editor 等）は導入しない — owner /
   member（+ 既存 admin）の 2 値で足り、細分は需要が出てから別 ADR で扱う。
   owner は `Product.owner_sub` が単一の正のままで、members には入れない。
   トップレベルコレクションにするのは sub → 所属 product の横断クエリのため
   （サブコレクションは collection group index の運用が要る）。
2. **メンバー招待 `member_invites/{id}` を新設**する。メールアドレス宛・1 回限り・既定 14 日
   期限（`MEMBER_INVITE_TTL_SECONDS`）。状態は pending → accepted / declined / revoked
   （期限切れは `expires_at` からの導出）。承諾経路は 2 つで同じ検証に合流する:
   (a) アプリ内通知から invite id で応答、(b) 招待メールの URL
   `/member-invites/{token}` から応答。トークンは既存 HMAC 基盤（`auth.py`）の新スコープ
   `member_invite` で署名し、深掘りリンクと同じ**二段検証**（署名 = owner 発行の証明、
   状態の正は Firestore 文書）。加えて**宛先 email と検証済み identity の email 照合を必須**に
   する — メンバーシップは永続権限であり、URL の転送だけで第三者が承諾できてはならない
   （深掘りリンクとの本質的な差）。承諾の状態遷移とメンバー作成は同一トランザクション
   （in-memory はロック）で行い、二重承諾・取り消しとの競合で二重付与しない。
3. **通知は 2 経路**。(a) 招待メール: SANBA 初のメール送信基盤として `mailer.py`（標準
   ライブラリ smtplib / STARTTLS / 設定は env + Secret Manager）を追加し、FastAPI
   BackgroundTasks で応答をブロックせず送る。`SMTP_HOST` 未設定はスキップ（フェイル
   オープン: アプリ内通知が常に届くため招待は成立する。skipped はメトリクスで観測）。
   (b) アプリ内通知: `GET /api/member-invites/mine`（検証済み email で照合した保留中招待）を
   ホームと `/products` の上部に表示し、その場で承諾/辞退できる。プッシュ/ポーリング等の
   通知基盤は導入しない（ログイン時に見えれば足りる）。
4. **メンバーの離脱と削除**: owner / admin は任意のメンバーを外せる。メンバーは自分で
   離脱できる。外しても過去のセッション・要件は消さない（出所メタであり権限の器ではない）。
   product 削除はメンバー・招待もカスケード削除する（深掘りリンクと同方針）。
5. **オーガニゼーション（テナント）は引き続き導入しない**（ADR-0031 決定5 の維持）。
   認可判定は `_require_product_access` に集約したまま、将来 sub → org → product に
   差し替えられる形を保つ。

## 却下した代替案

- **深掘りリンク（ProductInvite）の scope 追加で代用**: リンクは匿名にも配れる再利用可能な
  入場券で、「誰がメンバーか」を表せない。一覧表示・継続権限・取り消し（個人単位）が
  成立しないため、別エンティティにする。
- **宛先 email 照合なしの招待 URL（開いた人がそのまま承諾）**: 招待は永続権限の付与であり、
  URL 転送による横流れを許すと owner の指定（本 ADR の目的）が成立しない。照合を必須にし、
  別アカウントで開いた場合は伏せ字の宛先を出して誘導する。
- **ロールモデル（editor / viewer 等）の導入**: 今回必要なのは「要件サンバができる」の
  1 権限のみ。owner / member の 2 値で表現できる。細分は需要が出てから別 ADR。
- **SendGrid 等プロバイダ SDK の導入**: 依存を増やさず SMTP（STARTTLS）で開始する。主要
  プロバイダは SMTP 互換エンドポイントを持つため設定だけで移行できる。専用 SDK/Webhook
  （バウンス処理等）は必要になってから。
- **users コレクションへのプロフィール登録（事前のユーザー登録制）**: SANBA はユーザー
  ディレクトリを持たない（identity は Google ID トークンの検証結果のみ / ADR-0012）。
  招待を email 宛にすることで、未ログインの相手も招待できる。

## 影響 / フォローアップ

- `packages/sanba_shared`: `ProductMember` / `ProductMemberInvite` / `MemberInviteStatus`
  モデル、`SessionRepository` の members / member_invites API（応答はトランザクション）、
  `delete_product` のカスケード拡張。
- `apps/api`: `_require_product_access(manage=)` への拡張、members / member-invites
  エンドポイント群、`mailer.py`、`auth.py` の `member_invite` トークン、設定
  （`MEMBER_INVITE_TTL_SECONDS` / `WEB_BASE_URL` / `SMTP_*`）。
- `apps/web`: `ProductMembersCard`（招待・一覧・削除）、`MemberInviteNotices`
  （ホーム・`/products` のアプリ内通知）、`/member-invites/[token]`（承諾ページ）、
  詳細画面の role 出し分け（member は閲覧のみ）。
- 観測性: `sanba_product_member_events_total`
  （invite_created/accepted/declined/revoked/member_removed）と
  `sanba_member_invite_emails_total`（sent/failed/skipped）の構造化ログ＋カウンタ。
- インフラ: 新しい GCP リソースは不要（Firestore コレクション追加のみ）。本番でメールを
  送るには別 PR で (a) SMTP 資格情報を Secret Manager に登録し Cloud Run へ注入、
  (b) **`WEB_BASE_URL` を Terraform の api env に配線**する（未配線のまま SMTP を有効化
  すると招待メールの URL が既定値 localhost になる）。未設定でもアプリ内通知で機能は
  成立する。member_invites は期限切れ後も履歴として残す（TTL 付与は保留。増加が問題に
  なったら Firestore TTL の対象に加える）。
- 乱用ガード: 任意メール宛の送信になるため、product あたりの保留中招待数を
  `MEMBER_INVITE_MAX_PENDING_PER_PRODUCT`（既定 50）で 429 に制限する。SMTP を本番で
  有効化する際は、必要に応じて owner 単位の発行レート制限（深掘りリンクの
  `invite_join_rate_per_minute` と同型）の追加を検討する。
- ADR-0031 との整合: 決定4 の「ユーザー管理画面・招待フロー・ロールモデルは作らない」の
  うち**招待フローとメンバー管理を解禁**する（需要が立ったため）。ロールモデルの不在と
  「利用者はユーザー化しない」（ゲストは出所メタ＋TTL のまま）は維持する。
