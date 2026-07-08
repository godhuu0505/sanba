# ADR-0060: サーバサイドセッション（不透明 SID + HttpOnly Cookie）と Next.js 同一オリジン化

- ステータス: Accepted
- 日付: 2026-07-09
- 関連: ADR-0012（Google ログイン・信頼境界）、ADR-0014 §7（ID トークンを永続化しない）、
  ADR-0030（クロスタブ・ログアウト）、ADR-0047（ログイン nonce / トークンリフレッシュ）、
  ADR-0052（ログイン画面刷新と復元中の中立スプラッシュ）

## コンテキスト

現行の web 認証（ADR-0052 が採用した「復元中は中立スプラッシュを見せる」路線）は、
`apps/web/lib/auth.tsx` の `useGoogleAuth` が **クライアント側 state だけで credential を保持**し、
リロード/直接 URL 訪問のたびに GIS `id.prompt()` のサイレント復元を待つ設計だった。
運用で以下の症状が顕在化した:

1. **BrandSplash（「ログイン確認中」）が最大 8 秒残る**（`SETTLE_WITH_HINT_MS = 8000`）。
   `id.prompt()` は 3rd party cookie 制限・複数 Google アカウント・prompt cooldown 等で暗黙に
   失敗しやすく、`isNotDisplayed()` イベントが来ないケースがある。
2. **`/login` に一瞬遷移してすぐ元ページに戻るフラッシュ**が起きる。`RequireAuth` は
   `ready=true && !loggedIn` になった瞬間に `/login` へ `router.replace` するが、`/login`
   到着後に別の `useGoogleAuth` インスタンスがサイレント再取得を成功させ、元ページへ跳ね戻る。
3. **GIS `initialize()` の複数回呼び出し**（`setup` / `upgradeNonce` / `refreshCredential` の
   3 箇所）が cooldown に入り、以後 `prompt()` が沈黙する。

原因はいずれも「認証状態がクライアントに閉じており、SSR 段階で確定できない」点にある。
ADR-0052 は当時、ADR-0014 §7（ID トークンを localStorage に置かない＝XSS 回避）を守るため
「復元は速い前提」で許容していたが、GIS のサイレント復元は実運用で信頼できないことが判明した。

nashi-gen-portal の実装比較でも、鍵は **「サーバ側で認証状態を確定させ、クライアントに推測させない」**
点だと結論した（NextAuth 全面採用や Google refresh token の JWT 埋め込みは持ち込まない）。

## 決定

不透明なサーバサイドセッション（opaque SID + HttpOnly Cookie）を導入し、Next.js を
FastAPI と同一オリジンで動かす。ADR-0014 §7 の「トークンを JavaScript 読取域に置かない」
原則は **強化される**（Cookie は `HttpOnly` で JS からは読めない）。

### 1. Firestore に `auth_sessions` コレクションを新設

不透明 SID（256bit 乱数の URL-safe base64）を主キーに、以下を持つ:

```
auth_sessions/{sid}
  google_sub: string        # ID トークンの sub。email 変更に強い identity
  email: string
  email_verified: bool
  name: string
  created_at: timestamp
  last_seen_at: timestamp
  expires_at: timestamp     # Firestore TTL policy で自動削除（絶対上限 24h）
  idle_expires_at: timestamp # 8h の idle TTL。アクセスごとに延長
  revoked_at: timestamp?    # 論理 revoke
  ua_hash: string           # 監査（生 UA を持たない）
  ip_hash: string           # 監査（生 IP を持たない）
```

**ユーザーコレクションは作らない。** 認可は既存の email allowlist
（`ROOM_CREATOR_ALLOWLIST` / `ADMIN_EMAILS`）で継続する。プロフィール編集や quota が要件に
上がった時点で `users/{google_sub}` を追加する（`sub` を主体 ID にしておけば非破壊で導入できる）。

### 2. FastAPI に 3 エンドポイント + 新依存性を追加

- `POST /api/session/exchange` — 既存 `verify_google_id_token()` + `enforce_login_nonce()` を通し、
  SID を発行して Firestore にドキュメント作成、`sanba_sid` Cookie を発行。
- `DELETE /api/session` — 現セッションを revoke（`revoked_at` を set）し Cookie を削除。
- `GET /api/session/me` — 現在のセッションのプロフィールを返す（`AuthProvider` 初期化用）。

