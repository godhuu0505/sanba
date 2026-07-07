# ロードマップ — 1:1 から 多対多 へ

段階的に拡張する。各 Phase は「動いてデプロイできる」状態を保つ（常にデモ可能）。

> **現況（2026-07 時点）**: 本番稼働中（<https://youken.sanba.net>・Cloud Run + Global LB）。
> Phase 1（1:1 音声インタビュー MVP）は完了し、利用者ペルソナ拡張（ADR-0031/0032/0036/0044/0045）
> まで実装済み。以降のチェックは現況に合わせて更新する（Phase 2 の多話者識別は未着手）。

## Phase 0 — 基盤
- [x] モノレポ構成・設計ドキュメント・ADR
- [x] docker compose（agent/api/web/observability/langfuse）
- [x] CI/CD・Terraform・可観測性スタックの雛形
- [x] `.env.local` を設定して `just up` / `just up-full` が通ることを確認

## Phase 1 — 1:1 音声インタビュー MVP（完了）
- [x] LiveKit + Gemini Live で 1 参加者と speech-to-speech 対話
- [x] grill-me 流「一問一答 + 推奨回答」を音声で実現（ADR-0024）
- [x] Interview Lead Agent（ADK）で次の質問を計画
- [x] 確定要件を Firestore に保存し、Web に可視化
- [x] 発話の出所メタ（participant identity）を最小配線し、確定要件に source として保持（ADR-0008。1:1 でも N:M 設計を示す）
- [x] 要件ドキュメント（Markdown）の自動生成（ADR-0042 出力フォーマット）
- [x] OTel トレース + Langfuse トレースが通る（メトリクス配線は一部 no-op。詳細は architecture-analysis §10）
- [x] Cloud Run へデプロイ（最初の「とどける」）

## Phase 2 — 多人数（N:1）
- [ ] 複数参加者の話者識別（声紋/トラック単位での識別。Phase 1 の出所メタ配線を多人数へ拡張）
- [ ] 司会進行：発言の交通整理・要約・合意確認
- [ ] 発話の出所ひも付けを多話者に拡張（Phase 1 の 1 話者トレーサビリティの自然な拡張）

## Phase 3 — 多エージェント協調（N:M）
- [ ] 非機能要件 / スコープ / 矛盾検知の専門サブエージェントを並行起動
- [ ] 論点に応じた割り込みポリシー
- [ ] エージェント間の役割分担と発話の宛先制御

## 拡張 — 利用者ペルソナ（ADR-0031/0032）

「準備する人＝話す人」の単一ペルソナ（ADR-0008）に対し、PdM が発行した深掘りリンクをアプリの**利用者**が開くだけでインタビューが始まる経路を段階導入する。これは PdM が現場の一次情報（利用実態・困りごと）を集約するための**道具としての拡張**であり、開発者向け要件深掘りというコンセプトの置き換えではない。Stage 1（ログイン必須の一気通貫: アプリ登録 → リンク発行 → `/join/{token}` → 会話開始）は実装済み。Stage 2 でゲスト入場（ADR-0032）と利用者モードの対話プロファイルを導入する。詳細は [`docs/explanation/personas-and-use-cases.md`](personas-and-use-cases.md) / [実装計画](../notes/product-enduser-implementation-plan.md)。

## 横断機能（基盤に実装済み / 拡張）
- [x] Elasticsearch による RAG 根拠付け + 過去セッション検索（ADR-0003）
- [x] マルチモーダル入力：画面共有/モック画像 → 要件化（ADR-0004。Web の共有UIは Phase 2）
- [x] アップロード動画の非同期解析：GCS + Cloud Tasks + 専用ワーカーで解析し grounding へ（ADR-0040。`apps/worker` 実装済・[実装計画](../notes/video-and-screen-analysis-implementation-plan.md)。CD 配線は要フォローアップ）
- [ ] 画面共有のキーフレーム解析：変化検知で永続記録を作り深掘りに使う（ADR-0041 提案中・同計画）
- [x] LLM-as-a-judge オンライン評価 + CI 回帰ループ（ADR-0005）
- [ ] 要件 → GitHub Issue/PR 自動生成 → 実装エージェント起動（次の高加点候補）
- [ ] アクセシビリティ & 英語UI（国際性）

## Phase 4 — 仕上げ（提出）
- [ ] LLM 評価データセットによる回帰テスト
- [x] Four Keys ダッシュボード（`infra/four-keys/collector` → Prometheus → Grafana。自リポジトリの DORA を自己計測）
- [ ] デモ動画（1分・Before/After）
- [ ] Zenn 提出記事（アーキテクチャ図 + DevOps サイクル図）

## 既知の判断保留事項（要相談）
- プロダクト名（仮: SANBA）の最終決定
- Gemini API か Vertex AI か（コスト/クォータで判断）
- Cloud Run か Agent Engine か（提出直前に最新の推奨パターンを確認）
