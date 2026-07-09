# ADR-0063: Elasticsearch 接続エージェント（Elastic Agent Builder）と A2A 連携の境界設計

- ステータス: Proposed
- 日付: 2026-07-09
- 関連: [ADR-0002](0002-multi-agent-topology.md)（マルチエージェント・トポロジ / agent-as-a-tool）/
  [ADR-0003](0003-elasticsearch-grounding.md)（Elasticsearch grounding — 既存の「ES 接続エージェント」）/
  [ADR-0007](0007-external-connectors.md)（外部コネクタ — feature flag 既定 OFF の流儀）/
  [ADR-0046](0046-decouple-analysis-from-voice-worker.md)（分析を音声ループから分離）/
  [ADR-0051](0051-google-native-observability-and-llmops.md)（観測性の統一規律）/
  [ADR-0061](0061-session-ai-cost-kpi-analytics.md)（ES + Kibana の分析イベント基盤）/
  未マージ PR #445（A2A 委譲境界・初弾 repo-scout — 本 ADR が一般化する）
- きっかけ: オーナー要望「Elasticsearch に接続した Elastic エージェントを作り、最終的にサンバの音声
  エージェントと A2A で会話・接続したい。ハッカソン機能ではなく、プロダクトを良くする追加機能企画として、
  そもそも本質的か・拡張性があるか・他の方法はないかをゼロベースで検討してほしい」。

## コンテキスト

### 用語の取り違えを最初に正す（設計を左右する）

「Elastic Agent」には別物が 2 つあり、どちらを指すかで計画がまるごと変わる。

| 名称 | 正体 | 用途 |
|---|---|---|
| **Elastic Agent** | Fleet 管理の統合データ収集エージェント（Beats 群の後継シッパー） | ログ/メトリクス/APM/セキュリティの収集。**AI ではない** |
| **Elastic Agent Builder** | 2025 年登場・Elastic 9.3（2026-01）で GA した、ES データ上で動く **AI エージェント構築フレームワーク** | 会話型 AI / RAG / エージェンティックワークフロー |

要望の文脈（会話・A2A・分析）は明確に後者 **Elastic Agent Builder** を指す。前者（データシッパー）は
SANBA の観測性が Google ネイティブ（OTel → Cloud Trace、ADR-0051）で完結しており導入価値がない。
本 ADR は以後すべて **Agent Builder** を対象とし、単に「Elastic Agent」を作るという表現は採らない。

### Elastic 公式の事実（2026-07 時点、一次情報は elastic.co / IR / elastic org GitHub）

- Agent Builder は **Elastic 9.3 で GA**（Technical Preview は 9.2）。**Enterprise ティア**。
  Elastic Cloud Serverless / Hosted / self-managed で利用可。
- **ネイティブ A2A サーバ**を持つ: agent card `GET /api/agent_builder/a2a/{agentId}.json`、
  実行 `POST /api/agent_builder/a2a/{agentId}`（API キー認証）。**現時点でストリーミング非対応**
  （同期 `message/send` で完了後に全文返す）。Google **ADK ↔ A2A** の公式連携ガイドがある。
- **ネイティブ MCP エンドポイント** `{KIBANA_URL}/api/agent_builder/mcp` を持ち、全ツールを公開。
  スタンドアロンの `elastic/mcp-server-elasticsearch` は**公式だが deprecated**（後継が上記）。
- LLM 接続は Gen AI コネクタ経由（OpenAI / Bedrock / Azure / **Google Gemini** 等）。
- REST API `POST /api/agent_builder/converse(/async)`、Agents/Tools/Conversations の CRUD あり。
  専用 Python/JS SDK は未整備（生 REST か MCP/A2A 経由）。

### SANBA の現状（ゼロベース検討の起点）

- **SANBA は既に「ES に接続したエージェント」を持っている。** ADK チーム（ADR-0002）と音声エージェントは
  `search_grounding` ツールで `sanba-grounding` 索引をハイブリッド検索する（ADR-0003、
  `apps/agent/.../retrieval.py`）。つまり要望の素朴な読み「ES 接続エージェントを作る」は**新規性がない**。
- ES 用途は 2 つ: (A) grounding（ベクトル検索、ADR-0003）、(B) セッションコスト/KPI 分析 BI
  （`sanba-analytics-*` + Kibana、ADR-0061）。**両者は同一クラスタ同居**の設計。
