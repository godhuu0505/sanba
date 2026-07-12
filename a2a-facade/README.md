# a2a-facade — 汎用 A2A ファサード

A2A 非対応の OSS エージェントに **A2A サーバの顔**を与える薄いプロトコル変換層。
初弾バックエンドは **HolmesGPT**（CNCF Sandbox の SRE エージェント）。設計判断と背景は
[ADR-0069](../docs/adr/0069-holmesgpt-first-a2a-proof-and-generic-facade.md)。

- エージェント runtime は自作しない（推論・ツール実行はすべてバックエンド側。
  ADR-0063「薄いエージェント禁止」の踏襲）。
- A2A のプロトコル実装は公式 **`a2a-sdk`** を使う（JSON-RPC 解析・Task ライフサイクル・
  agent card 配信は SDK 任せ。自作の JSON-RPC は持たない）。同期バックエンドは
  `HolmesAgentExecutor` が Task へ橋渡しし、`DefaultRequestHandler` + `InMemoryTaskStore`
  が受ける。
- 公開エンドポイントは A2A 標準のみ: `GET /.well-known/agent-card.json` /
  `POST /a2a/{agent_id}`（JSON-RPC。`SendMessage`（proto）と v0.3 互換 `message/send` の
  同期のみ）/ `GET /healthz`。書き込み系メソッドは公開しない（read-only 方針）。
- バックエンドは `backends/base.py` の `AgentBackend` Protocol 1 枚で差し替え可能。
- デプロイは専用 GCP プロジェクトの Cloud Run（ingress = IAM 認証必須）に、HolmesGPT server を
  sidecar（localhost のみ）として同居させる（Phase 1'）。

## 構成

```
a2a-facade/
  src/sanba_a2a_facade/
    app.py          FastAPI: a2a-sdk の routes 配線 + healthz
    executor.py     HolmesAgentExecutor（同期バックエンドを A2A Task へ橋渡し + 監査）
    card.py         proto AgentCard 生成
    audit.py        委譲レコードの Firestore 冪等 upsert（fail-soft）
    config.py       env 設定（A2A_FACADE_*）
    backends/
      base.py       AgentBackend Protocol（差し替え点）
      holmesgpt.py  HolmesGPT /api/chat へのブリッジ
  tests/            ネットワーク非依存の単体テスト
  sidecar/          HolmesGPT sidecar イメージ（公式イメージ + serverless パッチ + config 生成 entrypoint）
  mcp/
    gcp-observability/  Google 公式 observability-mcp（Cloud Logging/Monitoring/Trace read）+ Supergateway
    firestore/          Google 公式 MCP Toolbox（genai-toolbox）+ read-only ツール定義（tools.yaml）
  Dockerfile        非 root・最小ベース
```

## ローカル起動

```bash
A2A_FACADE_HOLMES_URL=http://localhost:8081 \
  uv run uvicorn --factory sanba_a2a_facade.app:create_app --port 8080
```
