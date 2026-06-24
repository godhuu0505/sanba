# ADR-0012: Google ログイン（OAuth / OpenID Connect）の導入

- ステータス: Accepted
- 日付: 2026-06-19
- 関連: ADR-0006（Cloud Run + LiveKit）、issue #8（招待トークン）、issue #10（同意/データガバナンス）

## コンテキスト
SANBA の現状の参加制御は **HMAC 署名付きの「セッション招待トークン」**（`apps/api/.../auth.py`、
issue #8）だけで成り立っている。これは「どのルームに・どの role で入れるか」を縛る**認可
(authorization)** の仕組みであり、「誰が話しているか」という**本人確認 (identity / authentication)**
は一切持たない。招待リンクを所持していれば誰でも匿名で参加でき、確定要件に残す出所メタ
（ADR-0008 の participant identity）も自己申告の名前に過ぎない。

本 ADR では「Google アカウントでログイン」を導入し、**検証済み identity をセッション参加
（LiveKit トークン発行）に結びつける**ための方式を確定する。

論点は 3 つ:
1. **方式**: ID トークンの取得と検証をどこで行うか。
2. **既存 HMAC 招待との関係**: ログインを必須にするのか、誰に必須にするのか。
3. **認可スコープ**: 誰がルームを作れるか / guest の扱い。

## 決定

### 1. 方式 — (B) Google Identity Services + FastAPI サーバ検証
ブラウザ（Next.js）が **Google Identity Services (GIS)** で ID トークン（OIDC の `credential`）を取得し、
それを `Authorization: Bearer <id_token>` で FastAPI に送る。**FastAPI が `google-auth`
(`google.auth.jwt` / `google.oauth2.id_token`) でサーバ側検証**する（署名・`aud`(client_id)・
`iss`・`exp`・`email_verified`）。検証済み identity を `POST /api/sessions` と
`POST /api/sessions/join` の依存性に結びつける。

| 観点 | 採用 (B) GIS + FastAPI 検証 | 却下 (A) Auth.js(NextAuth) |
|---|---|---|
| スタック適合 | Next.js は薄いクライアント、**identity の信頼境界は FastAPI に一本化**。既存の招待→LiveKit 発行と同じ場所で検証できる | NextAuth は Next 内に**第 2 のセッション機構**（Cookie/JWT）を持つ。別プロセスの FastAPI へ ID トークンを渡すには callback で無理に露出させる必要があり信頼境界が二重化する |
| シークレット | **client secret 不要**（ID トークン検証は client_id=`aud` のみ）。秘匿物が増えない | `AUTH_SECRET` + Google client secret を Next 側で管理（秘匿物が増える） |
| 検証の所在 | サーバ（FastAPI）。クライアント任せにしない（セキュリティ必須事項に直結） | 検証は NextAuth 内。FastAPI から見ると外部の主張を信頼する形になりやすい |
| 依存追加 | `google-auth`（既に firestore/genai の推移依存で導入済み）を明示宣言するのみ | `next-auth` を新規追加 |
| ローカル開発 | `AUTH_DEV_BYPASS` で素通しでき、`just up` の挙動を壊さない | NextAuth は dev でも provider 設定が要る |

→ **Next.js + 別 FastAPI という構成では (B) が素直**。識別子の検証を 1 か所（API）に集約でき、
client secret という秘匿物も増えない。

### 2. 既存 HMAC 招待との関係 — 併存（identity は Google、認可は招待）
**招待トークンは廃止しない**。役割を明確に分離する:
- **Google ログイン** = 「誰か」(authentication)。検証済み `sub` / `email` を participant に束ねる。
- **HMAC 招待** = 「どのルームに・どの role で」(authorization)。issue #8 のスコープ縛りを維持。

`POST /api/sessions`（owner のルーム作成）と `POST /api/sessions/join`（参加）の**両方で
ログインを必須**にする。join では招待が「ルーム/role」を、Google が「本人」を与え、
**両方が揃って初めて** LiveKit トークンを発行する。LiveKit の participant identity は
自己申告名ではなく**検証済み `sub` 由来**（`{role}-{sub前8桁}`）にし、name/metadata に
検証済み email を載せる（出所メタの信頼性が上がる = ADR-0008 と整合）。

### 3. 認可スコープ
- **ルーム作成 (owner)**: ログイン済みなら可（P1 は「信頼チーム専用」運用。許可リストは将来 issue 化）。
- **guest**: 匿名参加は廃止。guest も Google ログイン必須。招待リンクは引き続き role/room を縛る。
- **`AUTH_DEV_BYPASS=true`（ローカル限定）**: Google 検証を素通しし、固定の dev identity を返す。
  本番では必ず false（issue #8 と同じ運用）。`google_oauth_client_id` 未設定かつ bypass off の
  本番構成では、API は**フェイルクローズ**（503）し「設定漏れで無検証に開く」事故を防ぐ。

## 根拠
- ID トークン検証は**必ずサーバ側**で行うのがセキュリティ必須事項。(B) は検証を FastAPI に一本化
  でき、この原則を構造的に満たす。
- client secret を持たない（ID トークン検証は公開鍵 + `aud` のみ）ため、秘匿物の管理面が増えず
  「シークレットはコミットしない」原則の表面積を増やさない。
- 招待を残すことで issue #8 の「ルーム/role スコープ」を捨てずに、足りなかった identity だけを足す
  最小差分になる。既存テスト・デモ経路（招待→join）も壊れない。

## 影響
- **API**: `auth_google.py`（ID トークン検証 + `require_user` 依存性）を追加。`config.py` に
  `google_oauth_client_id` を追加。`create_session` / `join_session` に `require_user` を結線し、
  検証済み identity を LiveKit トークンに反映。観測性（`auth_verified` / `auth_rejected` ログ +
  OTel カウンタ）を新経路に通す。
- **Web**: GIS スクリプトをロードする `useGoogleAuth` フックとログイン UI を追加。API 呼び出しに
  Bearer トークンを付与。`NEXT_PUBLIC_GOOGLE_CLIENT_ID` 未設定時は dev モード（bypass 前提）に退避。
- **env / IaC**: `GOOGLE_OAUTH_CLIENT_ID`(api) / `NEXT_PUBLIC_GOOGLE_CLIENT_ID`(web build-arg) を
  `.env.example` / `docker-compose` / web `Dockerfile` / `deploy.yml` / `infra/terraform` に追加。
  client_id は**秘匿物ではない**ため Secret Manager ではなく平文 env として注入する（client secret は
  本方式では不要なので一切置かない）。
- **テスト**: ID トークン検証の単体テスト（正常 / 期限切れ / 改ざん / `aud` 不一致 / `iss` 不正 /
  `email_verified=false`）を、テスト内で生成した RSA 鍵で**実署名・実検証**して担保する。
  API↔認証の結合テスト（未ログイン拒否 / bypass 経路）も追加。

## 却下案
- **(A) Auth.js(NextAuth)**: 上表のとおり、別プロセス FastAPI へ identity を渡す構成では信頼境界が
  二重化し、client secret という秘匿物も増える。モノリシックな Next アプリなら有力だが本構成には過剰。
- **ログインで招待を置き換える**: identity だけでは「どのルーム/role か」を縛れず、issue #8 の
  スコープ制御を作り直すことになる。招待を残す方が最小差分かつ多層防御。
- **クライアント側のみで検証（サーバ検証なし）**: セキュリティ必須事項違反。論外。
