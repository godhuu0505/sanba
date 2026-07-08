# ADR-0054: DevOps/LLMOps 成熟度ロードマップ — AI 増幅時代の安定性・安全性ゲート（プログレッシブデリバリー / エージェント評価の格上げ / SLO・エラーバジェット / ランタイムガードレール）

- ステータス: Proposed
- 日付: 2026-07-08
- 関連: [ADR-0005](0005-llm-judge-eval-loop.md)（LLM-as-judge 評価 — 本 ADR が golden 拡張・軌跡評価・モデル回帰へ格上げする）/
  [ADR-0010](0010-ai-pr-review-automation.md)（AI PR レビュー — AI 駆動開発の計測対象）/
  [ADR-0015](0015-autonomous-pr-babysitter-loop.md)（自律 babysitter — §9 の eval ゲート方針の矛盾を是正）/
  [ADR-0016](0016-cicd-strategy.md)（public 化 CI — 本 ADR が高速化・E2E・安定性ゲートを足す）/
  [ADR-0026](0026-auto-apply-terraform-on-main-merge.md)（terraform 自動 apply）/
  [ADR-0029](0029-cd-migration-on-merge.md)（migrate→deploy 順序 — 本 ADR がトラフィック分割を後段に足す）/
  [ADR-0051](0051-google-native-observability-and-llmops.md)（観測性/LLMOps を Google ネイティブ統一 — 本 ADR が SLO/アラート/メトリクス配線/ガードレールで実効化する）
- 背景文書: [devops.md](../how-to/devops.md)（現状の運用手順 — 本 ADR がコードとの乖離を洗い出す）

## コンテキスト

DORA の 2025 年版レポート（State of AI-assisted Software Development / AI Capabilities Model）は、
**AI は「増幅器（amplifier）」**であり、チームが元々持つ強みも弱みも増幅すると結論づけた。定量的には、
2024 年から反転して **AI 採用はスループットとプロダクト性能を押し上げる**一方で、**デリバリーの安定性
（変更失敗率・復旧）とは依然として負の相関**を保つ。これを打ち消すのは AI ツールそのものではなく、
周辺の技術・文化ケイパビリティ — とりわけ**強い自動テスト・成熟したバージョン管理・速いフィードバック
ループ・小さいバッチ・質の高い内部プラットフォーム**だとされる。

SANBA はこの知見の中心にいる。**AI がコードを書き（Codex 指摘 + Claude 一次対応, ADR-0010）**、
**AI プロダクト（音声マルチエージェント）を届ける**という二重の増幅対象であり、変更量が増えるほど
安定性の穴が拡大しやすい。したがって「AI で速くする」より先に、**AI 由来のスループットを不安定性に
変えないための安定性・安全性ゲート**を敷くことが最優先になる。

現状は土台が強い。棚卸しの結果、以下は**実装済み**：

- public 化した無料・無制限 CI、全 Action の commit SHA ピン、WIF キーレス OIDC、top-level
  最小権限、SBOM/SLSA provenance、`quality-gate` 集約チェック（ADR-0016）。
- オフライン回帰 eval（`llm-eval.yml` → `sanba_agent.evaluation`）、agent の Cloud Trace 直送
  （`observability.py` の `select_exporter_kind`）、`session_scored` 構造化ログ → ログベースメトリクス
  → Cloud Monitoring 品質ダッシュボード（`infra/terraform/observability.tf`、ADR-0051 を先行実装）。
- Four Keys 自己計測 collector（`infra/four-keys/`、Prometheus + Grafana）。
- コスト衛生（scale-to-zero、`cpu_idle`、Firestore TTL、Artifact Registry cleanup、GCS lifecycle）。

一方、DORA 2025 が言う「安定性を守るケイパビリティ」に照らすと、次のギャップが残る（すべて事実確認済み）：

1. **デプロイが一括即時 100% 切替**。`gcloud run deploy --image` のみで、canary / blue-green /
   トラフィック分割・ヘルス連動の自動ロールバックが無い。app のイメージ差し替えには承認ゲートも
   staging も無く、main マージで即本番。→ **変更失敗率・MTTR を悪化させる最大の構造要因**。
