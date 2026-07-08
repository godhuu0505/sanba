# ADR 索引

> このファイルは `just docs-index`（`scripts/gen-docs-index.py`）で生成する。
> 手で編集しない。ADR を追加・改訂したら再生成する。

設計判断記録（Architecture Decision Record）の一覧。全 56 件。
書き方・ステータス制御語彙は [`/adr` 雛形](../../.claude/commands/adr.md) を参照。

| # | タイトル | ステータス |
|---|---|---|
| [0001](0001-tech-stack.md) | 技術スタックの選定 | Accepted |
| [0002](0002-multi-agent-topology.md) | マルチエージェント・トポロジと音声/推論の二層分離 | Accepted |
| [0003](0003-elasticsearch-grounding.md) | Elasticsearch による RAG 根拠付けと過去セッション検索 | Accepted |
| [0004](0004-multimodal-input.md) | マルチモーダル入力（画面共有・モック画像） | Accepted |
| [0005](0005-llm-judge-eval-loop.md) | LLM-as-a-judge オンライン評価と回帰ループ | Accepted |
| [0006](0006-cloudrun-and-livekit.md) | Cloud Run 継続（GKE 見送り）と LiveKit 継続（GCPネイティブ代替の見送り） | Accepted |
| [0007](0007-external-connectors.md) | 外部ソース連携コネクタ（GitHub） | Accepted |
| [0008](0008-product-concept.md) | プロダクトコンセプトの絞り込み（ペルソナ・核・スコープ） | Accepted |
| [0009](0009-local-compose-split-and-cost.md) | ローカル compose の二層分割と本番コスト最適化 | Accepted |
| [0010](0010-ai-pr-review-automation.md) | AI による PR 自動レビューと対応フロー | Accepted |
| [0011](0011-figma-mcp-design-loop.md) | Figma MCP による UI/UX デザインループ | Accepted |
| [0012](0012-google-login.md) | Google ログイン（OAuth / OpenID Connect）の導入 | Accepted |
| [0013](0013-custom-domain-load-balancer.md) | 本番ドメイン (sanba.com) を Global 外部 HTTPS LB で配信 | Accepted |
| [0014](0014-admin-and-login-screens.md) | ログイン画面と管理画面（セッション/要件の運用UI） | Accepted |
| [0015](0015-autonomous-pr-babysitter-loop.md) | 自律 PR babysitter ループ（issue 起点〜マージ可能まで） | Proposed |
| [0016](0016-cicd-strategy.md) | CI/CD 戦略 — リポジトリ public 化による無料・無制限 Actions 基盤 | Proposed |
| [0017](0017-figma-canonical-onepath-archaic-copy.md) | Figma 正本を正とするデザイン方針確定（一本道フロー・全面古語・a11y は現代語で担保） | Superseded by ADR-0047 |
| [0018](0018-conversation-experience.md) | 会話体験（会話フェーズの 3 タブ・選択肢 3 モード・二系統コントロール） | Accepted |
| [0019](0019-google-signin-button-branding.md) | ログイン画面 Google ボタンの意匠（純正維持 + 金彩フレーム） | Superseded by ADR-0052 |
| [0020](0020-question-asked-hydration.md) | question.asked のハイドレーション方式（サーバ保存 + GET 復元） | Accepted |
| [0021](0021-realtime-reliable-seq-and-persistence.md) | realtime イベントの reliable-seq 名前空間と seq 永続化 | Proposed |
| [0022](0022-conversation-realtime-model-ambiguous-and-voice-state.md) | 会話 realtime モデルの拡張 — 不明瞭検知（ambiguous）と音声状態の表現 | Proposed |
| [0023](0023-staged-upload-analysis-progress.md) | アップロード素材の解析進捗（analysis.progress / analysis.visual）の発行設計 | Accepted |
| [0024](0024-grill-me-interview-persona.md) | grill-me 流の問い詰めをインタビューペルソナに採用する | Accepted |
| [0025](0025-light-paper-redesign.md) | UI アートディレクション刷新（漆黒×金 → 白い紙×原色×棒人間） | Superseded by ADR-0033 |
| [0026](0026-auto-apply-terraform-on-main-merge.md) | main マージで terraform を自動 apply する CD パイプライン（migrate → deploy の順序保証） | Proposed |
| [0027](0027-per-session-github-repo.md) | セッション単位の GitHub リポジトリ選択 | Accepted |
| [0028](0028-github-repo-linking.md) | GitHub App 個別連携・ES 索引・branch 対応 | Accepted |
| [0029](0029-cd-migration-on-merge.md) | main マージ→本番デプロイ時のマイグレーション実行設計 | Proposed |
| [0030](0030-cross-tab-logout-broadcast.md) | クロスタブ・ログアウト伝播（BroadcastChannel によるログアウト合図の共有） | Proposed |
| [0031](0031-product-entity-and-invite-links.md) | product エンティティ・所有・深掘りリンク | Accepted |
| [0032](0032-guest-join-and-enduser-mode.md) | ゲスト入場と利用者モード（interview_mode） | Accepted |
| [0033](0033-ui-redesign-v2-sticker-paper.md) | UI デザイン刷新 v2（白い紙の上の問答 — ステッカー×原色×動く棒人間） | Accepted |
| [0034](0034-app-icon-and-stick-figure-logo.md) | アプリアイコン／ロゴを棒人間「サンバさん」に更新（ファビコン・Apple touch icon 整備） | Accepted |
| [0035](0035-prep-context-seeding.md) | セッション準備情報を agent の初期前提としてシードする | Accepted |
| [0036](0036-product-members-and-invitations.md) | product メンバー管理・ユーザー招待・招待通知 | Accepted |
| [0037](0037-background-prefetch-and-injection-policy.md) | バックグラウンド先読みと注入ポリシー | Proposed |
| [0038](0038-voice-turn-detection-and-session-recovery.md) | 音声ターン検出を保守側に倒し、音声セッションを自動復旧させる | Accepted |
| [0039](0039-voice-input-accuracy.md) | 音声入力の精度を上げる（言語固定・ノイズ抑制・ターン検出の再調整） | Accepted |
| [0040](0040-uploaded-video-async-analysis.md) | アップロード動画の非同期解析パイプライン（GCS + Cloud Tasks + 専用ワーカー） | Accepted |
| [0041](0041-screen-share-keyframe-analysis.md) | 画面共有のキーフレーム解析（Live 併用ハイブリッド） | Proposed |
| [0042](0042-result-output-formats-and-check-items.md) | 要件結果の対象者別出力フォーマットとセッション確認項目 | Accepted |
| [0043](0043-audience-tagged-check-items-and-render-unification.md) | 確認項目の対象者タグと要件整形の一本化・api ルーター分割 | Accepted |
| [0044](0044-home-app-selection-gate.md) | 対象アプリの選択を 01 ホームの開始ゲートにする | Accepted |
| [0045](0045-app-slug-urls-and-access-error.md) | アプリ slug によるアプリ従属 URL と複合アクセスエラー表示 | Accepted |
| [0046](0046-decouple-analysis-from-voice-worker.md) | 音声リアルタイム worker から要件分析（ADK 多段チェーン）を分離する | Proposed |
| [0047](0047-app-is-canonical-figma-follows.md) | 正本の逆転 — アプリ実装を唯一の正本とし、Figma を追従させる | Accepted |
| [0047](0047-login-token-refresh-and-nonce.md) | ログインセッションの堅牢化（ID トークンの能動リフレッシュと nonce 束縛） | Proposed |
| [0048](0048-inquiry-triage-and-support-knowledge.md) | 問い合わせトリアージとサポート知識（利用者の声の切り分け・その場解決） | Accepted |
| [0049](0049-upload-types-and-google-drive-import.md) | 資料アップロードの形式拡張と Google ドライブ取り込み | Accepted |
| [0050](0050-documentation-placement-and-lifecycle.md) | ドキュメントの配置方針とライフサイクル（AI 駆動開発前提） | Accepted |
| [0051](0051-google-native-observability-and-llmops.md) | 観測性・LLMOps を Google Cloud ネイティブに統一する（Cloud Trace / Cloud Monitoring / Vertex・ADK eval、Langfuse 廃止） | Proposed |
| [0052](0052-login-redesign-nashi-gen-alignment.md) | ログイン画面の刷新（NASHI GEN 準拠のクリーン化）と復元中の中立スプラッシュ | Accepted |
| [0053](0053-github-permission-split-and-issue-export-gate.md) | GitHub 連携の権限分離 — 読みは App 索引・書きは操作者権限ゲート付き Issues:write | Accepted |
| [0054](0054-ui-copy-terminology-unification-and-help.md) | UIコピーの用語統一・平易化とヘルプ補足（単一文言への統一・Radix Popover ヘルプ） | Proposed |
| [0055](0055-end-user-detection-handling.md) | 会話でカバーする観点をモード別・設定可能にし、ハードコード NFR gap 検知を廃止する | Accepted |

付随資料は [`supplements/`](supplements/) に置く（特定 ADR の実測・検証データ）。
