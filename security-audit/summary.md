# SANBA セキュリティ監査 — サマリー

- **対象**: `origin/main` HEAD `f5d2065`（2026-07-09 時点)
- **対象規模**: 監査対象ソース **247 ファイル**（apps/ packages/ infra/ .github/ scripts/ ほか。テスト・ロック・バイナリ・md ドキュメントを除く全ソース）
- **方法**: マルチエージェント並列オーケストレーション。発見20単位が担当ファイルを全行読了 → 生指摘104件 → 各指摘を独立エージェントが該当コード再読で敵対的検証（誤検知除去）。
- **制約（ユーザー方針）**: 判断根拠は現在のソースコードのみ。docs/ADR/README・ソース中コメントの説明は挙動判断に使わない（ただしコメントは機微情報漏洩の観点でのみ走査）。**対応方針・修正案は含めない**。

## 結果総数

| 区分 | 件数 |
|---|---|
| 生指摘（発見フェーズ） | 104 |
| **確定（CONFIRMED）** | **84** |
| 　└ P1（重大度高） | 16 |
| 　└ P2（重大度中〜低） | 68 |
| 要確認（UNCERTAIN） | 3 |
| 検証で棄却（REFUTED） | 17 |

P0（即時悪用可能な重大欠陥）に相当する確定指摘は検出されなかった。

## 観点 × 重大度 マトリクス（確定のみ）

| 観点 | 説明 | P1 | P2 | 計 |
|---|---|--:|--:|--:|
| A1 | アクセス制御/IDOR/BOLA | 0 | 2 | 2 |
| A2 | 認証・セッション | 0 | 6 | 6 |
| A4 | プロンプトインジェクション/過剰エージェンシー | 3 | 5 | 8 |
| A6 | 暗号・秘密の扱い | 4 | 4 | 8 |
| A7 | 機微情報の露出/PII | 2 | 7 | 9 |
| A8 | 入力検証・逆シリアライズ・ファイル処理 | 1 | 4 | 5 |
| A9 | 設定ミス | 3 | 13 | 16 |
| B | バグ/境界/並行性/リソースリーク | 0 | 8 | 8 |
| C | 過度な複雑性 | 0 | 1 | 1 |
| D | デッドコード/不要処理 | 0 | 3 | 3 |
| E | 可用性・耐障害性 | 2 | 11 | 13 |
| F | サプライチェーン/CI | 1 | 4 | 5 |
| **計** | | **16** | **68** | **84** |

## フレームワーク別の分布（確定・重複カウント）

| フレームワーク | 言及された確定指摘数 |
|---|--:|
| CWE | 70 |
| LLM | 8 |
| API | 3 |

## 単位別 確定指摘数

| 監査単位 | 確定指摘 |
|---|--:|
| ci-supplychain | 11 |
| worker | 7 |
| shared | 6 |
| infra-terraform | 6 |
| api-auth | 5 |
| api-routers-session | 5 |
| api-routers-products-members | 5 |
| api-core | 5 |
| agent-core | 5 |
| agent-tools-connectors | 5 |
| api-integrations-github | 4 |
| api-integrations-io | 4 |
| web-app | 4 |
| infra-fourkeys-observability | 4 |
| web-lib | 3 |
| web-components-2 | 2 |
| web-config | 2 |
| web-components-1 | 1 |

## P1 一覧（詳細は findings.md）

| ID | ファイル:行 | 観点 | 指摘 |
|---|---|---|---|
| SEC-001 | `apps/agent/src/sanba_agent/events.py:484` | A8 | analysis.visual の送信者検証がなく asset_id 接頭辞のみで信頼している |
| SEC-002 | `apps/agent/src/sanba_agent/main.py:1087` | E | 音声イベントループ上で同期 Firestore/索引呼び出しを実行しブロックする箇所が残存 |
| SEC-003 | `apps/agent/src/sanba_agent/main.py:1305` | A7 | ユーザー発話由来の検索クエリを構造化ログに平文出力している |
| SEC-004 | `apps/agent/src/sanba_agent/main.py:1824` | A4 | データチャネル経由の analysis.visual からLLM指示への注入（プロンプトインジェクション） |
| SEC-005 | `apps/agent/src/sanba_agent/config.py:20` | A6 | LiveKit の API キー/シークレットにハードコードされたデフォルト値 devkey / secret が設定されている |
| SEC-006 | `apps/agent/src/sanba_agent/connectors/github.py:69` | A4 | GitHub Issue 本文・タイトル・README がフェンス無しで grounding パッセージ化されモデル文脈に混入する |
| SEC-007 | `apps/api/src/sanba_api/auth_google.py:181` | A9 | auth_dev_bypass 有効時に一切の検証なく固定 dev identity を返す認証バイパス経路 |
| SEC-008 | `apps/api/src/sanba_api/config.py:12` | A6 | LiveKit API 鍵/シークレットに固定デフォルト値 devkey / secret がハードコードされている |
| SEC-009 | `apps/api/src/sanba_api/config.py:28` | A6 | 招待/セッション署名鍵 session_signing_secret に安全でない固定デフォルト値が入っている |
| SEC-010 | `apps/api/src/sanba_api/repo_indexing.py:140` | A4 | 外部リポジトリのファイル本文・Issue・README を秘匿レダクトのみで agent grounding へ投入している（間接プロンプトインジェクション） |
| SEC-011 | `apps/api/src/sanba_api/ingestion.py:105` | E | PDF 抽出だけ展開量ガードが無く、圧縮爆弾(PDF)でメモリ枯渇しうる |
| SEC-012 | `apps/api/src/sanba_api/routers/session.py:137` | A9 | auth_dev_bypass 有効時に Google 検証を全て飛ばし認証済み dev セッションを発行 |
| SEC-013 | `.env.example:36` | A6 | セッション署名鍵の既定値が固定の弱いプレースホルダ |
| SEC-014 | `.github/workflows/security.yml:30` | F | 依存/イメージ脆弱性監査(pip-audit/npm audit/Trivy)が全て非ブロッキングで警告止まり |
| SEC-015 | `docker-compose.tools.yml:71` | A9 | Grafana を匿名アクセス＋匿名ロール Admin＋埋め込み許可で起動している |
| SEC-016 | `packages/sanba_shared/src/sanba_shared/repository.py:1196` | A7 | PII マスキングは add_utterance のみで、要件・確認ノード・現在質問・素材・検知は生テキストで永続化される |