- **全 AI 呼び出しは Gemini（Vertex AI）に統一**（ADR-0061）。推論スタックの一貫性は明示的な設計原則。
- ES は開発 8.14.3（compose 単一ノード）、本番は**外部 Elastic Cloud 前提で Terraform は作らない**。
  接続情報が空なら **in-memory 縮退**で動く（テスト・デモを止めない設計、ADR-0003）。
- **A2A / runtime MCP は未実装**。ただし PR #445「A2A 委譲境界（初弾 repo-scout）」が提案済みで、
  ADR-0046 段階2 の発展形として方向性は既にある。MCP は現状 Figma デザイン用途のみ（ADR-0011）。

### 前提ギャップ（本質的な判断材料）

Agent Builder は **Elastic 9.3+ / Enterprise ティア**を要求する。SANBA は 8.14.3 かつ本番 ES は
「持ち込み Elastic Cloud（無ければ in-memory 縮退）」という緩い前提で動いている。Agent Builder 採用は
**(1) 9.3+ へのスタック更新**と **(2) Enterprise ティアの費用**という、機能追加とは別次元のコミットを伴う。
これを「エージェントを 1 つ作る」の一言で飲み込んではいけない。

## ゼロベースでの問い直し — 「そもそもこの企画は本質的か」

要望を鵜呑みにせず、価値・重複・必然性・接続様式の 4 点で問い直す。

1. **何の課題を解くのか。** 「ES に繋いだエージェントが欲しい」は手段であって課題ではない。
   本質的な課題候補は 3 つ: (α) ADR-0061 の分析データ（コスト/KPI）を**管理者が自然言語で問える**
   会話型 BI が無い（Kibana ダッシュボードは定型可視化のみ）、(β) grounding 検索が固定クエリで
   **エージェンティックな絞り込み**（索引選択・ES\|QL 生成の反復）をしていない、(γ) ADR-0061 P5 の
   ナレッジ還元ループ（過去 transcript を分析して grounding KB / check_items へ）が未実装。
   → 「エージェントを作る」より、この 3 課題のどれを解くかを先に固定すべき。
2. **既存資産と重複しないか。** (α) は Kibana と補完的（定型 vs 探索的）。(β) は `search_grounding` の
   **強化**であって別エージェントを立てる話とは限らない。安易に「別 AI」を足すと `search_grounding` と
   二重管理になる。境界を切らねば重複は必至。
3. **なぜ「別エージェント」でなければならないか。** 別エンティティにする必然性は「**責務と運用境界の分離**」
   に尽きる。分析 BI は管理者向け read-only・低頻度・latency 非依存で、要件インタビュー（音声・低遅延・
   マルチテナント）とは SLA も権限もデータ可視範囲も違う。**同じプロセス・同じ権限に混ぜない**ための
   分離なら正当。単に「エージェントが増えると格好いい」なら不要（CLAUDE.md「薄いエージェント禁止」）。
4. **A2A である必然性とレイテンシ制約。** A2A は「外部フレームワークが Elastic エージェントを
   オーケストレーションする」ための標準で、SANBA の ADK が**クライアント/オーケストレータ**、Elastic が
   **A2A サーバ**という向きが自然（Elastic 公式の ADK 連携ガイドと一致）。ただし Elastic の A2A は
   **ストリーミング非対応の同期呼び出し**。音声の即応（barge-in、往復 < 1.5s、ADR-0002）に
   **直結してはならない**。委譲は必ず ADK 分析層から**音声ループ外の非同期**で行う（ADR-0046 の型）。
   これを外すと音声体験が壊れる — 設計の合否を分ける制約。

**結論（企画の是非）**: 「ES 接続エージェントを新規に作る」という素朴版は、既存の `search_grounding` と
重複し新規性が薄く、**そのままでは本質的でない**。一方で、(a) **分析データへの会話型 BI**（管理者価値・
低リスク・latency 非依存）を初弾に据え、(b) それを**エンジン非依存の A2A/MCP seam の背後**に置き、
(c) 将来 grounding 強化・P5 ナレッジループへ広げる、という**境界先行・段階拡張**の形にすれば本質的かつ
拡張性がある。企画は「正しくできる」が、**フレーミングの修正（用語・作る対象・接続点・前提コスト）が前提**。

## 決定

### 1. 別ディレクトリ `elastic-agent/` を bounded context として新設する

