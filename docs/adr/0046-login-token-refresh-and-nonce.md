# ADR-0046: ログインセッションの堅牢化（ID トークンの能動リフレッシュと nonce 束縛）

- ステータス: Proposed
- 日付: 2026-07-07
- 関連: ADR-0012（Google ログイン）、ADR-0014 §7（クライアントのセッション持続とトークン失効）、ADR-0030（クロスタブログアウト）、ADR-0032（ゲスト入場）

## コンテキスト

ADR-0012 / ADR-0014 §7 で確立した現行方式は「GIS で取得した OIDC の ID トークンを
**ブラウザメモリのみ**に保持し（localStorage にも cookie にも置かない）、`Authorization:
Bearer` で FastAPI に渡してサーバ検証する」もの。分離オリジン（web / api が別 Cloud Run）
構成に素直で、XSS でのトークン持ち出し面も持たない良い設計だが、運用で次の穴がある。

1. **ID トークンの寿命（約1時間）に対しリフレッシュ機構が無い。** 現行はリロード時に GIS の
   `auto_select` で静かに再取得するだけで、**開いたまま**の長い会話の途中で失効すると、
   LiveKit 再 join や `create`/`join` が 401 で刺さる。失効を検知してから再サインインへ誘導
   する事後対応しかない。

2. **ID トークンの注入（token injection）に対する防御が薄い。** ID トークン検証は署名・
   `aud`(client_id)・`iss`・`exp`・`email_verified` を見るが、`aud` が SANBA の client_id
   でありさえすれば、**別の文脈で得た同一 client_id 宛の ID トークン**を API に投げ込めてしまう
   余地がある（OIDC が nonce を用意している理由）。

3. **誰でもルームを作れる。** ADR-0012 §3 は「P1 は信頼チーム専用運用。許可リストは将来
   issue 化」とし、ログイン済みなら誰でも `POST /api/sessions` でルームを作れる状態のまま。

論点:
1. ID トークンの寿命に対する更新方針（クライアント側の能動リフレッシュ）
2. nonce の導入方式（ステートレス構成でどう本当に効かせるか）
3. ルーム作成の認可（ADR-0012 §3 の宿題）

## 決定

### 1. ID トークンの能動リフレッシュ（exp 先読み）
`useGoogleAuth`（`apps/web/lib/auth.tsx`）に **exp 先読みリフレッシュ**を入れる。credential
到着のたびに JWT の `exp` を読み、失効の `REFRESH_SKEW_MS`（既定 5 分）前にタイマーで GIS の
`initialize` → `prompt()` を静かに呼び、新しい ID トークンを先回りで取得する。Google
セッションが生きていれば One Tap は無表示で再発行され、`onCredential` が次のリフレッシュを
貼り直す。取得できない場合は**現行動作**（失効後の API 401 → 再サインイン導線）に委ね、ここで
強制ログアウトはしない。下限 `MIN_REFRESH_DELAY_MS`（30 秒）でクロックずれ時のタイトループを
防ぐ。**ID トークンを永続化しない ADR-0014 §7 の方針は不変**（メモリ内のトークンを更新する
だけ）。

### 2. nonce は「サーバ発行の HMAC チャレンジ」で束縛する
クライアントが生成した nonce を同じリクエストで送り返すだけの方式は、トークンを盗めば nonce も
送れてしまい**ステートレス構成では無力**（CLAUDE.md「見栄えだけの実装をしない」に反する）。
そこで、SANBA が既に invite / session_token で使っている**ステートレス HMAC 署名**方式に揃える。

- `GET /api/auth/nonce`（認証不要 / ログイン前に呼ぶ）が `(nonce, envelope)` を返す。`envelope`
  は `nonce`＋`exp` を `SESSION_SIGNING_SECRET` で HMAC 署名した短命トークン（サーバに保存しない）。
- web は `nonce` を GIS の `id.initialize({nonce})` に渡す（Google が ID トークンの `nonce`
  claim に埋める）。`envelope` は `X-Auth-Nonce` ヘッダで送る。
- サーバ（`require_user_bound` / create・join のみ）は `envelope` の署名・期限を検証して raw
  nonce を再導出し、**ID トークンの `nonce` claim と一致**することを要求する。

これが効く理由: 攻撃者が別文脈で得た ID トークンを注入するには、その ID トークンの `nonce`
claim と一致する `envelope` が必要だが、envelope の raw nonce はサーバがランダム生成し
**サーバの HMAC 鍵でしか正しく署名できない**。攻撃者は claim を後から選べないため一致させられない。

