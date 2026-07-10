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
重複し新規性が薄く、**そのままでは本質的でない**。一方で、(a) **境界が分離された別環境のエージェントと
A2A で連携できることを示す最初の一歩**を主眼に据え、(b) それを**エンジン非依存の A2A/MCP seam の背後**に
置き、(c) 将来へ段階拡張する、という**境界先行・段階拡張**の形にすれば本質的かつ拡張性がある。
企画は「正しくできる」が、**フレーミングの修正（用語・作る対象・接続点・前提コスト）が前提**。

オーナー方針（2026-07-09）で初弾の具体は次のように定まった: エンジンは **Elastic Agent Builder** を採用し、
初弾エージェントは分析データ（コスト/KPI）ではなく、**アプリのソースコードだけでは知り得ない外部の状況・
経歴・システム用の外部要件を記述したファイル**を知識として持つ「外部コンテキスト・エージェント」とする。
狙いは特定データの分析ではなく、**分離された境界の向こうのエージェントと A2A で会話できることの実証**。
要件インタビュー（SANBA 本体）は、コードからは分からない外部前提を、この境界越しのエージェントに
A2A で問い合わせて補える——という将来像に素直に接続する。

## 決定

### 1. 別ディレクトリ `external-agents/` を bounded context として新設する（プロバイダー非依存の命名）

`apps/*`（Cloud Run デプロイ対象の web サービス）でも `packages/*`（アプリ間共有ライブラリ）でもなく、
**境界の向こうの AI エージェントと SANBA の接続境界**という独立した関心事なので、リポジトリ直下に
`external-agents/`（uv パッケージ `sanba-external-agents`）を置き境界を可視化する（配置の是非は
ADR-0050 の系譜で本 ADR に記録）。

**命名をプロバイダーに固定しない。** 初弾プロバイダーは Elastic Agent Builder だが、将来 AWS
（Bedrock AgentCore / Strands）や Google ADK もあり得る。`elastic-*` に固定するとプロバイダー選定を
縛るため、境界の概念（外部エージェント）を名前に採る。**プロバイダー非依存の seam を上位に、
プロバイダー固有アダプタをサブパッケージに隔離**する（「汎用名でプロバイダーを隠す」のではなく
「汎用 seam + プロバイダー明示」がプロバイダー固定を本当に避ける形）:

- **プロバイダー非依存の seam**（`src/sanba_external_agents/`）: `a2a_client.py`（A2A の JSON-RPC 2.0
  `message/send` 組み立てと応答解析の純関数）。A2A はオープン標準なのでプロバイダー横断で共通。
- **プロバイダー固有アダプタ**（`src/sanba_external_agents/elastic/`）: `contract.py`（エンドポイント
  URL 契約。Kibana Agent Builder の `api/agent_builder/*`・`kibana_url`・space に固有なので**汎用扱い
  しない**）、`config.py`（`ELASTIC_AGENT_*`）、`client.py`（A2A 委譲クライアント）、`provision.py`
  （Agent Builder へ冪等 upsert。ADR-0061 `analytics_setup.py` と同じ「存在確認 → 作成/更新」+ fail-soft
  + urllib の流儀）、`catalog.py` + `definitions/`（agent・tool を JSON で版管理。provision の原本）、
  `sample-data/`（外部要件ファイル例）。
- 将来のプロバイダーは `elastic/` と同階層に `aws/`・`google_adk/` を並べ、その配下に各社の URL 契約を
  持つ（エンドポイントパスはプロバイダーごとに異なるため、汎用化するのは A2A 部品のみ）。

**エージェント runtime の自作はしない**（Agent Builder の作り直しは「薄いエージェント」アンチパターン
かつ車輪の再発明）。境界ドキュメントは `README.md` と本 ADR。

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

### 5. 初弾ユースケースは「外部コンテキスト・エージェント」（A2A 越境の実証）

Elastic Agent Builder で、**アプリのソースコードだけでは知り得ない外部前提**——外部の状況・経歴・
組織や運用の事情・システム用の外部要件を記述したファイル群——を知識として持つ、シンプルな read-only
エージェントを初弾に据える。イメージは「対象アプリの**外側**の関連情報を持つ小さな AI エージェント」。
`search_grounding`（アプリ内・セッション文脈）とは**知識の出所が異なる**ため重複しない。

- 実装は Agent Builder のツール（`index_search` / ES\|QL）で `sanba-external-context` インデックスを
  引く。索引の中身は外部要件ファイルを取り込んだもの。Agent Builder は ES ネイティブなので当面 ES を
  裏に置くが、**接続データが ES である必然性は薄い**——将来は Agent Builder の外部 MCP ツール・
  connector・attachment に差し替えてよい。seam はデータ源に非依存。
- **狙いは分析ではなく A2A 越境の実証**。「分離された境界の別環境エージェントと A2A で会話できる」ことを
  最小構成で通す最初の一歩。read-only・音声パス非接触なので最も低リスク。
- 分析データへの会話型 BI（`sanba-analytics-*`、ADR-0061）、grounding 強化、P5 ナレッジループは、
  seam が実証できた後の後続候補として残す（本 ADR では初弾にしない）。

