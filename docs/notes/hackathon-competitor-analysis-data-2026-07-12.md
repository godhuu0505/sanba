# DevOps × AI Agent Hackathon 2026 — 他参加者提出作品 解析データ（2026-07-12）

- ステータス: **一時作業文書**（日付付き調査データ / ADR-0050 原則4。着地後アーカイブ）
- 対象: ProtoPedia イベント <https://protopedia.net/event/devops-ai-agent-hackathon>（提出 108 件）
- 手法: protopedia.net はボット遮断（HTTP 403）かつ本セッションの egress ポリシーでも遮断のため、
  **検索エンジン経由（WebSearch）のスニペット収集**で列挙した。約 **80/108 件**を特定。
  各作品の帰属は「ID 域 8430〜8848・公開時期 2026 年 6〜7 月・ハッカソンへの言及」からの推定を含む。
  `※` 付きは帰属または内容が不確実。**残り約 28 件は検索露出がなく未収集**。
- 分析・示唆は別ファイル `hackathon-competitor-report-2026-07-12.md` を参照（本書は生データのみ）。

## A. SRE・障害対応・自己修復（運用の自動化）

| ID | タイトル | 概要 | 判明技術 |
|---|---|---|---|
| 8749 | DevOps Lifecycle Agent | Cloud Run 障害の検知→原因診断→修正PR→ポストモーテムまで4体のエージェントが自走。人間はPRレビューのみ | ADK, Gemini 2.5, Cloud Run |
| 8704 | CloudMedic | 医師のように Cloud Run サービスを自律診察。原因特定→処置→回復確認→ポストモーテム | Gemini, Cloud Run |
| 8780 | RunGuard | Cloud Run の当直SRE。異常観測→診断→自律復旧。即時ロールバック後にバグ修正、新機能は承認待ち | ADK, Cloud Run |
| 8784 | AutoSRE | 「落ちてる」の声を入口に調査→修正PR→承認→復旧→報告者への返信下書きまで（修正PR実測約90秒） | Cloud Run, Cloud Monitoring, Pub/Sub |
| 8724 | AgentOps Platform | AIエージェント自体をデプロイ単位に、評価→カナリア→自動ロールバック→改善PRをメタエージェントが自律判断 | Gemini, Cloud Run, Cloud Build |
| 8761 | Ops Arena – DevOps Watch Party | 障害対応をスポーツ実況のようにAIが解説。非エンジニアにも分かる CI/CD・ロールバック説明 | Gemini, Cloud Run |
| 8819 | DriftScribe | 本番と IaC のドリフトを検知し、説明付き PR・ロールバック案に変換 | Cloud Run, GitHub, IaC |
| 8848 | 運用考古学エージェント | 退職者が残したクラウドリソースを「発掘」しレポート化 | BigQuery, Vertex AI, Gemini |
| 8601 | PhoenixDevOps | コードや古い（嘘の）ドキュメントから真実の仕様書・設計書と差分ドキュメントを生成 | Gemini |

## B. リリース安全性・ゲート・セキュリティ

| ID | タイトル | 概要 | 判明技術 |
|---|---|---|---|
| 8771 | ReleaseGuard Agent | プレビュー環境で API・UI・シークレットを検証し、危険な本番変更を証拠付きで BLOCK | CI/CD |
| 8816 | CPOS Engine-Zero | AI生成コード変更を隔離・検証してから Cloud Run へ届ける Zero-Trust ランタイム | Gemini, Cloud Run |
| 8791 | Orqetra ※ | AIエージェントを安全に実行するエージェントOS | — |
| 8765 | H.H.C. | AI生成コードへの開発者自身の理解度を検証する「PR理解ゲート」を CI/CD に組込 | ADK, CI/CD |
| 8700 | Security Review Workflow | GitHub PR のセキュリティリスク分析→Slack 承認→PR 作成の DevSecOps | GitHub, Slack |
| 8716 | AI Operator Evidence Ledger ※ | AIオペレーターの操作証跡を台帳化する DevOps 基盤 | — |
| 8730 | KangaL | 攻撃AI×防御AIの自己改善型詐欺検知（非ITユーザー保護） | Gemini |
| 8515 | Containment OS ※ | A2A 連携エージェント群がネットワーク侵害を自律検知・封じ込め。Human-in-the-loop UI | A2A, Gemini |
| 8824 | anneal | 依存・脆弱性アップグレードを自律的に回し、AIの振る舞い自体もスコアリングして自己改善 | — |

## C. 開発プロセス支援（要件・タスク・レビュー・ドキュメント）— SANBA の直接競合域

