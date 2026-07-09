# ADR-0061: セッション単位の AI コスト・KPI 分析イベント基盤（Elasticsearch + Kibana）

- ステータス: Proposed
- 日付: 2026-07-09
- 関連: [ADR-0003](0003-elasticsearch-grounding.md)（Elasticsearch grounding — 本基盤が同居・還元する先のクラスタ）/
  [ADR-0005](0005-llm-judge-eval-loop.md)（LLM ジャッジ採点 — KPI の品質スコア源）/
  [ADR-0009](0009-local-compose-split-and-cost.md)（本番コスト最適化 — インフラ費の先行判断。本 ADR は AI 従量費を扱う）/
  [ADR-0051](0051-google-native-observability-and-llmops.md)（OTel 統一と LLMOps — 計装・ログベースメトリクスの土台）/
  [ADR-0056](0056-auto-finalize-on-disconnect.md)（セッション終了 close callback — 集計フックの挿入点）/
  [ADR-0059](0059-inquiry-logic-tree.md)（確認事項ロジックツリー — 深掘り KPI の源泉）
- きっかけ: オーナー要望「1 会話セッション〜要件確定までの AI コストを合計で出し、コスト/セッションで
  管理者が把握したい」。追って P4（要件品質 KPI との突合）・P5（ナレッジのブラッシュアップループ）の
  将来要望が示され、それらを考慮した基盤設計が必要になった。

## コンテキスト

### 要望の全体像（P0〜P5）

| 優先度 | 要望 |
|---|---|
| P0 | 会話セッション毎の AI コスト合計（$ / ¥）を管理者が把握できる |
| P1 | セッション毎のコスト内訳（どのモデル・どの処理にいくら） |
| P2 | セッション横断の合計・詳細のドリルダウン分析（BI） |
| P4 | 「正確な要件を作り出せたか」の KPI（セッション数・深掘り回数・要件ノード数等）をコストと同じ基盤で突合 |
| P5 | 過去の会話ログ・要件を定期分析し、対象プロダクト固有のナレッジを蓄積、深掘り観点（check_items）の増減・修正へ還元 |

アプリ画面は不要（管理者が見られれば良い）。ハッカソン文脈での技術選定の説得力も評価軸に含む。

### 現状: トークン usage はどこでも取得していない

AI 呼び出しは全て Gemini（Vertex AI）に統一されているが、usage/コストの取得・記録は皆無:

| 発生源 | モデル | 実装 | usage 取得 |
|---|---|---|---|
| 音声対話（speech-to-speech、入出力文字起こし込み） | `gemini-live-2.5-flash-native-audio` | `apps/agent` `build_realtime_model`（LiveKit `google.beta.realtime.RealtimeModel`） | 未取得 |
| ADK チーム（NFR/Scope/Contradiction）・会話分析・LLM ジャッジ採点 | `gemini-2.5-flash` | `apps/agent`（`agent_team` / `tools/analysis` / `evaluation`） | 未取得 |
| タイトル生成 | `gemini-2.5-flash` | `apps/api` `titles` | 未取得 |
| 画像・動画解析（vision） | `gemini-2.5-flash` | `sanba_shared.media`（api / worker から） | 未取得 |
| 埋め込み（資料取り込み・検索） | `gemini-embedding-001` | `sanba_shared.grounding` | 未取得 |
| LiveKit Cloud（接続分数・agent session 分数・Krisp BVC） | — | トークンでなく**分数課金** | 未取得 |

なお「STT」は独立サービスではない。文字起こしは Gemini Live 内蔵の `AudioTranscriptionConfig` であり、
Live API のトークンとして一体課金される。

### 公式一次情報の調査で確定した制約（2026-07 時点）

Google（cloud.google.com / adk 公式）・Elastic（elastic.co）・LiveKit（docs.livekit.io）の公式ドキュメント
とブログを横断調査した。設計を規定する事実は次の 5 点。

1. **支配的コストである Gemini Live の音声トークンは、どの製品の自動計装でも取れない**。
   Google の billing ラベルは `generateContent`/`streamGenerateContent` のみで Live API
   （`bidiGenerateContent`）対象外。ADK 公式の BigQuery Agent Analytics プラグインは ADK イベントが
   対象（音声セッションは LiveKit 側で ADK を通らない）。Elastic の GCP Vertex AI 統合・EDOT 自動計装は
   streaming/async 非対応かつ session 粒度を持たない。**アプリ側でイベントを組み立てる層はどの選定でも必須**。