新依存性 `require_session_or_bearer`:
- Cookie `sanba_sid` があれば Firestore lookup → `expires_at` / `revoked_at` を検証 → AuthUser 返却
- 無ければ既存 `require_user`（Bearer）にフォールバック
- どちらも無ければ 401

既存の `require_user` / `require_user_bound` / `maybe_user_bound` はそのまま残し、
既に配線済みのエンドポイント（LiveKit token 発行など）は Bearer 経路と Cookie 経路の
両方が通るように少しずつ移行する。Cloud Tasks push（`apps/worker`）と server-to-server は
Bearer のまま。

**Nonce 束縛（ADR-0047）**: `exchange` の 1 回だけで検証する（ID トークンから SID への一方向の
変換なので、注入トークン防御は入口で成立する）。以降の API 呼び出しでは nonce ヘッダを不要にする。

### 3. Next.js を FastAPI と同一オリジンにする（`rewrites`）

`apps/web/next.config.mjs` に:

```js
async rewrites() {
  return [{ source: "/api/:path*", destination: `${INTERNAL_API_URL}/api/:path*` }];
}
```

- `NEXT_PUBLIC_API_URL` は削除し、`lib/api.ts` の `API_URL` は空文字（＝相対 URL）に。
- `INTERNAL_API_URL` は Next.js サーバ側だけが参照する新環境変数（デフォルト `http://localhost:8080`、
  Cloud Run では同一 VPC の API サービス URL）。
- ブラウザからは常に同一オリジンに見え、Cookie は Next.js のドメインに紐づいた **first-party** として
  扱われる（ITP / SameSite=None の罠が消える）。

Terraform / Cloud Load Balancer の設定変更は **本 PR では行わない**。rewrites の 1 段プロキシ
（Next.js Cloud Run → API Cloud Run）で同一オリジン化を成立させる。将来の最適化（LB による URL
マップ）は別 ADR で扱う。

### 4. Cookie 属性

```
Set-Cookie: sanba_sid=<opaque>;
            HttpOnly; Secure; SameSite=Lax; Path=/;
            Max-Age=28800    # 8h idle
```

- `SameSite=Lax` + 同一オリジンで CSRF は構造的に防御される（外部サイトからの unsafe method に
  Cookie が乗らない）。多層防御として、unsafe methods は `Origin` ヘッダを検証する middleware を
  API 側に追加する。
- 絶対上限は `expires_at` で 24h。それを超えると Firestore TTL が消し、client にも Cookie 期限が
  切れる。
- リフレッシュ戦略: 各 authenticated リクエストで `idle_expires_at` を延長（+8h）、レスポンスに
  同じ Cookie を再セット（rolling session）。`created_at` からの絶対 24h は延長しない。

### 5. Next.js `middleware.ts` で保護ルートを SSR ガード

`apps/web/middleware.ts` を新設し、`sanba_sid` Cookie の**存在**を見て未ログインなら `/login`
にリダイレクトする。**署名検証はしない**（Cookie は不透明値なので middleware では判断できない）。
真の検証は API 側で行うが、middleware での早期リダイレクトによって:

- SSR 段階で `/login` へ 302 → BrandSplash が出ない
- GIS スクリプトのロードを保護ページで最初から始めない → LCP 改善

### 6. `AuthProvider` の役割を縮小

- `AuthProvider` は初期マウント時に `GET /api/session/me` を叩く（Cookie 由来）。
  - 200 → `loggedIn=true, profile=...` を即座に確定 → `RequireAuth` が待たない
  - 401 → `loggedIn=false` → `/login` へ（middleware で既に弾かれるはずだが多層防御）
- GIS 初期化は `/login` ページに閉じ込める（初回サインイン専用）。ホーム系で GIS スクリプトを
  ロードしない。
- `credential`（ID トークン）は Cookie 交換後にメモリからも破棄する。以降は Cookie が識別子。
- ADR-0030（クロスタブログアウト）は `signOut()` が `DELETE /api/session` を叩き
  BroadcastChannel で他タブにも通知する形で維持する。

### 7. Bearer 経路の互換維持と段階移行