2. **SLO・エラーバジェット・アラートポリシー・通知チャネル・オンコールが皆無**（`google_billing_budget`
   だけ）。障害の自動検知経路が無く、インシデントは手動 Issue 起票に依存。→ MTTR を測る前提（検知）が
   欠落し、Four Keys の復旧時間が実運用を映さない。
3. **メトリクスが全アプリ no-op**（OTel カウンタは定義済みだが MeterProvider 未配線）。**API の本番
   トレースが無効**（Cloud Trace 直送パスが agent にしか無く、API は OTLP endpoint 未設定で
   `otel_disabled`）。→「観測できないものは運用できない」（原則3）に反する。
4. **LLM のトークン/コスト/レイテンシが完全未計測**（`usage_metadata` 参照ゼロ）。→ AI プロダクトの
   コスト暴走・品質劣化を数値で検知できない。
5. **ランタイムガードレール未実装**。出力の PII 漏洩・専門用語（jargon）漏れ・有害性を実行時に
   検査/ブロックする経路が無い（jargon 検知は CI のヒューリスティックのみで本番リクエストに効かない）。
   → 顧客向け LLM の最低要件（入出力ガードレール）が未達。
6. **オフライン回帰の評価カバレッジが極小**。データセットは 4 シナリオをコード直書き、判定は相対順序 +
   絶対閾値のみ。`llm-eval.yml` は `quality-gate` の `needs` に**含まれず必須ゲートではない**。モデルは
   単一固定で**モデル更新（Gemini バージョン変更）の回帰検知が構造上できない**。エージェントの軌跡
   （trajectory）・ツール使用の評価も無い。
7. **フィードバックループが遅く穴がある**。CI に uv/npm の依存キャッシュが無く毎回フル同期。`docker`
   ジョブが `quality-gate` 外で agent/api/worker の Dockerfile 破損が必須チェックを緑のまま通過しうる。
   Playwright 一式は在るが **E2E が CI 未実行**。`just test` に worker が抜けローカルと CI が乖離。
8. **AI 駆動開発そのものの計測が無い**（AI 生成コード比率・受入率・レビュー往復回数）。→ DORA/DX の
   「AI がどう効いているか」が見えず、指標改善の投資判断ができない。
9. **ドキュメント負債**。Langfuse は撤去済みだが旧 ADR 群に記述が残存。`devops.md` の「dev/prod を
   workspace 分離」「BigQuery で可視化」「concurrency 設定」はコードに裏付けが無い。ADR-0015 §9
   （eval を post-merge へ）と現行 `llm-eval.yml`（PR トリガー）が矛盾。→ 正が判別しづらい。

## 決定

**3 本柱（評価 / 可観測性 / ガードレール）**に**プログレッシブデリバリー**・**DORA 2025 準拠の計測**・
**AI-SRE 障害対応**を重ね、**小さいバッチで段階導入**する。北極星は「AI 由来のスループットを不安定性に
変えないこと」。各項目は既存資産（Google ネイティブ / Cloud Run / ADK / Four Keys collector）を再利用し、
インフラ増を最小化する。ハッカソン期の「本物が動く証拠」（#41）としても機能させる。

### フェーズ 0 — フィードバックループの即効化（低リスク・IaC 変更なし・数時間〜1 日）

DORA 2025 の「速いフィードバックループ」を最小コストで底上げする。CI ワークフローとローカルタスクの
純粋な効率・網羅の改善で、本番リスクは無い。

- CI に **uv/npm 依存キャッシュ**（`setup-uv` の `enable-cache`、`setup-node` の `cache: npm`）を入れ、
  全 Python/Node ジョブのフル同期を解消。`no-comments` と `web` の `npm ci` 二重実行を解消。
- `docker` ジョブを **`quality-gate` の `needs` に編入**（または軽量な dockerfile build 検証を必須化）し、
  agent/api/worker のイメージ破損を merge 前に落とす。
- `just test` に **worker を追加**し、ローカルと CI の検証集合を一致させる。
- Four Keys collector の**既定リポジトリ名**（`godhuu0505/ai-hackathon2`）を現行に修正、または未設定時に
  fail-fast させ、別リポの取り違えを防ぐ。
- **ドキュメント整合**（負債 9 の解消）: 旧 ADR の Langfuse 記述、`devops.md` の環境分離/BigQuery/
  concurrency、ADR-0015 §9 と `llm-eval.yml` の矛盾を是正。