| ID | タイトル | 概要 | 判明技術 |
|---|---|---|---|
| 8706 | Provena | 要件・非機能を固めるとエージェントが開発・デプロイまで自動実行する DevOps コックピット。W字モデル検証、知財・法務・経理・セキュリティ横断チェック | Gemini |
| 8705 | FlowForge | 要件定義書のAI解析→GitHubブランチ自動作成→コードレビュー→問い合わせカンバンまで | Gemini, GitHub |
| 8702 | Michinori | リポジトリとプロンプトからタスク一覧と依存関係を DAG 生成 | GitHub, Gemini |
| 8708 | AIIPG | GitHub Issue から既存コード解析→動くプロトタイプ自動実装→PR まで完全自動化 | GitHub, Gemini |
| 8785 | DevDebtOps | 技術負債・理解負債を可視化し、学習プラン・クイズ・修正PRを提案 | Gemini, GitHub |
| 8711 | DayOne | AIルーキーが毎日ゼロからオンボーディングし、腐敗した手順書を検知して実行可能な README に修正 | Vertex AI, Gemini |
| 8735 | PersonaOps | コードレビューの前に仮想ペルソナがユーザー業務影響をシミュレーション | Gemini |
| 8738 | Genos | チャット・タスク・ノート横断の「つながる記憶」Context OS。出典付きで調査・判断・実行 | — |
| 8788 | FacilitAI | Google Meet 字幕をリアルタイム解析しファシリテーションコメントを自動投稿 | Google Meet, Gemini |
| 8731 | ポケット部長24 | マルチエージェントが意思決定パターンを再現、相談・文書レビューの判断パートナー | Vertex AI, Gemini |
| 8590 | ComplaintOps Copilot | クレーム対応から暗黙知を抽出し次案件へ自動適用する「社内暗黙知OS」 | Gemini |
| 8671 | AI-Ready Knowledge Hub | 社内文書の分類・マスキングなど AI に渡す前処理を自動化 | Vertex AI, Gemini |
| 8827 | UT Manager ※ | ユニットテスト管理系と推定 | — |
| 8770 | tech-support | バグ報告→失敗するテスト化→エージェントが再現・修正→PR→人間承認→リリース | Terraform, GitHub Actions, Gemini |

## D. 業務ドメイン特化エージェント

| ID | タイトル | 概要 | 判明技術 |
|---|---|---|---|
| 8810 | LegalGate Agent | 契約書リスク分析 | Gemini |
| 8718 | 大動脈解離 同意説明支援 | 緊急手術のインフォームドコンセント支援 | Gemini |
| 8605 | AWA-LINK | LINE ベースの臨床支援。MCP でスプレッドシート・カレンダー連携、指導者派遣提案 | LINE, BigQuery, Gemini, MCP |
| 8766 | 外来診療DX | LINE bot＋音声入力で外来診療を DX | LINE, 音声, Gemini |
| 8830 | AIエージェントが登録する経費精算 | 経費精算登録の代行 | Gemini |
| 8703 | MatchMirror | 採用ミスマッチの自律診断・フォロー | Gemini |
| 8677 | Sokqa Studio | 教材設計→生成→品質チェック→音声合成→共有のワークフロー支援 | Gemini, 音声合成 |
| 8667 | ナカナオリ・エージェント | 子どものケンカを聞き取り整理し先生へヒント提供。ロボット対応 | Gemini, Kebbi AIR |
| 8786 | 育つ制約エージェント | 制約ソルバー×AI のシフト自動作成。制約が「育つ」 | ソルバー |
| 8725 | Marketing Shorts Agent | 決算データから YouTube Shorts 生成・投稿・効果測定まで自動化 | Cloud Run, Gemini |
| 8845 | Tech Cartography | 特許・論文・Web 横断で R&D の技術シグナルを整理 | BigQuery |
| 8742 | DeepFact Validator | 3体のエージェントが SNS・ニュース言説の信頼性をリアルタイム可視化 | LINE, Vertex AI, Gemini |
| 8713 | Social Risk Simulator | 偽情報拡散をマルチエージェントで自律シミュレーション（カオスエンジニアリング発想） | Gemini |
| 8577 | DevPath Navigator | 似たキャリア軌跡データから次のキャリアを推薦 | BigQuery, Gemini |
| 8811 | MBTI×AI 組織配置最適化 ※ | MBTI×AI の組織配置 | — |
| 8672 | 社員紹介クイズ | 社内クイズ作成・回答 Web アプリ | Gemini |
| 8707 | Tech Event Royale | IT イベント探索ダッシュボード | — |

## E. 音声・対話 UI を核にする作品 — SANBA の「音声」軸の競合

