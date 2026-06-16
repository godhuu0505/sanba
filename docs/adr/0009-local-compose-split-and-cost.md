# ADR-0009: ローカル compose の二層分割と本番コスト最適化

- ステータス: Accepted
- 日付: 2026-06-15

## コンテキスト
「ローカルで全コンポーネントを立ち上げて実働確認したい」「環境変数を整理したい」
「本番は Terraform で作り、CI/CD はなるべく金がかからない設計に」という要求。
従来は単一の `docker-compose.yml` にアプリ・可観測性・Langfuse・four-keys を全部詰めており、
起動が重く、最小構成で動かしたいときも全部立ち上がっていた。

## 決定 1: docker compose を「アプリ最小構成」と「補助スタック」に分割
- `docker-compose.yml` — web / api / agent / livekit / firestore / elasticsearch。
  これだけで「つくる」アプリ一式が起動する (必須)。
- `docker-compose.tools.yml` — OTel/Prometheus/Loki/Tempo/Grafana・Langfuse・four-keys
  (必須ではないが あったら便利)。base に **重ねる overlay** として使う。
- 起動方法:
  - `just up` … アプリ最小構成のみ
  - `just up-full` … `-f docker-compose.yml -f docker-compose.tools.yml` で全部入り
- overlay は同一 compose プロジェクト (`name: sanba`) なので network を共有する。
  外部ネットワークの手動作成は不要。

**理由**: 「必須」と「便利」を物理的に分けることで、最小構成の起動を軽くし、デモ当日の
依存を減らせる。overlay 方式なら補助スタックを足すときも 1 コマンドで済む。

## 決定 2: テレメトリ送信先は overlay 適用時のみ注入
- `.env` の `OTEL_EXPORTER_OTLP_ENDPOINT` / `LANGFUSE_HOST` は **既定で空**。
- `docker-compose.tools.yml` が agent/api に対し OTLP・Langfuse のエンドポイントを
  `environment` で注入する。
- 効果: アプリ最小構成 (`just up`) では収集器が居なくてもテレメトリ送信が graceful に
  スキップされ、接続エラーの雑音が出ない。全部入りでは自動で観測が有効になる。

## 決定 3: 環境変数を用途別に再編
- `.env.example` を [1]必須 / [2]本物のAI経路に必要 / [3]任意(補助スタック) の 3 段に整理し、
  各変数に「どのサービスが読むか」を明記。
- `NEXT_PUBLIC_*` は Next.js が**ビルド時に焼き込む**ため、compose の `build.args` と
  web の Dockerfile `ARG` 経由で渡す (実行時 env では不足する問題を解消)。

## 決定 4: 本番の環境変数は Terraform で宣言、機微情報は Secret Manager
- `infra/terraform/secrets.tf` が Secret Manager にシークレットを作成し、Cloud Run の
  `value_source.secret_key_ref` で注入する。値が空のものは作らない。
- `session_signing_secret` は未指定なら `random_password` で自動生成して保管する。
- 平文の設定 (LIVEKIT_URL / モデル名 / 保持日数 等) は Cloud Run の `env` で渡す。
- 本番は `use_vertexai = true` を既定にし、Gemini を**キーレス** (実行 SA の
  `aiplatform.user`) で叩く。API キーをシークレットに置かなくてよい (GCP 連携の加点)。

## 決定 5: CI/CD はランタイム/実行分の両面でコストを抑える
- **デプロイ (deploy.yml)**: `dorny/paths-filter` で**変更のあった app だけ**ビルド&デプロイ。
  Buildx の GHA キャッシュ、`concurrency` で古い実行をキャンセル。
- **Cloud Run**: api/web は `cpu_idle=true` + `min=0` で **scale-to-zero** (リクエスト時のみ課金)。
  agent は常駐ワーカーのため `agent_min_instances` 変数で制御 (既定 1、不要時 0 でコスト停止)。
- **Artifact Registry**: cleanup policy で直近 N 個のみ保持しストレージ課金を抑制。
- env/secret/スケールは Terraform が一度設定し、CI は**画像の差し替えのみ**
  (`gcloud run deploy --image` は既存設定を保持)。terraform 側は image を `ignore_changes`。

## 検討したが採用しなかった選択肢
- **補助スタックを独立 compose + 外部ネットワーク**: ネットワーク手動作成が要り運用が増える。
  overlay 方式の方が単純。却下。
- **CI から terraform apply で画像更新**: 再現性は高いが state backend と広い権限が要り重い。
  ハッカソン規模では image-only の gcloud デプロイ + ignore_changes で十分。保留。

## 影響
- README / docs/devops.md のクイックスタートを `just up` / `just up-full` / `just verify` に更新。
- `scripts/verify-local.sh` で各コンポーネントの疎通をスモークテストできる。
