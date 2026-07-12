# a2a-facade — 汎用 A2A ファサード

A2A 非対応の OSS エージェントに **A2A サーバの顔**を与える薄いプロトコル変換層。
初弾バックエンドは **HolmesGPT**（CNCF Sandbox の SRE エージェント）。設計判断と背景は
[ADR-0069](../docs/adr/0069-holmesgpt-first-a2a-proof-and-generic-facade.md)。

- エージェント runtime は自作しない（推論・ツール実行はすべてバックエンド側。
  ADR-0063「薄いエージェント禁止」の踏襲）。
- 公開エンドポイントは A2A 標準のみ: `GET /.well-known/agent-card.json` /
  `POST /a2a/{agent_id}`（JSON-RPC 2.0 `message/send`、同期）/ `GET /healthz`。
  書き込み系メソッドは実装しない（read-only 方針のプロトコル面の担保）。
- バックエンドは `backends/base.py` の `AgentBackend` Protocol 1 枚で差し替え可能。
  `submit()` / `poll()`（Task ベース非同期）は Phase 3' で実装する。
- デプロイは専用 GCP プロジェクトの Cloud Run（ingress = IAM 認証必須）に、HolmesGPT server を
  sidecar（localhost のみ）として同居させる（Phase 1'）。

## 構成

```
a2a-facade/
  src/sanba_a2a_facade/
    app.py          FastAPI: agent card / message/send / healthz
    jsonrpc.py      JSON-RPC 2.0 の解析・応答組み立ての純関数
    card.py         agent card 生成
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