2. **取得手段は公式に存在する**。Live API はサーバーメッセージ `usageMetadata` で
   モダリティ別（AUDIO/TEXT）トークン内訳をターン毎に返し
   （<https://ai.google.dev/api/live>）、LiveKit Agents はそれを `RealtimeModelMetrics` に
   マップして emit する。セッションレベル集計は `session_usage_updated` イベント /
   `session.usage.model_usage` が現行推奨（旧 `UsageCollector` + セッションレベル
   `metrics_collected` は deprecated。<https://docs.livekit.io/agents/ops/logging/>）。
   テキスト系は各応答の `resp.usage_metadata` を読むだけで取れる。
3. **単価**（Vertex AI 価格表 <https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>、$/1M tokens）:
   Live API は音声入力 $3.00 / **音声出力 $12.00** / テキスト入力 $0.50・出力 $2.00。
   `gemini-2.5-flash` はテキスト入力 $0.30 / 出力 $2.50。`gemini-embedding-001` は $0.15。
   音声は 32 tokens/秒。さらに Live API は**ターン毎に蓄積文脈を再処理して課金**するため、
   床値計算は実課金と数倍ズレる（30 分セッションの目安レンジ $0.9〜$4.4、支配項は音声出力単価と
   文脈再処理）。→ **実測（usageMetadata の合算）以外に正確なコストを出す方法はない**。
4. **請求実額との突合は `generateContent` 系に限り公式手段がある**。Vertex AI はリクエストに
   billing 用 `labels`（例 `session_id`）を付けられ、BigQuery billing export（Detailed）の
   `labels` に反映される（<https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/add-labels-to-api-calls>）。
   Live API・embeddings は対象外、粒度は 1 時間・反映遅延あり。
5. **Elastic は「構造化コストイベントを index して Kibana/ES|QL で BI」を公式レシピとして公開している**
   （単価 lookup index + `LOOKUP JOIN` で USD 算出。<https://www.elastic.co/observability-labs/blog/esql-llm-opentelemetry-debugging>）。
   Kibana は既存の Elastic Cloud デプロイメントに同梱で追加インフラ不要。

### P4/P5 を考慮したときの追加条件

- P4 の KPI 素材はほぼ既存: 要件ノード数 = `finalized_count` / `finalized_requirement_ids`、
  深掘り回数・解消率 = InquiryNode（kind × status、ADR-0059）、品質スコア = `session_scored`
  （LLM ジャッジ、ADR-0005/0051）。**コストと KPI を同一ドキュメントに結合**すれば
  「承認要件 1 件あたりコスト」等の効率指標が出せる。
- P5 の分析対象である **transcript は現状永続化されておらず、セッション終了と同時に消える**
  （agent プロセス内のメモリのみ。残るのは `conversation_summary` と要件・InquiryNode）。
  機構は後から作れるが、データは今保存を始めない限り将来存在しない。
- P5 の還元先は既にデータ化されている: 深掘り観点は `product.check_items`（Firestore、ADR-0043/0055/0057
  系譜）、プロダクト固有ナレッジの置き場は ES grounding KB（ADR-0003）。

## 決定

**「コスト収集機構」ではなく「セッション分析イベント基盤」として作る。** コストは最初のイベント種別に
すぎず、P4 の KPI・P5 のナレッジ分析が同じ基盤に載る。

### 1. イベント層（sanba_shared に一元化、全選定共通の必須部品）

- `packages/sanba_shared` に **単価テーブル**（モデル × モダリティ × 入出力、$/1M tokens。改定時は
  ここだけ更新）と **イベント組み立て**を置き、agent / api / worker が共有する。
- イベントは汎用エンベロープ:
  `{event_type, session_id, product_id, interview_mode, occurred_at, payload}`。
  - `event_type: ai_usage` … 1 AI 呼び出し（または Live のターン集計）毎。
    `component`（live_audio / adk_team / analysis / judge / title / vision / embedding）、
    `model`、モダリティ別トークン内訳、`estimated_usd` を payload に持つ。
  - `event_type: session_summary` … セッション終了時に 1 件。コスト合計（component 別内訳）と
    **P4 KPI**（`finalized_count`・InquiryNode の kind×status 集計・`session_scored` スコア・
    セッション時間・LiveKit 分数由来の推定インフラ費）を**同一ドキュメントに結合**する。
  - `product_id` は初日から全イベントに付与する（P5 の分析主軸。後からの遡及付与は不可能）。
