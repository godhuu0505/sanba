# ロードマップ — 1:1 から 多対多 へ

段階的に拡張する。各 Phase は「動いてデプロイできる」状態を保つ（常にデモ可能）。

## Phase 0 — 基盤（本コミット）
- [x] モノレポ構成・設計ドキュメント・ADR
- [x] docker compose（agent/api/web/observability/langfuse）
- [x] CI/CD・Terraform・可観測性スタックの雛形
- [ ] `.env` を設定して `make up` が通ることの確認

## Phase 1 — 1:1 音声インタビュー MVP
- [ ] LiveKit + Gemini Live で 1 参加者と speech-to-speech 対話
- [ ] grill-me 流「一問一答 + 推奨回答」を音声で実現
- [ ] Interview Lead Agent（ADK）で次の質問を計画
- [ ] 確定要件を Firestore に保存し、Web に可視化
- [ ] 要件ドキュメント（Markdown）の自動生成
- [ ] OTel トレース + Langfuse トレースが通る
- [ ] Cloud Run へデプロイ（最初の「とどける」）

## Phase 2 — 多人数（N:1）
- [ ] 複数参加者の話者識別（participant identity 紐付け）
- [ ] 司会進行：発言の交通整理・要約・合意確認
- [ ] 発話の出所を要件にひも付け（トレーサビリティ）

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
- [ ] Four Keys ダッシュボード
- [ ] デモ動画（1分・Before/After）
- [ ] Zenn 提出記事（アーキテクチャ図 + DevOps サイクル図）

## 既知の判断保留事項（要相談）
- プロダクト名（仮: Kikitori）の最終決定
- Gemini API か Vertex AI か（コスト/クォータで判断）
- Cloud Run か Agent Engine か（提出直前に最新の推奨パターンを確認）