### フェーズ 1 — 安定性ゲート（Cloud Run ネイティブ・要 IaC レビュー）

AI 増幅で最も壊れやすい「安定性」を守る中核。GKE や Argo を持ち込まず、**Cloud Run ネイティブの
リビジョン・トラフィック分割**で実現する（ADR-0006 の Cloud Run 継続と整合）。

- **プログレッシブデリバリー**: `deploy.yml` を `gcloud run deploy --no-traffic --tag <sha>` で
  新リビジョンをトラフィックゼロ投入 → タグ URL でスモーク → `--to-revisions` で 5% → 25% → 100% と
  段階昇格。SLO 逸脱時は前リビジョンへ `--to-revisions PREV=100`（即時ロールバック）。将来 **Cloud Deploy**
  の canary パイプラインに載せれば、トラフィック移行間の自動検証と監査証跡が付く。
- **SLO・エラーバジェット**: `google_monitoring_slo` / `monitoring_service` を IaC 化。可用性、API p95
  レイテンシ、**音声往復レイテンシ**、`session_scored` 品質スコアの下限を対象にし、エラーバジェット
  枯渇時はリリースを止める運用ルールと結ぶ。
- **アラート + 通知チャネル**: `google_monitoring_alert_policy` + `notification_channel` を IaC 化。
  エラー率急増・レイテンシ悪化・agent クラッシュ・Cloud Tasks 滞留・**品質スコア低下**を検知して
  ページングする。→ MTTR を測る前提（自動検知）を成立させる。
- **観測性の実効化**（原則3・ADR-0051 決定1の完遂）: 全アプリで **MeterProvider を配線**して no-op を
  解消、**API にも Cloud Trace 直送パス**を足して本番トレースを点灯させる。

### フェーズ 2 — AI 安全性とエージェント評価の格上げ（LLMOps 3 本柱）

顧客向け AI プロダクトの最低要件と、モデル/プロンプト変更のデグレ検知を固める。

- **ランタイムガードレール**（ギャップ 5）: 入力（プロンプトインジェクション・PII）・出力（PII 漏洩・
  jargon 漏れ・有害性・フォーマット）を実行時に検査する経路を足す。既存の `build_untrusted_fence` /
  end_user ルーブリックを本番の実行時チェックに接続する。
- **トークン/コスト計測**（ギャップ 4）: Gemini/ADK/judge 呼び出しの `usage_metadata` を取得し、
  セッション単位・モデル単位のトークン/コスト/レイテンシをメトリクス化。予算超過時の劣化制御
  （モデル降格・機能制限）の土台にする。
- **オンライン品質のアラート化**: 既存の品質ダッシュボードに alert policy を足し、`session_scored` の
  スコア分布悪化を**デグレとして検知**する（本番ドリフトの早期シグナル）。
- **評価の格上げ**（ギャップ 6・ADR-0005 の育成）: golden データセットをコード直書きから**外部ファイル化
  ＋拡張**。Vertex AI Gen AI Evaluation / ADK `AgentEvaluator` で**軌跡（trajectory）・ツール使用品質**を
  採点（`tool_trajectory_avg_score`、rubric ベースの `TOOL_USE_QUALITY` / `FINAL_RESPONSE_QUALITY`）。
  **モデルバージョンをピン**し、モデル更新用の回帰スイートで**モデル更新デグレ**を検知可能にする。judge の
  **メタ評価**（人手との一致率・温度固定・複数サンプリング）で judge 自身のキャリブレーションを担保。
  カバレッジと安定性が上がった時点で `llm-eval` を `quality-gate` の必須チェックに昇格。

### フェーズ 3 — 自律運用と AI 影響の可視化（保守運用最適化）

障害対応・保守の運用コストを AI で下げ、AI 駆動開発の効果を計測に載せる。

- **AI-SRE 階層対応**: runbook を RAG 化し、L1/L2（既知障害のトリアージ・情報収集）は AI エージェントが
  自動、**L3（不可逆操作・セキュリティ）は人間**にページング。承認を挟む「human-in-the-loop」を保つ。