- `apps/web/lib/api.ts` の全 `fetch` に `credentials: "include"` を追加（同一オリジンなら暗黙で
  含まれるが、明示することで挙動を確定させる）。`Authorization` ヘッダ付与は残す（Bearer と
  Cookie が両方来た場合、Cookie を優先）。
- `X-Auth-Nonce` の付与は当面残すが、exchange 以外の endpoint では検証しない実装へ切り替える
  （FastAPI 側 `require_user_bound` の nonce 検証を Cookie 経路では skip）。
- LiveKit worker、Cloud Tasks push、外部からの直接呼び出しは Bearer のまま。

## 理由 / 検討した代替案

| 案 | 採用 | 却下理由 |
|---|---|---|
| **A. Cookie に自前 JWT を格納（HMAC 署名）** | | ステートレスで実装は最小だが、サーバ側 revoke ができない。共有端末・盗難時のリスクを塞げない |
| **B. 不透明 SID + Firestore（本案）** | ✓ | revoke 可能、TTL 制御可能、監査可能。追加コスト最小（Firestore 1 doc / セッション） |
| C. ユーザーコレクション導入 | | 現状 email allowlist で認可十分。プロフィール要件が上がるまで導入不要 |
| D. NextAuth 全面導入 | | `GOOGLE_CLIENT_SECRET` と `NEXTAUTH_SECRET` を新設、既存 Bearer 経路の書き換えが広範。ROI に見合わない |
| E. 別ドメイン + `SameSite=None; Secure` Cookie | | Safari ITP で 7 日後に purge、3rd party cookie として扱われる将来リスク |
| F. Terraform / LB で同一サブドメイン化 | | 本 PR では見送り。rewrites で同等の効果を早く出せる。LB 化は追随 ADR で扱う |

## 影響 / フォローアップ

1. **API 実装**
   - `apps/api/src/sanba_api/auth_session.py`: SID 発行・cookie 属性・repository interface
   - `apps/api/src/sanba_api/session_store.py`: Firestore repository（fake 実装も同梱してテスト可能に）
   - `apps/api/src/sanba_api/routers/session.py`: exchange / logout / me
   - `auth_google.py`: `require_session_or_bearer` の追加、既存 `require_user_bound` を新方式でも通す
   - `main.py`: 新 router 登録、Origin 検証 middleware 追加
   - `config.py`: `session_cookie_name`, `session_cookie_ttl_seconds`,
     `session_absolute_ttl_seconds`, `session_cookie_secure`, `session_cookie_domain`

2. **Web 実装**
   - `apps/web/next.config.mjs`: rewrites を追加
   - `apps/web/middleware.ts`: 新設。保護ルートを Cookie 有無で早期ガード
   - `apps/web/lib/auth.tsx`: exchange フロー、`me` 取得、GIS 初期化を login ページ限定に、
     credential をメモリに残さない
   - `apps/web/lib/api.ts`: 相対 URL 化、`credentials: "include"`
   - `apps/web/components/RequireAuth.tsx`: cookie ベースの決定的判定に変更、`BrandSplash` 待ちを廃止

3. **テスト**
   - API: exchange 成功 / 失敗（無効 ID トークン / nonce 不一致）、logout、期限切れ、
     Origin 検証、Bearer と Cookie 併存時の優先順位
   - Web: middleware, AuthProvider の me hydrate, login の exchange 呼び出し

4. **不変**
   - ADR-0012（信頼境界: サーバ側で ID トークン検証を必ず行う）
   - ADR-0014 §7（トークンを JS 読取域に置かない）— HttpOnly Cookie でむしろ強化
   - ADR-0030（クロスタブ・ログアウト）
   - ADR-0047（nonce 束縛）— exchange 時に検証、以降は SID が identity

5. **廃止対象**
   - `AUTH_HINT_KEY` の localStorage フラグ（Cookie が事実上の in/out 表明を代替）
   - `SETTLE_WITH_HINT_MS = 8000` / `SETTLE_NO_HINT_MS = 2500` の待機（不要）
   - GIS `id.prompt()` の設定を保護ページで初期化する経路

6. **後続 ADR 候補**
   - Terraform で Cloud Load Balancer / Serverless NEG を組んで rewrites 経由の 1 段プロキシを
     排する（コスト・レイテンシ最適化）
   - 全端末ログアウト（`DELETE /api/session/all`、`google_sub` で走査）
