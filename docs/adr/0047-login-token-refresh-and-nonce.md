# ADR-0047: ログインセッションの堅牢化（ID トークンの能動リフレッシュと nonce 束縛）

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
をキーにした effect が JWT の `exp` を読み、失効の `REFRESH_SKEW_MS`（既定 5 分）前に GIS の
`initialize` → `prompt()` を静かに呼び、新しい ID トークンを先回りで取得する。Google
セッションが生きていれば One Tap は無表示で再発行され、新 credential の到着で effect が
次のリフレッシュを貼り直す（ログアウト＝credential null 化で cleanup がタイマーを解除する
ため、解除漏れの経路が構造的に無い）。取得できない場合は**現行動作**（失効後の API 401 →
再サインイン導線）に委ね、ここで強制ログアウトはしない。下限 `MIN_REFRESH_DELAY_MS`
（5 分。30 秒だと歪んだ時計で「30 秒ごとに静かな prompt + nonce 取得」のループになり FedCM
のクールダウンを誘発する）でクロックずれ時のタイトループを防ぐ。リフレッシュ中のログアウトは
await 後のガードで中断する（ログアウト直後に One Tap を再表示して意図に反する再ログインを
誘発しない）。**ID トークンを永続化しない ADR-0014 §7 の方針は不変**（メモリ内のトークンを
更新するだけ）。

### 2. nonce は「サーバ発行の HMAC チャレンジ」で束縛する
クライアントが生成した nonce を同じリクエストで送り返すだけの方式は、トークンを盗めば nonce も
送れてしまい**ステートレス構成では無力**（CLAUDE.md「見栄えだけの実装をしない」に反する）。
そこで、SANBA が既に invite / session_token で使っている**ステートレス HMAC 署名**方式に揃える。

- `GET /api/auth/nonce`（認証不要 / ログイン前に呼ぶ）が `(nonce, envelope, expires_at)` を
  返す。`envelope` は `nonce`＋`exp` を `SESSION_SIGNING_SECRET` で HMAC 署名した短命トークン
  （サーバに保存しない）。`expires_at` は web が期限切れの nonce を掴み続けないためのヒント。
- web は `nonce` を GIS の `id.initialize({nonce})` に渡す（Google が ID トークンの `nonce`
  claim に埋める）。`envelope` は `X-Auth-Nonce` ヘッダで送る。
- **credential と envelope は原子的な対として扱う**: `X-Auth-Nonce` の有効化は「その envelope
  と一致する `nonce` claim を持つ credential が到着したとき」（`onCredential` のペアリング）
  だけが行う。片方だけ差し替える経路を作ると、リロード復元・リフレッシュ・nonce 取得失敗の
  たびに自作の不一致 401 が生まれる（初版レビューで検出した設計欠陥）。不一致・欠落・期限切れ
  はヘッダを送らず、nonce を採り直して静かな再取得を credential 1 世代につき 1 回だけ試す。
  GIS の initialize/prompt はリロード時に 1 回だけ（nonce を script ロードと並列に先読みして
  一発で nonce 付き初期化。二段 initialize + 再 prompt はリロードごとに One Tap を 2 周させ、
  FedCM のクールダウンで静かな復元自体を壊す）。