- 取得点:
  - 音声: `AgentSession` の `session_usage_updated` を購読し、終了時に `session.usage.model_usage`
    で突合（deprecated API は使わない）。
  - テキスト系: 各 `generate_content` / `embed_content` の `resp.usage_metadata` を読む。
    ADK 実行はイベントの usage_metadata を合算する。
  - LiveKit 分数: セッション終了時に経過時間 × 単価（接続分数・agent session・Krisp BVC）で推定。
- 排出は二重化する: **(a) 構造化ログ**（`ai_cost_event` / `session_cost_summary`、structlog）と
  **(b) Elasticsearch への直接 index**。(a) は Cloud Logging に乗るため、将来 BigQuery ログシンクを
  Terraform 数行で後付けでき、アプリ再計装なしで分析基盤を増設できる（P5 の重いバッチ分析へのヘッジ）。
  イベント排出は fail-soft（本処理を止めない）を既存観測コードの流儀（ADR-0051）に合わせる。

### 2. 出口: Elasticsearch + Kibana を BI の主軸にする

- 既存 Elastic Cloud クラスタ（ADR-0003 の grounding と同居）に**専用インデックス**
  `sanba-analytics-*`（データストリーム、ILM で保持期間を設定）を切り、Kibana（同梱・追加インフラ不要）
  の Lens / ES|QL で P0（セッション毎合計）/ P1（内訳）/ P2（横断分析）/ P4（コスト × KPI 相関、
  「承認要件 1 件あたりコスト」）を可視化する。
- 選定理由: (a) 追加インフラゼロ（Kibana 同梱）、(b) Elastic 公式が同構成をコスト分析レシピとして
  実演済み、(c) grounding（ベクトル検索）と可観測性を 1 クラスタで使う構成はハッカソンのスポンサー
  文脈でも説得力がある、(d) P5 のナレッジ還元先（grounding KB）と分析基盤が同一クラスタになり
  ループが閉じる。
- grounding との同居リスク（リソース競合）は、コストイベントが低頻度・小容量であること、ILM で
  保持期間を切ることから許容する。

### 3. GCP ネイティブの補強 2 点

- `generateContent` 系呼び出し（タイトル・vision・分析・採点・ADK）に
  `labels={"session_id": ..., "product_id": ...}` を付与し、BigQuery billing export（Detailed）で
  **請求実額ベースのセッション別集計**を可能にする。イベント層の「推定コスト」と請求実額を突合できる
  体制は、指標をハックしない原則（推定値の正しさを外部データで検証できる）に沿う。
  Live API が対象外である制約は上記の通りで、Live 分は実測 usage × 公式単価の推定が唯一の手段。
- `session_cost_summary` ログに log-based metric を張り、既存の品質ダッシュボード
  （`infra/terraform/observability.tf`、ADR-0051 の型）へコスト/セッションのタイルと
  **コスト異常アラート**を追加する（コストガードレール）。

### 4. transcript の永続化を本スコープに含める（P5 の前提）

セッション終了時に transcript 全文を永続化する（GCS または Firestore サブコレクション。
形式・置き場は実装 PR で確定）。保持期間・PII は `docs/reference/security.md` の方針と
ゲストセッション 30 日 TTL（ADR-0014 系）に整合させる。**これだけは後回しにできない**
（保存しなかった期間のデータは P5 で取り戻せない）。

### 5. P5 への拡張パス（本 ADR では実装しない）

データが貯まった後、定期バッチ（Cloud Scheduler → worker の Cloud Tasks パターン、ADR-0040 の型）で
過去セッションを LLM 分析し、(a) プロダクト固有の気づきを grounding KB へ index（次セッションの検索に
自動で乗る）、(b) `product.check_items` の増減・修正**提案**を生成する。(b) は自動適用せず人間が承認する
（CLAUDE.md 原則 1「設計判断とレビューは人間が行う」。観点はインタビューの振る舞いを直接変えるため、
無人書き換えは指標ハックの温床になる）。P5 の詳細設計は着手時に別 ADR とする。

## 検討したが採用しなかった選択肢