`apps/*`（Cloud Run デプロイ対象の web サービス）でも `packages/*`（アプリ間共有ライブラリ）でもなく、
**Elastic 側 AI エージェントと SANBA の接続境界**という独立した関心事なので、リポジトリ直下に
`elastic-agent/` を置き境界を可視化する（配置の是非は ADR-0050 の系譜で本 ADR に記録）。SANBA 側の
成果物は次の 4 つに限る。**エージェント runtime の自作はしない**（Agent Builder の作り直しは
「薄いエージェント」アンチパターンかつ車輪の再発明）。

- **宣言的定義** `definitions/`（agent・tool を JSON で版管理。Agent Builder へ provision する原本）
- **冪等プロビジョニング** `provision.py`（Agent Builder API へ upsert。ADR-0061 `analytics_setup.py`
  と同じ「存在確認 → 作成/更新」+ fail-soft + urllib の流儀）
- **A2A/MCP seam アダプタ** `a2a_client.py` / `contract.py`（SANBA 側から Elastic エージェントを
  呼ぶ薄いクライアント。純粋な組み立て/解析はネットワーク非依存で単体テスト）
- **境界ドキュメント** `README.md` と本 ADR

### 2. seam は A2A + MCP の標準契約にし、エンジン非依存にする

SANBA ↔ Elastic の結合面は **A2A（エージェント間）** と **MCP（ツール/データ）** の標準に限定する。
これにより背後のエンジンを **Agent Builder（GA・ターンキー）** と **自前実装（`elasticsearch-py` +
Gemini、ADR-0003 の資産を流用）** の間で差し替え可能にする。前提ギャップ（9.3+ / Enterprise）で
Agent Builder が重すぎると判明しても、同じ seam のまま自前エンジンへ後退できる — これが拡張性と
デリスクの要。

### 3. 既定 OFF の feature flag と未設定時 no-op 縮退

`elastic_agent_enabled` を既定 **OFF**（ADR-0007 GitHub コネクタの流儀）。`kibana_url` / API キー未設定時は
**no-op**（ADR-0003 の in-memory 縮退と同じく、テスト・デモ・クリティカルパスを止めない）。本番配線前でも
CI・ローカルが緑のまま回る。

### 4. 音声クリティカルパスに載せない（非同期・off-loop 委譲）

Elastic への A2A 呼び出しは**必ず ADK 分析層から音声ループ外の非同期**で実行する（ADR-0046/0002）。
Elastic A2A の同期・非ストリーミング制約下でも会話は止まらない。音声エージェントへは結果を
コンテキストに戻す既存経路（ADR-0002）を再利用する。

### 5. 初弾ユースケースは「分析データへの会話型 read-only エージェント」

`sanba-analytics-*`（ADR-0061）に対する**管理者向け会話型 BI**（「今週最もコストの高いセッションは」
「プロダクト X の承認要件 1 件あたりコストは」等を自然言語 → ES\|QL）を初弾に据える。理由: **最も
低リスク**（read-only・latency 非依存・音声パス非接触）、**既存 BI と補完的**（Kibana=定型、
エージェント=探索的）、**ADR-0061 の管理者要望に直結**、**データが既にある**（`sanba-analytics-events`）。
grounding 強化（β）と P5 ナレッジループ（γ）は seam 確立後の後続フェーズに回す。

### 6. 観測性を最初から通す

A2A/MCP 呼び出しに Cloud Trace span を張り、失敗はメトリクス化する（ADR-0051 の統一規律。
「観測できないものは運用できない」）。委譲の成否・レイテンシ・トークン費（Elastic 側 LLM を Gemini
コネクタにすれば ADR-0061 の単価表に載る）を計上できる形にする。

### 7. エンジン選定は本 ADR では固定せず、seam の背後で段階選択する

Agent Builder 採用（9.3+ / Enterprise の費用対効果）は**人間が判断する経営判断**（CLAUDE.md 原則1）。
本 ADR は **Phase 0（境界・seam・flag OFF スケルトン）までを Accepted 可能な粒度**で提案し、
エンジン確定は Phase 1 着手時に判断材料（費用・9.3 更新工数・自前実装との比較）を添えて別途下す。
推奨は「まず自前 seam を確立し、Enterprise 契約が正当化される規模になったら Agent Builder へ寄せる」。

## 検討したが採用しなかった選択肢

