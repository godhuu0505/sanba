# SANBA ドキュメント

このディレクトリは [Diátaxis](https://diataxis.fr/) フレームワークに沿って、読み手の「目的」ごとに
**物理ディレクトリ**を分けている（配置方針は [ADR-0050](adr/0050-documentation-placement-and-lifecycle.md)）。

| 区分 | ディレクトリ | 目的 | あなたが… |
|---|---|---|---|
| 🎓 **チュートリアル** | （root README） | 学ぶ | はじめて触る。手を動かして動く状態まで到達したい |
| 🔧 **ハウツー** | [`how-to/`](how-to/) | 課題を解く | デプロイ・ローカル起動など特定作業の手順が知りたい |
| 📖 **リファレンス** | [`reference/`](reference/) | 確認する | 仕様・設定・構成を正確に参照したい |
| 💡 **解説** | [`explanation/`](explanation/) ・ [`adr/`](adr/) | 理解する | なぜこの設計なのか、背景・判断を知りたい |
| 🛠 **作業文書** | [`notes/`](notes/) | （一時） | 実装計画・監査など。恒久リファレンスではなく、着地後に削除/アーカイブする |

> 恒久リファレンス（`reference/`・`explanation/`）と一時作業文書（`notes/`）は混ぜない。
> 設計判断は必ず ADR に残し、README は入口に徹する（standard-readme / ADR-0050）。

---

## 🎓 チュートリアル（学ぶ）

- [クイックスタート](../README.md#-クイックスタートローカル) — `just setup` で `.env.local` を用意し `just up` まで。最短で動かす。

## 🔧 ハウツー（課題を解く）

- [ローカル開発ガイド](how-to/local-dev.md) — 全コンポーネントの起動・疎通確認・機能別フル構築・トラブルシュート。
- [DevOps サイクル](how-to/devops.md) — CI/CD・可観測性・LLMOps・Four Keys の回し方。
- [GCP デプロイ手順書](how-to/deploy-gcp.md) — Cloud Run 本番デプロイと公開化（WIF・Secret・独自ドメイン・GitHub 設定）。
- [動画解析の有効化](how-to/enable-video-analysis.md) — アップロード動画の非同期解析（ADR-0040）を有効にする手順。
- [Figma MCP](how-to/figma-mcp.md) — UI/UX を Figma で検討・実装・修正するデザインループ（リモート MCP）。
- [ラベル運用](how-to/labels.md) — issue/PR ラベルを軸ベースで設計し `.github/labels.yml` で IaC 管理する。
- [プレスリリース前のコスト最小化運用](how-to/pre-launch-cost-controls.md) — agent の warm/sleep 切替・billing export・Elastic/LiveKit の固定費削減。

## 📖 リファレンス（確認する）

- [アーキテクチャ設計（TO-BE）](reference/architecture.md) — コンポーネント / 二層構造 / データモデル / 非機能要件。
- [アーキテクチャ & インフラ徹底解析（AS-IS）](reference/architecture-analysis.md) — 実装から起こした全体像。GCP サービス・外部連携・LB/CI-CD/可観測性を図示。**設計とズレたら本書を一次情報とする。**
- [ユビキタス言語](reference/ubiquitous-language.md) — プロダクト・設計・コード・UI で同じ言葉を同じ意味で使う用語ハブ。
- [セキュリティ & データガバナンス](reference/security.md) — アクセス制御・PII マスキング・保持期間・CI スキャン・公開化ハードニング。
- [リアルタイム契約](reference/realtime-contract.md) — agent→web の伝送とハイドレーション（状態復元）のプロトコル契約。
- [会話体験仕様](reference/conversation-experience.md) — 会話フェーズの 3 タブ・選択肢モード・二系統コントロール（ADR-0018）。
- [利用者モード要件](reference/product-enduser-requirements.md) — product / 深掘りリンク / 利用者モードの FR/NFR。
- [画面別実装要件票](reference/screens/) — 01ホーム〜08結果の一本道フロー、画面ごとの UI・状態・受け入れ条件。
- アプリ別 README — [agent](../apps/agent/README.md) / [api](../apps/api/README.md) / [web](../apps/web/README.md) / [worker](../apps/worker/README.md)
- [Four Keys / DORA 自己計測](../infra/four-keys/README.md)

## 💡 解説（理解する）

- [ロードマップ](explanation/roadmap.md) — 1:1 から多対多への段階的拡張方針。
- [ペルソナ / ユースケース](explanation/personas-and-use-cases.md) — 開発者側と利用者側のペルソナ分離の背景。
- [問い合わせトリアージ](explanation/inquiry-triage.md) — 利用者の声の 5 分類と「要件を作らない」ことの価値（ADR-0048）。
- [デザイン概観](explanation/design-overview.md) — IA・画面設計・デザインシステム・Figma リンクの総論。
- **[ADR（設計判断記録）一覧](adr/README.md)** — なぜその選択をしたか、捨てた選択肢は何か（全 50 件・`just docs-index` で生成）。

## 🛠 作業文書（notes/ ・一時的）

- [`notes/`](notes/) — 実装計画・監査・移行スペックなど。決定は ADR、恒久仕様は reference に写してから、着地した作業文書は削除/アーカイブする（ADR-0050 原則4）。

---

## 索引の生成

ADR 索引 [`adr/README.md`](adr/README.md) は `just docs-index`（`scripts/gen-docs-index.py`）で
各 ADR の先頭メタから生成する。ADR を追加・改訂したら再生成して commit する。`just docs-check` は
索引が最新かを検証する（CI 向け）。新しい ADR は [`/adr`](../.claude/commands/adr.md) スキルで採番付き雛形を作る。