- サーバは `envelope` の署名・期限を検証して raw nonce を再導出し、**ID トークンの `nonce`
  claim と一致**することを要求する（`enforce_login_nonce`）。束縛するのはトークン発行・管理に
  直結する identity クリティカルな経路: `create_session`・`join_session`
  （`require_user_bound`）、`join_product` のログイン済み枝（`maybe_user_bound`。依存性なので
  束縛違反の 401 は invite 消費より前に返り、max_uses を無駄に減らさない）、および
  `/api/admin/*`（`require_admin` が `require_user_bound` を合成。全セッション閲覧に至る
  管理経路も識別子クリティカル）。読み取り系（`/api/sessions/mine` 等）は今回束ねない
  （保留に記載）。

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
`ROOM_CREATOR_ALLOWLIST`（email かドメインのカンマ区切り）を追加し、`ensure_room_creator` を
**`create_session` と `create_product` の両方**で照合する。product にも掛けるのは、owner は
自分で深掘りリンクを発行して `join_product` でルームを量産できるため、`create_session` だけ
縛っても「product 自作 → 自己招待 → join」で全バイパスできてしまうから（初版レビューで検出）。
`join_product` 自体は縛らない: リンクからの入場者は **owner が発行した招待の権限**で入るので
あって自発的な開設ではない（end_user/ゲスト入場を allowlist で縛るとリンク機能ごと壊れる）。
**空 = 制限なし**（現行の「ログイン済みなら誰でも」を維持 / `GITHUB_REPO_ALLOWLIST` と同じ
方針）で後方互換。非空なら email 完全一致かドメイン一致のみ許可し、それ以外は 403。
**admin（ADR-0014 §2）は常に作成可**。認可の源泉はサーバ側（ADR-0012 と同じ原則）。

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
  `AuthUser.nonce`・`enforce_login_nonce`（検証本体）・`require_user_bound`/`maybe_user_bound`
  （nonce 束縛依存性）・`can_create_room`/`ensure_room_creator` を追加。`require_admin` を
  `require_user_bound` 合成に変更。`routers/auth.py`（`GET /api/auth/nonce`、`expires_at` 付き）
  を新設。`create_session`/`join_session`/`join_product` を束縛依存性に切り替え、
  `create_session`/`create_product` にルーム作成 allowlist を結線。
- **config / env / IaC**: `REQUIRE_LOGIN_NONCE`・`ROOM_CREATOR_ALLOWLIST` を `config.py` /
  `.env.example` / `infra/terraform` に追加（いずれも秘匿物ではないため平文 env。nonce 署名は
  既存 `SESSION_SIGNING_SECRET` を流用）。`AUTH_NONCE_TTL_SECONDS` は `config.py` のみ
  （Google のトークン寿命から導かれる値で運用チューニング対象ではないため、env/IaC には
  出さない。下げるとトークン失効前に nonce が切れる罠になる）。
- **Web**: `lib/auth.tsx` に exp 先読みリフレッシュと nonce ライフサイクル（先読み→credential
  とのペアリングで有効化→ログアウトで破棄）を追加。`lib/api.ts` に
  `fetchAuthNonce`/`setAuthNonce` と `X-Auth-Nonce` の付与を追加。
- **テスト**: nonce の HMAC 往復（単体）、nonce claim 取り出し、`can_create_room`、
  create/join/products-join/admin の nonce 強制（有効/欠落/不一致/フラグ off/dev bypass）と
  allowlist（許可/拒否/ドメイン/空=無制限/product 経路）の結線、web の X-Auth-Nonce 付与・
  ペアリング・exp デコードを追加。

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
- 読み取り系エンドポイント（`/api/sessions/mine`・products の閲覧系等）は nonce 束縛の対象外。
  束縛は現状トークン**発行・管理**経路に限る。全 `require_user` への一律適用（将来の
  エンドポイント追加で掛け忘れが起きない altitude）は、フラグ on の運用実績を見てから
  別 ADR で判断する。
- allowlist 導入**前**に作られた既存 product の owner が allowlist 外の場合、その product の
  深掘りリンク経由では引き続きルームを作れる（作成時ゲートのため）。必要になったら
  join_product 側で「owner が現在も作成許可を持つか」を照合する追加ゲートを検討する。
- ~~reload 時の auto_select 復元→nonce 適用→再 mint の窓で 401 になり得る~~ → **解決済み**:
  nonce を script ロードと並列に先読みして initialize は 1 回・nonce 付きで行い、envelope の
  有効化は credential とのペアリング（claim 一致時のみ）に限定した（決定2 更新）。フラグ on の
  前に実ブラウザでペアリング成立（`nonce_verified` メトリクス）を確認する運用は維持する。
