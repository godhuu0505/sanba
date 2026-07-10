# external-agents — SANBA ↔ 外部エージェント境界

SANBA と**境界の向こうの AI エージェント**を、**A2A**（エージェント間）と **MCP**（ツール/データ）の
**オープン標準**で結ぶための bounded context。設計判断と背景は
[ADR-0063](../docs/adr/0063-elastic-agent-builder-a2a-boundary.md)。

**プロバイダーを固定しない命名。** 初弾のプロバイダーは **Elastic Agent Builder**（ES データ上で動く
AI エージェント。Fleet のデータ収集「Elastic Agent」とは**別物**）だが、将来は AWS（Bedrock
AgentCore / Strands）や Google ADK など別プロバイダーもあり得る。ディレクトリ名を `elastic-*` に
固定するとプロバイダー選定を縛るため、境界の概念（外部エージェント）を名前に採る。プロバイダー非依存の
seam（`contract` / `a2a_client`）を上位に置き、プロバイダー固有のアダプタは各サブパッケージ
（`elastic/` 等）に隔離する。

**初弾の狙いは A2A 越境の実証。** 初弾エージェントは「対象アプリの**外側**の関連情報を持つ小さな
エージェント」——アプリのソースコードだけでは知り得ない外部の状況・経歴・システム用外部要件を記述した
ファイル群（`elastic/sample-data/external-context/` の形式）を知識に持つ read-only エージェント。
特定データの分析ではなく、**分離された境界の別環境エージェントと A2A で会話できること**を最小構成で
通す最初の一歩。

## この境界が持つもの / 持たないもの

- 持つ: プロバイダー非依存の A2A/MCP seam（契約の純関数・A2A 部品）と、プロバイダー固有アダプタ
  （宣言的 agent/tool 定義・冪等プロビジョニング・A2A クライアント）。
- 持たない: エージェント runtime そのもの。Agent Builder（GA プロダクト）を作り直さない
  （「薄いエージェント」禁止・車輪の再発明回避）。プロバイダーは seam の背後で差し替え可能。

## 構成

```
external-agents/
  src/sanba_external_agents/
    contract.py           A2A/MCP エンドポイント URL の純関数（プロバイダー非依存）
    a2a_client.py         A2A の組み立て/応答解析の純関数（プロバイダー非依存）
    elastic/              Elastic Agent Builder プロバイダーアダプタ
      config.py           env 設定（ELASTIC_AGENT_*）。既定 OFF・未設定は no-op 縮退
      client.py           A2A 委譲クライアント（fail-soft）
      catalog.py          宣言的定義の読み込み・検証
      provision.py        Agent Builder への冪等 upsert
      definitions/        agent/tool 定義（sanba-external-context への read-only）
      sample-data/        取り込む外部要件ファイルの形式例
  tests/                  ネットワーク非依存の単体テスト
```

将来のプロバイダーは `elastic/` と同階層に `aws/`・`google_adk/` を並べるだけ。上位の seam は不変。

## 安全側の既定（ADR-0003 / ADR-0007 の流儀）

- `ELASTIC_AGENT_ENABLED` は既定 **OFF**。`ELASTIC_AGENT_KIBANA_URL` / `ELASTIC_AGENT_API_KEY` が
  空なら委譲は **no-op**（`DelegationResult(delegated=False)`）で、テスト・デモ・クリティカルパスを止めない。
- **音声クリティカルパスから直接呼ばない。** Elastic の A2A は同期・非ストリーミングなので、委譲は
  ADK 分析層の off-loop 非同期からのみ行う（ADR-0046 / ADR-0002）。

## 前提（Phase 1 で判断）

Agent Builder は Elastic **9.3+ / Enterprise ティア**を要する。SANBA は現状 8.14.3・本番 ES は
持ち込み前提。採用可否（スタック更新・費用）は人間が判断する（CLAUDE.md 原則1）。seam を先に確立し、
規模が正当化した段階で Agent Builder に寄せるか自前実装で満たすかを選ぶ。

## 使い方（Phase 1 以降・flag ON 時）

```bash
# 定義を Agent Builder へ冪等プロビジョニング
ELASTIC_AGENT_KIBANA_URL=... ELASTIC_AGENT_API_KEY=... \
  uv run python -m sanba_external_agents.elastic.provision
```

SANBA 側からの委譲は `sanba_external_agents.elastic.ElasticAgentClient(...).ask("...")` を
ADK 分析層の非同期経路から呼ぶ。