- **SLO 連動の自動ロールバック**: フェーズ 1 の canary + SLO を結線し、逸脱で自動切り戻し。
- **DORA 2025 準拠の計測拡張 + DX Core 4 / AI 計測**: Four Keys を throughput / instability / reliability
  の枠組みに合わせ、**AI 生成コード比率・レビュー往復・受入率**を計測して「AI がどこを増幅しているか」を
  可視化する。指標は本質的改善のために使い、見栄えのために作らない（CLAUDE.md「指標をハックしない」）。

## 検討したが採用しなかった選択肢

- **GKE + Argo Rollouts / Flagger への移行でプログレッシブデリバリー**: 機能は強力だが、Cloud Run
  ネイティブのトラフィック分割 + Cloud Deploy で canary は十分実現でき、ADR-0006 の Cloud Run 継続とも
  整合する。クラスタ運用・パッチ・隔離の負荷はハッカソン規模に不相応。却下。
- **Langfuse / 外部 LLMOps SaaS の再導入**: 評価/トレース UI は魅力だが、ADR-0051 の「全部 Google Cloud」
  一貫方針に反し、非 Google 依存とシークレット運用を再び抱える。Vertex Gen AI Eval + Cloud Monitoring +
  Cloud Trace で代替でき、判定は provider 非依存（Gemini）。却下。
- **全項目のビッグバン一括導入**: AI が増幅する不安定性を自ら招く。DORA 2025 の「小さいバッチ」に反する。
  低リスクなフェーズ 0 から段階導入し、各フェーズで観測してから次へ進む。
- **`llm-eval` を即座に全面必須ゲート化**: judge の非決定性で CI がフレーク化し、AI 駆動開発の速度を
  逆に落とす。まず golden 拡張とメタ評価で judge を安定させ、カバレッジを確保してからゲート昇格する。
- **専用インシデント SaaS（PagerDuty 等）の即時導入**: まず Cloud Monitoring の alert policy +
  notification channel（Google ネイティブ）で検知・通知を成立させ、規模が要求した段階で外部連携を検討。

## 影響

- **観測性（原則3）**: MeterProvider 配線・API トレース点灯・トークン/コストメトリクス・SLO により、
  「観測できないものは運用できない」を実効化する。トレース属性は引き続き**非 PII の識別子/件数のみ**
  （生の発話・プロンプト・出力は載せない）。
- **IaC（要レビュー）**: SLO・アラート・通知チャネル・トラフィック分割・ログベースメトリクスは
  `infra/` 変更＝**人間レビュー必須**。フェーズごとに別 PR / 別 ADR に切って段階受理する。
- **テスト**: eval の golden 拡張・軌跡評価・モデル回帰スイート、E2E の CI 化。フェーズ 0 の
  依存キャッシュ・docker ゲート編入で PR ループを短縮。
- **セキュリティ**: ランタイムガードレールは顧客向け LLM の最低要件（PII 漏洩・有害性の防止）。
  `/security-review` と既存のサプライチェーン統制（SHA ピン・WIF・最小権限・gitleaks・Trivy）を維持。
- **コスト**: canary はトラフィック移行中に新旧リビジョンが同時課金される→短時間で昇格完了させる。
  トークン計測でセッション単位コストを可視化し、コスト最適化の意思決定材料にする。
- **フォローアップ（別 ADR / issue へ分割）**: (a) Cloud Run トラフィック分割 + 自動ロールバック、
  (b) SLO/エラーバジェット + アラート/通知チャネルの IaC、(c) MeterProvider 配線 + API トレース、
  (d) ランタイムガードレール、(e) トークン/コスト計測、(f) 評価格上げ（golden 外部化・Vertex/ADK 軌跡
  評価・モデルピン + 回帰スイート・judge メタ評価）、(g) AI-SRE runbook + 自律トリアージ、
  (h) DX Core 4 / AI 生成コード計測、(i) ドキュメント整合の是正。
- **ドキュメント**: 本 ADR 受理後、`devops.md` と旧 ADR 群の Langfuse/環境分離/BigQuery/concurrency
  記述、ADR-0015 §9 の eval ゲート方針を実装と一致させる。

本 ADR は提案中。実行基盤・優先順位・受理は人間レビューを経て確定する。断定した数値目標（SLO の
具体値、canary の昇格ステップ幅）はフェーズ 1 の設計 PR で決める。
