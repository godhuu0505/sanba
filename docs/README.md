# SANBA ドキュメント

このディレクトリは [Diátaxis](https://diataxis.fr/) フレームワークに沿って整理している。
読み手の「目的」ごとに 4 つの区分に分け、混在させない。

| 区分 | 目的 | あなたが… |
|---|---|---|
| 🎓 **チュートリアル** | 学ぶ | はじめて触る。手を動かして動く状態まで到達したい |
| 🔧 **ハウツー** | 課題を解く | 特定の作業（デプロイ・ローカル起動）の手順が知りたい |
| 📖 **リファレンス** | 確認する | 仕様・設定・構成を正確に参照したい |
| 💡 **解説** | 理解する | なぜこの設計なのか、背景・判断を知りたい |

---

## 🎓 チュートリアル（学ぶ）

- [クイックスタート](../README.md#-クイックスタートローカル) — `.env` を置いて `just up` まで。最短で動かす。

## 🔧 ハウツー（課題を解く）

- [ローカル開発ガイド](local-dev.md) — 全コンポーネントの起動・疎通確認・トラブルシュート。
- [DevOps サイクル](devops.md) — CI/CD・可観測性・LLMOps・Four Keys の回し方。

## 📖 リファレンス（確認する）

- [アーキテクチャ設計](architecture.md) — コンポーネント / 二層構造 / データモデル / 非機能要件。
- [セキュリティ & データガバナンス](security.md) — アクセス制御・PII マスキング・保持期間・CI スキャン。
- アプリ別 README — [agent](../apps/agent/README.md) / [api](../apps/api/README.md) / [web](../apps/web/README.md)
- [Four Keys / DORA 自己計測](../infra/four-keys/README.md)

## 💡 解説（理解する）

- [ロードマップ](roadmap.md) — 1:1 から多対多への段階的拡張方針。
- [ADR（設計判断記録）](adr/) — なぜその選択をしたか、捨てた選択肢は何か。下表参照。

### ADR 一覧

| # | タイトル | 概要 |
|---|---|---|
| [0001](adr/0001-tech-stack.md) | 技術スタックの選定 | Cloud Run / Gemini / ADK / LiveKit などの採用根拠 |
| [0002](adr/0002-multi-agent-topology.md) | マルチエージェント・トポロジ | subagent 協調と agent-as-a-tool の使い分け |
| [0003](adr/0003-elasticsearch-grounding.md) | Elasticsearch による根拠付け | RAG・過去セッション検索のハイブリッド設計 |
| [0004](adr/0004-multimodal-input.md) | マルチモーダル入力 | 画面共有 / モック映像の要件化 |
| [0005](adr/0005-llm-judge-eval-loop.md) | LLM-as-a-judge 評価ループ | オンライン評価 + CI 回帰 |
| [0006](adr/0006-cloudrun-and-livekit.md) | Cloud Run 継続と LiveKit 継続 | GKE / GCP ネイティブ代替を見送った判断 |
| [0007](adr/0007-external-connectors.md) | 外部コネクタ | GitHub などへの書き出し設計 |
| [0008](adr/0008-product-concept.md) | プロダクトコンセプト | 多対多 / 出所メタ配線の前提 |
| [0009](adr/0009-local-compose-split-and-cost.md) | ローカル compose の二層分割とコスト | base / tools overlay の分離 |
| [0010](adr/0010-ai-pr-review-automation.md) | AI による PR 自動レビュー | レビュー自動化と対応フロー |

新しい ADR は [`/adr`](../CLAUDE.md) スキル、または既存ファイルを雛形にして `docs/adr/NNNN-*.md` で追加する。

---

> ドキュメントは「コードを読まなくても理解・利用・貢献できる」状態を目標にする（standard-readme の原則）。
> 設計判断は必ず ADR に残し、README は入口に徹する。
