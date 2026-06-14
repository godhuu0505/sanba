# ADR-0001: 技術スタックの選定

- ステータス: Accepted
- 日付: 2026-06-14

## コンテキスト
DevOps × AI Agent Hackathon 2026 向けに、音声で要件を聞き取るマルチエージェントを構築する。
必須技術（Google Cloud 実行プロダクト + Google Cloud AI 技術）を満たしつつ、審査軸（つくる・まわす・とどける）で高得点を狙う。

## 決定
- **実行基盤**: Cloud Run（必須要件・スケーラブル・ステートレス運用に適合）。
- **AI**: Gemini（Gemini Live API で音声、Gemini 2.x で推論）。エージェントフレームワークは **Google ADK**。
- **音声**: **LiveKit Agents** + Gemini Live の speech-to-speech。WebRTC で多人数に拡張可能。
- **バックエンド**: FastAPI（Python、ADK/Live と同一言語で型共有しやすい）。
- **フロント**: Next.js + LiveKit Components（Cloud Run デプロイ、審査員 吉川氏のスタックと親和）。
- **永続化**: Firestore（中井氏が頻用、エミュレータでローカル開発容易）。
- **可観測性**: OpenTelemetry を共通計装にし、ローカルは Grafana/Prometheus/Loki/Tempo、本番は Cloud Ops。
- **LLMOps**: Langfuse（OSS・セルフホスト可・評価/プロンプト管理）。
- **開発生産性**: Four Keys / DORA（Findy ドメイン直撃）。

## 検討したが採用しなかった選択肢
- **STT→LLM→TTS パイプライン**: レイテンシが大きく、speech-to-speech の自然さに劣る → Gemini Live を採用。
- **LangChain だけでエージェント構成**: 「本番志向」評価が弱い・ADK のマルチエージェント設計を活かせない → ADK を主軸に。
- **Streamlit / HF Spaces デプロイ**: 必須要件違反かつ「とどける」評価が下がる → Cloud Run。
- **DIY のメトリクス収集**: 車輪の再発明 → OTel 標準 + Langfuse。

## 影響
- Python 中心のモノレポ（agent/api）+ TypeScript（web）。
- ローカル開発は docker compose、本番は Terraform + Cloud Run。
