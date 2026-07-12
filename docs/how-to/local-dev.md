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
| `docker-compose.tools.yml` | OTel・Prometheus・Loki・Tempo・Grafana・four-keys | **任意**。あったら便利 |

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
| http://localhost:3001 | Grafana (anonymous Viewer) | 補助 |
| http://localhost:5601 | Kibana (analytics ダッシュボード開発用 / ADR-0061) | 補助 |
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
| OTel トレース | `just up-full` (Collector→Tempo→Grafana。本番は Cloud Trace 直送) | endpoint 未設定なら送信スキップ |

`GOOGLE_API_KEY` を `.env.local` に入れて `just up` し直すと、音声を除く AI 経路が実物になる。
音声 S2S は実機マイク + ブラウザ (http://localhost:3000) で確認する。

ログイン/管理画面: 既定の `.env.example` は `AUTH_DEV_BYPASS=true` かつ
`ADMIN_EMAILS=dev@sanba.local` なので、`/login` で「開発用ログイン」を押すと固定 dev
identity (dev@sanba.local) になり、`/admin` がそのまま開ける (ADR-0014)。本番は
`AUTH_DEV_BYPASS=false`・`GOOGLE_OAUTH_CLIENT_ID`・`ADMIN_EMAILS` を実値で設定する。

## 5. 機能別フル構築 (本物の経路を通す)

`just up` は配線確認まで。各機能を「本物」で動かすには下記を `.env.local` に足して
`just up`（再ビルド）し直す。4 つの体験ごとに、必要な値・確認方法・未設定時の挙動をまとめる。

### 5.1 マルチモーダル音声会話 (Gemini Live S2S)
- **設定**: `GOOGLE_API_KEY`（AI Studio）。Vertex を使うなら `GOOGLE_GENAI_USE_VERTEXAI=true` +
  `GOOGLE_APPLICATION_CREDENTIALS`。モデルは `GEMINI_LIVE_MODEL`（既定 `gemini-2.0-flash-live-001`）。
- **確認**: ブラウザで http://localhost:3000 → セッション作成 → 参加し、実機マイクで話す。
  エージェントが音声で応答すれば S2S が通っている。
- **未設定時**: ワーカーは起動・ルーム参加するが、セッションで応答できない。

### 5.2 画像・動画解析 (マルチモーダル素材 / ADR-0004)
- **設定**: 画像解析は `GOOGLE_API_KEY`（or Vertex）+ `GEMINI_VISION_MODEL`（既定 `gemini-2.5-flash`）。
  保存先は `GCS_BUCKET`（空なら in-memory フォールバック、ただし動画解析では worker から読めないため
  実 GCS バケット必須）、サイズ上限 `MAX_ASSET_BYTES`（既定 25MB）。
  動画解析は `ENABLE_VIDEO_ANALYSIS`（既定 `false`）で有効化し、非同期ワーカー（`apps/worker` /
  ADR-0040）が解析する。ローカルは `GCS_BUCKET` を実バケットに設定した上で worker を別途起動して
  `WORKER_URL` を指し、`LOCAL_DIRECT_DISPATCH=true` で Cloud Tasks を使わず直接ディスパッチする。
- **経路**: web の素材アップロード → `POST /api/sessions/{id}/context/file` → 画像から観察文を抽出し
  共有 Elasticsearch 索引へ context として書く（言葉×画の矛盾検知の素地）。
- **未設定時**: creds が無いと観察抽出は空配列（アップロード自体は通る）。

### 5.3 エージェントによる要件サンバ (ADK 分析フロー)
- **設定**: `GOOGLE_API_KEY`（or Vertex）+ `GEMINI_REASONING_MODEL`（既定 `gemini-2.5-flash`）。
  根拠付け/過去検索は `ELASTICSEARCH_URL`（既定で起動）、埋め込みは `GEMINI_EMBED_MODEL`。
  永続化は `FIRESTORE_EMULATOR_HOST`（既定で起動）。
- **経路**: 発話の文字起こし → ADK で要件・論点・次の問いを抽出 → Firestore/Elasticsearch へ保存 →
  LiveKit データチャネル `sanba.events` で web にリアルタイム配信（[realtime-contract](../reference/realtime-contract.md)）。
  確定要件は `POST /api/sessions/{id}/export` で GitHub Issue に起票できる
  （`GITHUB_CONNECTOR_ENABLED=true` + `GITHUB_TOKEN` + `GITHUB_REPO`）。
- **未設定時**: creds 無しでは ADK 分析はヒューリスティック近似、ES は語の重なり近似、Firestore は in-memory。

### 5.4 ユーザー管理・ログイン (Google ログイン / 管理画面 / ADR-0012・0014)
- **dev 既定**: `.env.example` は `AUTH_DEV_BYPASS=true` + `ADMIN_EMAILS=dev@sanba.local`。`/login` の
  「開発用ログイン」で固定 dev identity（dev@sanba.local）になり、`/admin` がそのまま開ける。
- **本物の Google ログイン**: `AUTH_DEV_BYPASS=false` + `GOOGLE_OAUTH_CLIENT_ID`（=`NEXT_PUBLIC_GOOGLE_CLIENT_ID`、
  Google Cloud Console の OAuth 2.0 Web クライアント ID）+ `ADMIN_EMAILS` に実 email。ID トークンは
  サーバ側（API）で検証する（client *secret* は不要）。
- **管理画面でできること**: 全セッションの一覧・閲覧、AI 生成要件の編集・承認/却下（承認すると 30 日 TTL を解除）、
  セッション作成・招待発行。閲覧は requirements のみ（生の発話は出さない / issue #10）。
- **注意**: `require_admin` は dev bypass でも `ADMIN_EMAILS` を照合する。本番で `GOOGLE_OAUTH_CLIENT_ID`/
  `ADMIN_EMAILS` 未設定だと認証経路はフェイルクローズ（503）する。

## 5.5 compose 設計メモ（なぜそうなっているか）

`docker-compose.yml`（必須スタック）と `docker-compose.tools.yml`（overlay）の設計判断。

- **NEXT_PUBLIC_\* の既定が localhost**: Next.js のビルド時にバンドルへ焼き込まれる値で、
  ブラウザから見たエンドポイントのため localhost を既定にする。`NEXT_PUBLIC_GOOGLE_CLIENT_ID` が
  空なら web は dev モード（Google ログインを出さず bypass で進む / ADR-0012）。
- **コンテナ内 URL の振り向け**: コンテナ内から `localhost` は自分自身を指すため、`.env.local` の
  `ws://localhost:7880`（ブラウザへ返す join URL 用）ではコンテナから LiveKit に届かない。
  agent は `AGENT_LIVEKIT_URL`（既定 `ws://livekit:7880`）、api の server-side publish
  （analysis.progress/visual を RoomService.send_data で送る / ADR-0023）は `API_LIVEKIT_URL`
  （既定 `ws://livekit:7880`）で publish 先だけを compose のサービス名へ振り向ける。
  LiveKit Cloud 等の別ホストを使う場合は `.env.local` でこれらを上書きする
  （未設定なら api は livekit_url にフォールバックする）。
- **ADC マウントの footgun 回避**: Vertex AI 経路（`GOOGLE_GENAI_USE_VERTEXAI=true`）の認証は
  ADC に依存し、`GOOGLE_APPLICATION_CREDENTIALS=/gcp/adc.json` に read-only でマウントする。
  マウント元の既定は `/dev/null`（必ず存在する）— 未ログイン時に Docker が host 側へ
  空**ディレクトリ**を作ってしまう footgun を避けるため。Vertex AI を使う場合のみ `.env.local` の
  `SANBA_ADC_FILE` に `application_default_credentials.json` のパスを指定する（複数アカウントは
  `CLOUDSDK_CONFIG` 配下、標準は `~/.config/gcloud/application_default_credentials.json`。
  AI Studio 既定経路では ADC 不要）。
- **agent のモデル取得**: ローカルは `DOWNLOAD_MODELS=0` でビルド時同梱をスキップし
  （ビルド軽量化）、実行時に取得して `agent-cache` volume（appuser の home 配下 `~/.cache`）へ
  永続化する。本番/CI は Dockerfile 既定（`DOWNLOAD_MODELS=1`）で同梱する。
- **healthcheck**: api イメージ（python:slim）には curl が無いため、標準ライブラリで
  `/healthz` を叩く。
- **livekit の `--dev`**: devkey/secret を有効化する。`.env.local` の `LIVEKIT_API_KEY/SECRET` と
  一致させる。
- **Grafana のローカル・ハードニング**: 匿名アクセスは残すが権限は Viewer に下げる
  （無認証 Admin を廃止）。iframe 埋め込みを禁止して clickjacking 面を塞ぎ、ポートは
  `127.0.0.1:3001` バインドでローカルホストのみに公開する（LAN 等からの到達を防ぐ）。
- **Kibana（overlay）**: `sanba-analytics-*` のコスト/KPI ダッシュボード開発用（ADR-0061）。
  必須スタックの elasticsearch に同居し、`just analytics-setup`
  （`KIBANA_URL=http://localhost:5601`）でダッシュボードを import する。
- **four-keys（overlay）**: このリポジトリの deploy.yml run + incident issue を読む。
  `GITHUB_TOKEN` があると API レート上限が上がり、無い場合は同梱のサンプルデータに
  フォールバックする。
- **overlay の仕組み**: tools 側は agent / api に `OTEL_EXPORTER_OTLP_ENDPOINT` を注入する。
  アプリ最小構成（`just up`）では未設定のままテレメトリが graceful にスキップされ、雑音が出ない。
  LLM 品質はローカルではなく CI 回帰 + 本番の Cloud Trace/Monitoring で見る（ADR-0051。
  ローカル Langfuse は廃止）。
- **image の手動ピン**: Dependabot の docker ecosystem は Dockerfile の `FROM` しか更新しない
  ため、compose の `image:` は固定バージョンタグで手動ピンする（SEC-047 /
  [ci-cd-workflows.md](../reference/ci-cd-workflows.md)）。

## 6. ネイティブ実行 (docker を介さない)

個別に速く回したいとき:

```bash
just api-dev     # uvicorn --reload (8080)
just web-dev     # next dev (3000)
just agent-dev   # LiveKit worker (dev モード)
```

依存 (livekit/firestore/elasticsearch) だけ docker で上げ、アプリはネイティブ、という
混在も可能。その場合 `.env.local` の `*_HOST` / `*_URL` を `localhost` に向ける。

## 7. トラブルシュート

- **Elasticsearch が unhealthy**: メモリ不足。Rancher Desktop の割当を 4GB 以上に。
- **web のヘルスチェックが落ちる**: 初回ビルドに時間がかかる。`just logs` で進捗確認。
- **agent がすぐ落ちる**: `.env.local` の `LIVEKIT_*` が livekit (`devkey/secret`) と一致しているか確認。
