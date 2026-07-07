# apps/agent — 音声インタビュー・エージェント

LiveKit ルームに「参加」し、**Gemini Live (speech-to-speech)** で対話する司会エージェント。
一定の区切りで **Google ADK** のマルチエージェント分析を function tool として呼び出し、
要件の構造化・矛盾検知・専門深掘りを行う。

- 言語/管理: **Python 3.12 / [uv](https://docs.astral.sh/uv/)**
- 役割の位置づけは [`docs/reference/architecture.md`](../../docs/reference/architecture.md) を参照。

## 構成

```
src/sanba_agent/
  main.py          LiveKit Agents worker のエントリ（ルーム参加・Gemini Live 接続）
  agent_team.py    ADK マルチエージェント（Lead + 非機能/スコープ/矛盾 sub-agent）
  prompts/         プロンプト（git でバージョン管理）
  tools/           ADK function tool（analysis ほか）
  retrieval.py     Elasticsearch によるRAG 根拠付け・過去セッション検索
  repository.py    Firestore への発話/要件の永続化
  evaluation.py    LLM-as-a-judge 採点（オンライン + CI 回帰）
  connectors/      外部書き出し（GitHub など）
  pii.py           索引前 PII マスキング
  observability.py OpenTelemetry / Cloud Trace 計装
  config.py        環境変数（pydantic-settings）
tests/             pytest（retrieval / evaluation / analysis / pii / connector）
```

## 開発

```bash
# リポジトリルートから（docker 経由・推奨）
just agent-dev          # LiveKit worker を dev モードで起動

# このディレクトリでネイティブに回す
uv sync
uv run python -m sanba_agent.main dev    # worker 起動
uv run pytest                            # テスト
uv run ruff check . && uv run mypy .     # lint + 型
uv run python -m sanba_agent.evaluation  # LLM 評価データセット回帰
```

## 主な環境変数

| 変数 | 用途 | 未設定時 |
|---|---|---|
| `GOOGLE_API_KEY` / Vertex 設定 | Gemini Live / ADK / 埋め込み | 起動はするが応答不可・ヒューリスティック近似 |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | ルーム参加 | dev は `devkey/secret` |
| `FIRESTORE_*` | セッション/要件の永続化 | エミュレータ / in-memory |
| `ELASTICSEARCH_URL` | RAG 根拠付け | 語の重なり近似 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | トレース送信先（未指定でも Vertex 実行なら Cloud Trace 直送 / ADR-0051） | ローカルは無効 |
| `MASK_PII_BEFORE_INDEX` | PII マスク | 既定 `true` |

`.env.example` が正。詳細は [`docs/how-to/local-dev.md`](../../docs/how-to/local-dev.md) / [`docs/reference/security.md`](../../docs/reference/security.md)。
