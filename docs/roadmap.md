# ロードマップ — 1:1 から 多対多 へ

段階的に拡張する。各 Phase は「動いてデプロイできる」状態を保つ（常にデモ可能）。

## Phase 0 — 基盤（本コミット）
- [x] モノレポ構成・設計ドキュメント・ADR
- [x] docker compose（agent/api/web/observability/langfuse）
- [x] CI/CD・Terraform・可観測性スタックの雛形
- [x] `.env.local` を設定して `just up` / `just up-full` が通ることを確認（issue #38。verify-full 12/12、agent→livekit 配線修正込み）

## Phase 1 — 1:1 音声インタビュー MVP
- [ ] LiveKit + Gemini Live で 1 参加者と speech-to-speech 対話
- [ ] grill-me 流「一問一答 + 推奨回答」を音声で実現
- [ ] Interview Lead Agent（ADK）で次の質問を計画
- [ ] 確定要件を Firestore に保存し、Web に可視化
- [ ] 発話の出所メタ（participant identity）を最小配線し、確定要件に source として保持（ADR-0008。1:1 でも N:M 設計を示す）
- [ ] 要件ドキュメント（Markdown）の自動生成
- [ ] OTel トレース + Langfuse トレースが通る
- [ ] Cloud Run へデプロイ（最初の「とどける」）

## Phase 2 — 多人数（N:1）
- [ ] 複数参加者の話者識別（声紋/トラック単位での識別。Phase 1 の出所メタ配線を多人数へ拡張）
- [ ] 司会進行：発言の交通整理・要約・合意確認
- [ ] 発話の出所ひも付けを多話者に拡張（Phase 1 の 1 話者トレーサビリティの自然な拡張）

## Phase 3 — 多エージェント協調（N:M）
- [ ] 非機能要件 / スコープ / 矛盾検知の専門サブエージェントを並行起動
- [ ] 論点に応じた割り込みポリシー
- [ ] エージェント間の役割分担と発話の宛先制御

## 横断機能（基盤に実装済み / 拡張）
- [x] Elasticsearch による RAG 根拠付け + 過去セッション検索（ADR-0003）
- [x] マルチモーダル入力：画面共有/モック画像 → 要件化（ADR-0004。Web の共有UIは Phase 2）
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
