# ローカル開発ガイド — 全コンポーネントを立ち上げて実働確認する

Rancher Desktop (dockerd / moby) + `docker compose` を前提とする。
タスクランナーは `just` が唯一のエントリポイント (未導入なら `uv tool install rust-just`)。

## 0. 前提

- Rancher Desktop を起動し、Container Engine を **dockerd (moby)** にする。
- `docker compose version` が通ること。
- **初回セットアップ**: `just setup` で `.env.local` の用意と全依存のインストール (uv sync / npm install) が
  まとめて走る (冪等)。`.env.local` は `.env.example` から自動生成され、ローカル既定値が入っているため
  そのまま `just up` できる。`GOOGLE_API_KEY` / `LIVEKIT_*` などは必要に応じて `.env.local` に埋める。

## 1. 二層構成

| ファイル | 中身 | いつ使う |
|---|---|---|
| `docker-compose.yml` | web / api / agent / livekit / firestore / elasticsearch | **必須**。アプリ一式 |
| `docker-compose.tools.yml` | OTel・Prometheus・Loki・Tempo・Grafana・Langfuse・four-keys | **任意**。あったら便利 |

補助スタックは base に重ねる overlay。単体では起動しない (ADR-0009)。

## 2. 起動

```bash
just setup       # 初回のみ: .env.local 用意 + 全依存インストール (uv sync / npm install)
just init        # 初回を一発で: setup → up (最小構成) まで一気通貫

just up          # アプリ最小構成だけ (軽い)
just verify      # 各コンポーネントの疎通スモークテスト

just up-full     # 補助スタックも重ねて全部入り
just verify-full # 補助スタック込みで疎通確認

just ps          # 起動中サービス
just logs        # ログ追従
just down        # 全部停止
just tools-down  # 補助スタックだけ停止 (アプリは残す)
```

## 3. アクセス先

| URL | 何 | スタック |
|---|---|---|
| http://localhost:3000 | Web クライアント | 必須 |
| http://localhost:3000/login | ログイン画面 (Google / dev) | 必須 |
| http://localhost:3000/admin | 管理画面 (セッション/要件の確認・承認) | 必須 |
| http://localhost:8080/healthz | API ヘルスチェック | 必須 |
| ws://localhost:7880 | LiveKit (dev) | 必須 |
| http://localhost:9200 | Elasticsearch | 必須 |
| localhost:8200 | Firestore エミュレータ | 必須 |
| http://localhost:3001 | Grafana (anonymous admin) | 補助 |
| http://localhost:3030 | Langfuse | 補助 |
| http://localhost:9090 | Prometheus | 補助 |
| http://localhost:9301/metrics | four-keys (DORA) | 補助 |

## 4. どこまでが「本物」か

外部依存はすべて「未設定なら graceful fallback」で実装されている。`just up` は
**配線が通っているか**を確認できる。実際の音声 S2S・LLM 推論まで通すには creds が要る:

| 経路 | 必要な値 | 未設定時の挙動 |
|---|---|---|
| Gemini Live (音声本体) | `GOOGLE_API_KEY` (or Vertex) | ワーカーは起動・登録するがセッションで応答不可 |
| ADK 分析 / 埋め込み | `GOOGLE_API_KEY` (or Vertex) | ヒューリスティック近似 |
| Firestore 永続化 | エミュレータ (既定で起動) | in-memory |
| Elasticsearch RAG | ES (既定で起動) | 語の重なり近似 |
| Langfuse トレース | `LANGFUSE_*` + `just up-full` | 送信スキップ |

`GOOGLE_API_KEY` を `.env.local` に入れて `just up` し直すと、音声を除く AI 経路が実物になる。
音声 S2S は実機マイク + ブラウザ (http://localhost:3000) で確認する。

ログイン/管理画面: 既定の `.env.example` は `AUTH_DEV_BYPASS=true` かつ
`ADMIN_EMAILS=dev@sanba.local` なので、`/login` で「開発用ログイン」を押すと固定 dev
identity (dev@sanba.local) になり、`/admin` がそのまま開ける (ADR-0014)。本番は
`AUTH_DEV_BYPASS=false`・`GOOGLE_OAUTH_CLIENT_ID`・`ADMIN_EMAILS` を実値で設定する。

## 5. ネイティブ実行 (docker を介さない)

個別に速く回したいとき:

```bash
just api-dev     # uvicorn --reload (8080)
just web-dev     # next dev (3000)
just agent-dev   # LiveKit worker (dev モード)
```

依存 (livekit/firestore/elasticsearch) だけ docker で上げ、アプリはネイティブ、という
混在も可能。その場合 `.env.local` の `*_HOST` / `*_URL` を `localhost` に向ける。

## 6. トラブルシュート

- **Elasticsearch が unhealthy**: メモリ不足。Rancher Desktop の割当を 4GB 以上に。
- **web のヘルスチェックが落ちる**: 初回ビルドに時間がかかる。`just logs` で進捗確認。
- **agent がすぐ落ちる**: `.env.local` の `LIVEKIT_*` が livekit (`devkey/secret`) と一致しているか確認。