- **何もしない（`search_grounding` の強化のみ）**: 最小コスト。分析データへの会話型アクセス（α）と
  A2A という将来の相互運用点（PR #445 の一般化）は得られない。ベースラインとして常に比較対象に置くが、
  オーナーの A2A 接続要望に応えない。
- **Elastic Agent（データシッパー）を導入**: 用語取り違え。観測性が Google ネイティブで完結しており不要。却下。
- **Agent Builder を音声パスに直結**: Elastic A2A が同期・非ストリーミングのため音声の即応が壊れる。却下
  （決定4 の理由）。
- **自前フル実装のみ（Agent Builder を一切使わない）**: `elasticsearch-py` + Gemini + 自作 A2A サーバ。
  制御は最大だがオーケストレーション・関連性チューニング・A2A サーバ実装を全部自前で持ち、
  「薄いエージェント」に転落するリスク。seam の背後の**一選択肢**としては残すが、唯一解にはしない。
- **スタンドアロン `elastic/mcp-server-elasticsearch` に依存**: 公式だが deprecated（critical security
  update のみ）。新規採用は Agent Builder MCP エンドポイントへ寄せるべき。却下。
- **Langfuse 等の別 BI/エージェント基盤を足す**: ADR-0061 で既に却下済み（Gemini 統一・既存 Elastic Cloud
  との重複）。踏襲。
- **`packages/sanba_shared` に混ぜる**: 共有ライブラリの責務（agent/api/worker 横断のドメインモデル）と、
  外部エージェント境界の関心が混ざる。境界可視化のため独立ディレクトリにする。

## 影響

- **新ディレクトリ** `elastic-agent/`（uv パッケージ `sanba-elastic-agent`）を追加。CI（`ci.yml` の
  lint+test ジョブ）と `justfile`（test/lint）に配線する。**Cloud Run デプロイ対象ではない**ため
  `deploy.yml` には現時点で追加しない（Phase 1 でサービス化が必要になれば別途）。
- **`.env.example`** に `ELASTIC_AGENT_ENABLED` / `ELASTIC_AGENT_KIBANA_URL` / `ELASTIC_AGENT_API_KEY` /
  `ELASTIC_AGENT_ID` / `ELASTIC_AGENT_ANALYTICS_INDEX` を追記（既定 OFF・空）。シークレットはコミットせず
  Secret Manager 運用（CLAUDE.md セキュリティ）。
- **前提コスト**: Agent Builder 採用時は Elastic **9.3+ へのスタック更新**と **Enterprise ティア費用**が
  発生する。Phase 1 の判断材料として明示する（本 ADR ではコミットしない）。
- **セキュリティ**: Elastic 側エージェントの ES 権限は分析索引 read-only に最小化（`sanba-analytics-*`）。
  マルチテナントの可視範囲は grounding の cross-tenant leak 防止（ADR-0003 の session/product スコープ）と
  同水準を要求。A2A/MCP は API キー認証・最小権限で配線する。
- **テスト**: seam の純粋ロジック（URL 組み立て・定義 validation・A2A ボディ生成/応答解析・no-op 縮退）を
  ネットワーク非依存で単体テスト。fail-soft（未設定・接続失敗で本処理を止めない）を明示的にテストする。
- **観測性**: 委譲呼び出しの span・失敗メトリクスを追加（Phase 1、ADR-0051 の型）。

## 段階実装（フォローアップ、対応 issue に詳細タスクを置く）

- **Phase 0（本 PR）**: 境界ディレクトリ + A2A/MCP seam の契約とアダプタ + 宣言的定義 + 冪等プロビジョニング
  + `elastic_agent_enabled` 既定 OFF + 単体テスト + 本 ADR。**外部 Elastic 依存は起動せず**、CI 緑のまま。
- **Phase 1**: エンジン選定（Agent Builder vs 自前）を費用込みで判断 → 分析会話エージェントを provision、
  ADK 分析層から off-loop で A2A 委譲、観測性計装。flag ON はステージングから。
- **Phase 2**: grounding の agentic 検索強化（β）/ ADR-0061 P5 ナレッジ還元ループ（γ）へ seam を拡張。
- **Phase 3**: 音声エージェント ↔ Elastic エージェントの ADK 委譲（非同期・音声パス非接触）を有効化。
  PR #445 の A2A 委譲境界と統合。