### 6. 観測性は委譲を起動する Phase 1 で必ず通す

A2A/MCP 呼び出しには Cloud Trace span を張り、失敗はメトリクス化する（ADR-0051 の統一規律。
「観測できないものは運用できない」）。委譲の成否・レイテンシ・トークン費（Elastic 側 LLM を Gemini
コネクタにすれば ADR-0061 の単価表に載る）を計上できる形にする。**Phase 0 はランタイム呼び出しを
起動しない**ため計装対象が存在せず、実装は flag ON にする Phase 1 と同時に入れる（§影響・段階実装参照）。
Phase 0 では失敗経路を structlog の warning に残すに留める（fail-soft の可観測な痕跡）。

### 7. エンジンは Agent Builder（オーナー方針）。ただし前提コストの判断は残す

初弾エンジンは **Elastic Agent Builder** とする（オーナー方針、2026-07-09）。ただし Agent Builder は
Elastic **9.3+ / Enterprise ティア**を要するため、**スタック更新工数と Enterprise 費用**の可否は
人間が判断する経営判断（CLAUDE.md 原則1）として Phase 1 着手時に確定する。seam をエンジン非依存に
保つ設計は維持し、費用が正当化されない場合の**自前実装（`elasticsearch-py` + Gemini）への後退余地**を
残す（デリスク）。本 ADR は Phase 0（境界・seam・flag OFF スケルトン）を提案する粒度に留める。

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

- **新ディレクトリ** `external-agents/`（uv パッケージ `sanba-external-agents`）を追加。CI（`ci.yml` の
  `external-agents` lint+test ジョブ・`quality-gate` の needs、`security.yml` の pip-audit matrix）と
  `justfile`（test/lint）に配線する。**Cloud Run デプロイ対象ではない**ため `deploy.yml` には現時点で
  追加しない（Phase 1 でサービス化が必要になれば別途）。ELASTIC_AGENT_* の env 名は Elastic 固有設定
  として据え置く（将来のプロバイダーは自分の prefix を持つ）。
- **`.env.example`** に `ELASTIC_AGENT_ENABLED` / `ELASTIC_AGENT_KIBANA_URL` / `ELASTIC_AGENT_API_KEY` /
  `ELASTIC_AGENT_ID` / `ELASTIC_AGENT_CONTEXT_INDEX` を追記（既定 OFF・空）。シークレットはコミットせず
  Secret Manager 運用（CLAUDE.md セキュリティ）。
- **前提コスト**: Agent Builder 採用時は Elastic **9.3+ へのスタック更新**と **Enterprise ティア費用**が
  発生する。Phase 1 の判断材料として明示する（本 ADR ではコミットしない）。
- **セキュリティ**: Elastic 側エージェントの ES 権限は外部コンテキスト索引 read-only に最小化
  （`sanba-external-context`）。外部要件ファイルの取り込み時は PII を持ち込まない前提とし、Phase 1 の
  取り込みパイプラインに既存 `mask_pii`（`sanba_shared`/`sanba_agent` の PII マスク）相当の技術的ガードを
  組み込む（運用申し合わせに依存しない）。委譲の質問文も、実インタビュー文脈から呼ぶ Phase 1/3 では PII
  マスク経路を通す。マルチテナントの可視範囲は grounding の cross-tenant leak 防止（ADR-0003 の product
  スコープ）と同水準を要求。A2A/MCP は API キー認証・最小権限・http(s) 限定で配線する。
- **テスト**: seam の純粋ロジック（URL 組み立て・定義 validation・A2A ボディ生成/応答解析・no-op 縮退）を
  ネットワーク非依存で単体テスト。fail-soft（未設定・接続失敗で本処理を止めない）を明示的にテストする。
- **観測性**: 委譲呼び出しの span・失敗メトリクスを追加（Phase 1、ADR-0051 の型）。

## 段階実装（フォローアップ、対応 issue に詳細タスクを置く）

- **Phase 0（本 PR）**: 境界ディレクトリ + A2A/MCP seam の契約とアダプタ + 宣言的定義 + 冪等プロビジョニング
  + `elastic_agent_enabled` 既定 OFF + 単体テスト + 本 ADR。**外部 Elastic 依存は起動せず**、CI 緑のまま。
- **Phase 1**: Agent Builder の前提コスト（9.3+ 更新・Enterprise）を判断 → **外部コンテキスト・
  エージェント**を provision（外部要件ファイルを `sanba-external-context` へ取り込み）、ADK 分析層から
  off-loop で A2A 委譲、観測性計装。flag ON はステージングから。**A2A 越境の疎通実証がこのフェーズの主眼**。
- **Phase 2**: 分析データへの会話型 BI（ADR-0061）/ grounding の agentic 検索強化 / P5 ナレッジ還元ループへ
  seam を拡張。
- **Phase 3**: 音声エージェント ↔ Elastic エージェントの ADK 委譲（非同期・音声パス非接触）を有効化。
  PR #445 の A2A 委譲境界と統合。