| ID | タイトル | 概要 | 判明技術 |
|---|---|---|---|
| 8764 | Fugue × biblio | 画面共有から「AI専門家会議」を開くデスクトップ音声アシスタント | Gemini, マルチエージェント, LangGraph |
| 8805 | しゃべれぽAI | 音声入力で記録するハードウェア連携エージェント | Gemini API, ハードウェア |
| 8769 | RinRin | AIの友達から電話がかかってくる英会話学習 | Gemini, 音声 |
| 8817 | AI GRIMOIRE | 声で詠唱する適応型AIゲームマスター | Cloud STT, FastAPI, Vertex AI, Cloud Run, Next.js |
| 8833 | スマホおたすけエージェント | 話しかけるとスマホ操作を矢印ガイド・自動操作で支援（シニア向け）。DevOps ループで継続改善を明示 | Gemini, ADK |
| 8802 | SHIBAKI | TTS を用いた自律型エージェント | Gemini API, TTS |

## F. 生活・エンタメ・その他

| ID | タイトル | 概要 | 判明技術 |
|---|---|---|---|
| 8675 | Hackbase.ai | 人格を持つAIエージェント達が Web プロダクトを作り交流する「人間お断り」開発コミュニティ | Gemini |
| 8803 | BiteOps | 献立提案と食材の購買・消費を自律管理する「家庭の食事 DevOps」 | Gemini |
| 8737 | ふるさとピザ帳 | 地元食材からピザ3案提案→産地ストーリー・完成画像生成→ふるさと納税注文まで | Firebase, Gemini |
| 8701 | おたよりナビ | 保育園のおたよりを撮るだけで OCR→構造化→公式手順の自律調査→締切逆算タスク生成 | Gemini, OCR |
| 8748 | LifeLog | Slack につぶやくだけで日報・感情を抽出し Google Calendar 同期（完全受動型） | Vertex AI, Slack, Calendar |
| 8726 | BuySense | 購買意思決定の背景調査・考慮漏れ提示 | Firestore, Firebase Auth, Gemini |
| 8789 | gen-fashion | クローゼット写真から AI コーディネート提案 | Flutter Web, Firebase, Gemini |
| 8627 | Boxing Agent | 練習・減量・試合分析を複数エージェントが支援 | Gemini, 姿勢推定, 動画分析 |
| 8767 | EmoTuning Agent | AI×楽器演奏の感情セルフケア | Gemini |
| 8822 | ShopStream Intelligence | Gemini Live・Google Lens の物体認識×Elasticsearch のショッパブル動画統合監視 | Gemini Live, Lens, Elasticsearch |
| 8806 | Topipet ※ | バーチャルペット系 | Gemini |
| 8808 | kAkeI-bot ※ | 家計簿 bot 系 | Gemini |
| 8622 / 8796 | AgentForge ※ | ビジュアルツールでエージェントをプロトタイピング（同名2件） | 生成AI |
| 8772 | Micro Grand Maison ※ | 料理系と推定 | Gemini |
| 8794 | Pufu Lens ※ | プロジェクト編集支援 | Gemini |
| 8743 | Coyomi ※ | 暦・カレンダー系と推定 | — |
| 8616 | クルッくる ※ | 詳細不明 | — |
| 8514 | Publishr ※ | 個人向けAI出版支援 | Gemini |
| 8579 / 8435 | IntentLoop / IntentOps Harness ※ | 意図整理→計画・承認・品質評価・成果物保存を安全に回すハーネス | Gemini |
| 8430 | Lチカのつづき ※ | 電子工作初心者に伴走 | Gemini |
| 8588 | AIで1分ミュージカル ※ | 1分ミュージカル生成 | 生成AI |
| 8589 | TerraGuard AI ※ | カラス検出 | 画像認識 |
| 8659 | 防災まち歩きワークショップ支援 ※ | 防災ワークショップ支援 | — |
| 8752 | 園芸記録管理アシスタント ※ | LINE 連携園芸記録（別イベントの可能性） | LINE |

## 集計（収集分 80 件、※=不確実 24 件を含む）

| カテゴリ | 件数 | 割合 |
|---|---|---|
| A. SRE・障害対応・自己修復 | 9 | 11% |
| B. リリース安全性・セキュリティ | 9 | 11% |
| C. 開発プロセス支援（要件・タスク・レビュー・Doc） | 14 | 18% |
| D. 業務ドメイン特化 | 17 | 21% |
| E. 音声・対話 UI 核 | 6 | 8% |
| F. 生活・エンタメ・その他 | 25 | 31% |

## 情報源

- ProtoPedia 各作品ページ（検索スニペット経由）: `https://protopedia.net/prototype/<ID>`
- Google Cloud 公式ブログ: <https://cloud.google.com/blog/ja/products/ai-machine-learning/devops-ai-agent-hackathon-2026?hl=ja>
- Zenn / note / X 上の参加記・告知（本文レポートの情報源一覧を参照）
