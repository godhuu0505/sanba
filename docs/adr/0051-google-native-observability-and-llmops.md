# ADR-0051: 観測性・LLMOps を Google Cloud ネイティブに統一する（Cloud Trace / Cloud Monitoring / Vertex・ADK eval、Langfuse 廃止）

- ステータス: Proposed（提案中）
- 日付: 2026-07-07
- 関連: ADR-0037（バックグラウンド分析）/ ADR-0046（分析の音声からの分離）/ #376（観測性の実効化）/
  #357（本番 KB）/ #41（ハッカソン「本物が動く証拠」）

## コンテキスト

本番の観測性・評価が実効していない。`sess-2d51da04` の調査時、agent は `otel_disabled`
（`OTEL_EXPORTER_OTLP_ENDPOINT` 未設定）で分散トレースが飛ばず、散在するライブラリログの
手動再構成に頼らざるを得なかった。一方で:

- スタックは全て GCP/Vertex（Cloud Run・Vertex AI Gemini・Firestore）。`cloudtrace` /
  `monitoring` API は有効化済み、agent 実行 SA に `roles/cloudtrace.agent` /
  `roles/monitoring.metricWriter` 付与済み（`infra/terraform/main.tf`）。
- `langfuse` は依存に入っているが**本番では未配線**（Secret Manager に langfuse の箱が無く、
  `get_langfuse()` は None を返す → `score_session` の `lf.score()` は no-op）。CI（llm-eval.yml）は
  `LANGFUSE_*` を渡すが、回帰評価 `run_dataset_eval` は Langfuse を使わない。
- 実際の LLM 判定は既に Gemini/Vertex（`_llm_judge`）。Langfuse は「判定」を一切しておらず、
  トレース UI とスコア置き場の役割しか担っていない（しかもそれも本番で無効）。

つまり非 Google な依存が 1 つだけ宙に浮いており、外す/置き換えるコストは小さい。

## 決定（提案）

観測性と LLMOps を **Google Cloud ネイティブに一本化**し、Langfuse を廃する。

1. **トレース: Cloud Trace 直送**。`opentelemetry-exporter-gcp-trace` の
   `CloudTraceSpanExporter` を使い、ADC（実行 SA）で Cloud Trace へ直接エクスポートする。
   エクスポータ選択の優先順位は、(a) `OTEL_EXPORTER_OTLP_ENDPOINT` 明示時は OTLP（Collector
   サイドカー等）、(b) 未指定でも Vertex 実行（＝GCP 上・ADC あり）なら Cloud Trace 直送、
   (c) それ以外（ローカル/テスト）は無効。**インフラ増ゼロ**で本番のトレースが点灯する。
2. **オンライン品質スコア: Cloud Logging / Cloud Monitoring**。`session_scored` の構造化ログを
   基点に、ログベースメトリクス（Terraform `google_logging_metric`）→ Cloud Monitoring
   ダッシュボードで可視化する。Langfuse の `lf.score()` sink は廃止する。
3. **オフライン回帰(CI): 現行の Gemini judge を維持**。`run_dataset_eval` は Langfuse 非依存で
   そのまま動く。llm-eval.yml から死んでいる `LANGFUSE_*` env を除去する。将来の格上げ候補として
   **ADK `AgentEvaluator`**（`google.adk.evaluation`、同梱済み）や **Vertex AI Gen AI Evaluation**
   でチームの軌跡/ツール使用やルーブリック採点を行う（別 issue）。
4. **依存の撤去**: `langfuse` 依存・`get_langfuse`・`LANGFUSE_*` 設定を段階的に除去する。
   本 ADR 受理後、CLAUDE.md の「LLM出力は Langfuse の評価データセットで回帰テストする」記述を
   「Vertex/ADK eval + CI 回帰データセット」に改める。

## 理由 / 検討した代替案

- **Cloud Trace 直送 vs OTLP Collector サイドカー**: 直送はインフラ増ゼロで最小・堅牢。
  サイドカーは OTLP 抽象を保ち他バックエンドへ差し替え可能だが、Cloud Run にコンテナを 1 つ
  増やす運用コストが要る。両立できるよう「endpoint 明示時は OTLP」の分岐を残す（将来サイドカーへ
  移れる）。ハッカソン期は直送を採用。
- **Langfuse 継続 vs 廃止**: 継続は非 Google 依存とアカウント/シークレット運用を抱える。廃止は
  「全部 Google Cloud」の一貫アーキになり、#41 の審査で強い物語になる。実装フットプリントが極小の
  今が撤去の好機。LLM judge は provider 非依存（Gemini）なので評価能力は落ちない。
- **grounding backend（ES vs Firestore/Vertex ベクトル検索）**: 本 ADR の範囲外（#357 / 別 ADR）。
  ただし Google 一貫の観点では、既に使用中の Firestore のベクトル検索または Vertex AI Vector
  Search が ES より整合的、という論点を残す。

## 影響 / フォローアップ

- **観測性（原則3）**: 本 ADR の PR で Cloud Trace 直送を実装。既存スパン（`voice.reply` /
  `voice.analysis` / `sanba.events.publish`）が本番で実際にエクスポートされ、`grounding_search`
  スパンを追加する。スパン属性に生の発話/クエリ文字列は載せない（PII を Cloud Trace に出さない）。
- **IaC（要レビュー）**: ログベースメトリクス（`google_logging_metric`）と Cloud Monitoring
  ダッシュボードの Terraform を別 PR で追加（`infra/` はレビュー必須）。ES/ベクトル検索の配線も別。
- **テスト**: エクスポータ選択ロジックを純関数として単体テストする（ネットワーク不要）。
- **セキュリティ**: Cloud Trace はスパン属性経由の情報露出に注意。属性は非 PII の識別子/件数のみ。
- **ハッカソン（#41）**: Cloud Trace の音声ターン・タイムライン、品質ダッシュボード、CI 回帰ゲートが
  そのまま「本物が動く証拠」になる。