- **Langfuse を BI の主軸にする**: 当初の第一候補。ADK 公式統合（OTel ベース）があり、セッション
  グルーピング・トレースウォーターフォール・コスト表示の UI は単体では最良。しかし (a) セルフホストは
  v3 以降 ClickHouse 等が必要で重く、現実解はマネージド SaaS になりデータ持ち出しの説明責任
  （transcript を送らないメタデータ限定運用等）が発生する、(b) 支配的コストの Gemini Live は
  結局自前 ingest が必要で「組み込みで楽」の利点が主戦場で効かない、(c) 既に本番稼働している
  Elastic Cloud + 同梱 Kibana と比べ、新規外部コンポーネント追加に見合わない。トレース可視化が
  欲しくなったら OTLP の送り先を 1 つ足すだけなので、後付けの余地は残る。
- **GCP ネイティブのみで完結（BigQuery + Looker Studio / BigQuery Agent Analytics / billing export）**:
  billing export + リクエストラベルは請求実額が取れる唯一の手段だが Live API 非対応・1 時間粒度・
  反映遅延があり、P0 の主役になれない。BigQuery Agent Analytics（Preview）は ADK イベント限定で
  音声セッションを通らない。よって「補強」（決定 3）として採用し、主軸にはしない。
  将来ログシンクで BigQuery を足す拡張パスは決定 1 の二重排出で確保済み。
- **Cloud Monitoring / Cloud Trace のみ**: Vertex AI の組み込みメトリクスはモデル・モダリティ
  ディメンション止まりでセッション別に分解できない。Cloud Trace の GenAI 対応（gen_ai semconv）は
  トークンまでで金額化・BI 機能がない。ガードレール（アラート）用途に限定して採用する。
- **Grafana**: ローカルの可観測性スタックには既にあるが、本番 Grafana が存在せず新設が必要。
  Prometheus で `session_id` ラベルを持つのは高カーディナリティのアンチパターンで、P1/P2 に不向き。
- **コスト専用スキーマ（`ai_cost_event` 単能）で作る**: P4/P5 が来た時点でスキーマ・インデックスの
  作り直しになる。エンベロープ化と `product_id` 全件付与のコストは初期実装ではほぼゼロなので、
  汎用化を初日から採る。
- **アプリ画面（web）でのコスト表示**: 管理者が把握できれば良いという要望のため作らない。
  将来必要になれば `GET /api/sessions/mine` への項目追加で足せる。
- **OTel GenAI semantic conventions への全面準拠**: semconv が development 段階でフィールド名変更
  リスクがある。イベントスキーマは自前定義とし、`gen_ai.usage.*` 互換の属性名を参考にする程度に
  留める（安定化したら追随を検討）。

## 影響

- **観測性**: 全 AI 呼び出しが usage 付きで観測されるようになる（現状ゼロからの改善）。
  `session_cost_summary` の log-based metric・コスト異常アラート・ダッシュボードタイルを
  `infra/terraform/observability.tf` に追加する（IaC 必須、手作業でダッシュボードを作らない）。
- **IaC**: Terraform 追加は log-based metric / アラート / （billing export 用の BigQuery dataset を
  有効化する場合はその設定）。ES インデックステンプレート・ILM は grounding KB シードと同様に
  冪等スクリプトで管理する。
- **テスト**: 単価テーブルとコスト計算は純粋関数として単体テスト。イベント組み立ては
  usage_metadata のフィクスチャで検証。`session_usage_updated` 経由の集計は agent の結合テストに
  乗せる。fail-soft（イベント排出失敗で会話が止まらない）を明示的にテストする。
- **コスト運用**: 単価テーブルは価格改定時に手動更新が必要（改定検知は billing 実額との乖離
  アラートで補足できる）。¥ 表示は固定レート設定値とする。イベント自体の保存コストは低頻度・
  小容量で無視できる規模。
- **プライバシー/保持**: transcript 永続化により会話全文がデータストアに残る。
  `docs/reference/security.md` の PII・保持期間方針への追記と、ゲスト 30 日 TTL との整合を
  実装 PR に含める。
- **段階実装**（フォローアップ、対応 issue に詳細タスクを置く）:
  1. P0: イベント層（単価テーブル・`session_usage_updated`・`usage_metadata`）+ Firestore への
     セッション合計書き込み + log-based metric/アラート + transcript 永続化
  2. P1/P2: ES `sanba-analytics-*` index + Kibana ダッシュボード（Lens / ES|QL、単価 lookup）
  3. P4: `session_summary` への KPI 結合と効率指標（承認要件 1 件あたりコスト）
  4. 補強: `generateContent` 系への billing ラベル + BigQuery billing export 突合
  5. P5: 別 ADR（定期分析ジョブ・KB 還元・check_items 提案）