**段階リリース**: `REQUIRE_LOGIN_NONCE`（既定 false）で強制を切り替える。false の間は claim を
検証しない（ID トークン自体の検証は常に有効なので、これは多層防御の 1 層の on/off）。実環境で
web の nonce フローを確認してから true にする（`GUEST_JOIN_ENABLED` 等と同じ運用）。
`AUTH_DEV_BYPASS=true` のローカルでは値に関わらず nonce 検証をスキップする（dev トークンは
nonce を持たないため）。nonce エンベロープの寿命 `AUTH_NONCE_TTL_SECONDS`（既定 65 分）は ID
トークン（約1h）より長くし、リフレッシュ直前まで同じ nonce で create/join が通るようにする。
リフレッシュ時（#1）は nonce を採り直し、新しい credential の `nonce` claim も更新する。

### 3. ルーム作成の許可リスト（ADR-0012 §3）
`ROOM_CREATOR_ALLOWLIST`（email かドメインのカンマ区切り）を追加し、`create_session` で
`can_create_room` を照合する。**空 = 制限なし**（現行の「ログイン済みなら誰でも」を維持 /
`GITHUB_REPO_ALLOWLIST` と同じ方針）で後方互換。非空なら email 完全一致かドメイン一致のみ許可し、
それ以外は 403。**admin（ADR-0014 §2）は常に作成可**。認可の源泉はサーバ側（ADR-0012 と同じ原則）。

## 根拠
- ID トークン検証を API に一本化する ADR-0012 の信頼境界も、トークンを永続化しない ADR-0014 §7
  の方針も崩さず、いずれも**メモリ内のトークン更新**と**サーバ側の追加照合**で足す最小差分。
- nonce をサーバ発行 HMAC にすることで、ステートレス（DB 無し・多インスタンス整合）を保ったまま
  注入に**実効**を持たせる。既存の invite/session_token と同一の仕組みで表面積を増やさない。
- リフレッシュ・nonce ともに新経路に観測性（`nonce_issued`/`nonce_verified`/`nonce_rejected`/
  `nonce_mismatch`/`nonce_missing`/`room_create_denied` を `sanba_auth_events_total` に計上）を通す
  （CLAUDE.md 原則3）。

## 影響
- **API**: `auth.py` に `create_auth_nonce`/`verify_auth_nonce` を追加。`auth_google.py` に
  `AuthUser.nonce`・`require_user_bound`（nonce 束縛依存性）・`can_create_room` を追加。
  `routers/auth.py`（`GET /api/auth/nonce`）を新設。`create_session`/`join_session` を
  `require_user_bound` に切り替え、create にルーム作成 allowlist を結線。
- **config / env / IaC**: `REQUIRE_LOGIN_NONCE`・`AUTH_NONCE_TTL_SECONDS`・
  `ROOM_CREATOR_ALLOWLIST` を `config.py` / `.env.example` / `infra/terraform` に追加
  （いずれも秘匿物ではないため平文 env。nonce 署名は既存 `SESSION_SIGNING_SECRET` を流用）。
- **Web**: `lib/auth.tsx` に exp 先読みリフレッシュと nonce ライフサイクル（採取→適用→ログアウトで
  破棄）を追加。`lib/api.ts` に `fetchAuthNonce`/`setAuthNonce` と `X-Auth-Nonce` の付与を追加。
- **テスト**: nonce の HMAC 往復（単体）、nonce claim 取り出し、`can_create_room`、
  create/join の nonce 強制（有効/欠落/不一致/フラグ off/dev bypass）と allowlist（許可/拒否/
  ドメイン/空=無制限）の結線を追加。

## 却下案
- **クライアント生成 nonce を header で送り返すだけ**: ステートレス構成では replay/injection に
  実効が乏しく、CLAUDE.md の「見栄えだけの実装をしない」に反する。サーバ発行 HMAC を採る。
- **nonce を Firestore などサーバ側に保存して照合**: 正統だが多インスタンスで状態同期が要り、
  SANBA のステートレス HMAC 方針から外れる。envelope 自己証明で保存を避ける。
- **ID トークンを長寿命化 / リフレッシュトークンを保存**: GIS は任意寿命化を提供せず、
  リフレッシュトークンの保存は ADR-0014 §7（非永続）に反する。exp 先読みの静かな再取得で足りる。
- **ルーム作成 allowlist を空=全面禁止（fail-closed）にする**: 現行の単一チーム運用と既存テストを
  壊す。`GITHUB_REPO_ALLOWLIST` と同じ「空=無制限」にし、必要な環境だけ絞る。

## 保留（未解決リスク）
- exp 先読みリフレッシュは FedCM の cooldown（One Tap の連続ディスミス後など）で静かな再取得が
  沈黙する場合があり、その際は失効後の再サインインに退避する。実ブラウザでの挙動確認を残す。
- サーバ発行 nonce の envelope は `SESSION_SIGNING_SECRET` を共有する。鍵ローテーション時は
  発行中の nonce・invite・session_token がまとめて無効化される（同一鍵の既存挙動と同じ）。
- `REQUIRE_LOGIN_NONCE=true` にする前に、reload 時の auto_select 復元→nonce 適用→再 mint の
  窓（ごく短時間 credential が nonce 無し）で create/join を叩くと 401 になり得る点を実測する。