## 観点別トップ所見（各数行）

- **A2/A9 認証バイパス経路**: `auth_dev_bypass` と `require_login_nonce` 等の設定フラグが有効化されると、Google ID トークン検証・nonce 束縛・Cookie/Bearer 検証をすべて飛ばして固定 dev identity / dev セッションを発行する分岐が関数先頭に存在する（auth_google.py:181, session.py:137）。フェイルオープン方向。
- **A6 既定シークレット**: `session_signing_secret`・`livekit_api_key/secret` が公開ソース上の固定既定値（`dev-only-insecure-secret-change-me` / `devkey` / `secret`）を持ち、環境変数未設定でも起動が通る（config.py、.env.example）。必須検証・本番判定でのフェイルクローズが無い。
- **A4 プロンプトインジェクション**: GitHub Issue/README・外部リポジトリ本文・データチャネル経由の analysis.visual が、送信者検証や指示無害化なしに LLM のコンテキスト/指示へ流入する経路が複数ある（connectors/github.py, repo_indexing.py, events.py, agent/main.py）。
- **A7 機微情報/PII**: PII マスクは発話保存(add_utterance)の1箇所のみで、要件文・確認ノード・現在質問・素材・検知は平文で Firestore に保存される（shared/repository.py）。ユーザー発話由来の検索クエリを構造化ログへ平文出力する箇所もある（agent/main.py）。
- **A8/E 入力・可用性**: PDF 抽出のみ展開量ガード(_guard_zip_expansion)が欠落し圧縮爆弾でメモリ枯渇しうる（ingestion.py:105）。音声イベントループ上で同期 Firestore 呼び出しが残り負荷時にブロックしうる（agent/main.py）。
- **F サプライチェーン/CI**: 依存/イメージ脆弱性監査（pip-audit / npm audit / Trivy）が全て continue-on-error で非ブロッキングのため脆弱性ゲートが実質不在（security.yml）。補助スタックの Grafana が匿名 Admin + 埋め込み許可で公開（docker-compose.tools.yml）。

## GitHub リポジトリ設定（観測できた事実 / ツールで検証不能な範囲）

観測できた事実:
- コラボレーターは `godhuu0505`（admin）と `godai-tanaka-lvgs`（write）の2名のみ。外部（outside）コラボレーターは無し。
- 既定ブランチ `main` は保護有効（GitHub API の `protected: true`）。他ブランチは未保護。
- CI は SAST/依存/シークレット系ワークフローを備える（`codeql.yml` / `security.yml` / `dependency-review.yml` / `scorecard.yml` / `dependabot.yml` / `.gitleaks.toml`）。ただし `security.yml` の脆弱性スキャンは非ブロッキング（SEC 参照）。

利用可能な MCP ツールでは直接読み取れず、検証不能な設定（事実として明記）:
- `main` の**保護ルールの内訳**（required reviews 数・status checks 必須・force push 禁止・管理者にも適用 等）。`protected: true` は取得できるが個別ルールは列挙不可。
- Secret scanning / push protection / Code scanning（CodeQL アラート）の**有効化状態**とアラート内容。
- fork からの PR に対する Actions 承認要否、Actions の既定 GITHUB_TOKEN 権限のリポジトリ既定値。
- これらはコードから運用意図（各ワークフローの存在）を推測できるのみで、設定値そのものは本監査ツールセットの範囲外。

## 手法の妥当性・限界

- 124 エージェント・エラー0 で完了。生指摘104件のうち17件は敵対的検証で誤検知として棄却、3件は要確認に留保、84件を確定とした。
- 本監査は**静的解析**。実行時挙動（実デプロイの env 値、Cloud Run IAM による worker 保護の実効性、Firestore ルール）は対象外で、該当箇所は条件付き事実として記述している。
- 全 247 ファイルの読了証跡は `coverage-log.md`、各指摘の詳細は `findings.md` を参照。
