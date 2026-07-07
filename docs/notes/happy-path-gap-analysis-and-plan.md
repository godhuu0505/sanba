# ハッピーパス実現計画 — ギャップ分析と段階実装（2026-07-07）

対象: 「GitHub 連携済みアプリの改修要望を、音声の要件インタビューで深掘りし、GitHub Issue 起票まで一気通貫で通す」ハッピーパス。
方針: **まず機能が動くことを最優先**（安定化 → 体験ギャップ → 新規機能 の順）。
画面設計・フロー図・契約定義の具体化は [`happy-path-detailed-design.md`](happy-path-detailed-design.md) を参照。

## 1. 対象ハッピーパス（正規化）

| # | ステップ | ユーザーの期待 |
|---|---------|--------------|
| HP1 | Google ログイン | 既存どおり |
| HP2 | ホームで GitHub 連携済みアプリを選択 | 連携済みアプリを選んで壁打ち開始 |
| HP3 | セッション準備 | ゴール・ゴール詳細を記入、対象画面のキャプチャを添付 |
| HP4 | マイク許可 → 会話開始 | 開始と同時に (a)添付ファイル解析 (b)ソースコード読み取り (c)ゴール読み取り が裏で走る |
| HP5 | 会話履歴に解析バブル | ワーカー単位で「解析中」吹き出し＋プログレスバー。参考資料タブでも進捗が同期更新 |
| HP6 | AI からゴール確認を開始 | 約1分、AI がトリガーとなりゴール・詳細を確認。解析未完なら分かる所から深掘り、完了したら枝を生やして後追い確認 |
| HP7 | 確認事項のロジックツリー | 矛盾・未確認・整合性をノード化（深さ最大5・枝最大5）。会話/解析の進行で増減・更新 |
| HP8 | AI 主導のセッション終了 | 全ノード解消で AI が終了を提案、ユーザー同意で自動終了。終了後はセッション画面へ遷移不可 |
| HP9 | 要件結果の生成・閲覧 | 会話ログ＋参考資料＋確認事項を出力フォーマットに整形。AI がタイトル・ラベル付与。ホームから過去一覧で閲覧 |
| HP10 | GitHub Issue 起票 | 添付ファイル情報（必要なら会話ログ）を付与して起票 |

## 2. 現状マップ（実装状態）

| ステップ | 状態 | 実装の所在 |
|---------|------|-----------|
| HP1 ログイン | ✅ 完成 | `apps/web/app/login/page.tsx` / `lib/auth.tsx` / `apps/api/.../auth_google.py` |
| HP2 アプリ選択 | ✅ ほぼ完成 | `EntryFlow.tsx`（ホームゲート ADR-0044）。※「GitHub 連携済み」での絞り込みは無し（slug 有無のみ） |
| HP3 準備画面 | ✅ 完成 | `EntryFlow.tsx` prepare（goal/goal_detail/添付/リポジトリ+ブランチ選択、ADR-0035/0027/0049） |
| HP4 解析の裏実行 | 🔶 部分 | 添付=アップロード時に解析（画像=同期、動画=worker 非同期）。リポジトリ=**準備/連携時に索引済み**（ADR-0028）。ゴール=接続時に同期シード（ADR-0035）。「会話開始と同時に走る」形にはなっていない |
| HP5 解析バブル | 🔶 部分 | 参考資料タブの素材単位プログレスバーは実装済（`MaterialsList.tsx`）。**会話履歴内の解析バブルは未実装**。リポジトリ読取・ゴール読取の進捗イベント自体が存在しない |
| HP6 AI 主導のゴール確認 | ✅ ほぼ完成 | `open_interview()`（第一声リトライ #374 対策済）+ `DEVELOPER_OPENING_WITH_PREP_INSTRUCTIONS`（ゴール要約→認識合わせ→深掘り） |
| HP7 ロジックツリー | ❌ 未実装 | 検知（gap/矛盾/ambiguous）は**フラット集合**（`DeepDiveList.tsx` / `AnalysisResult.open_topics`）。木構造・深さ/枝上限のモデルとUIは存在しない。`Product.check_items` もフラット最大10件 |
| HP8 AI 主導の終了 | ❌ 未実装 | agent に終了提案/終了ツールなし。web は `session.completed` を受けても自動遷移しない。※終了後の遷移ガード（`/sessions/{id}` → `/results/{id}` redirect）は実装済 |
| HP9 結果生成・過去一覧 | 🔶 部分 | 結果画面・3対象者フォーマット・AI タイトルは完成（ADR-0042）。過去一覧は `/results`（ホーム外）。**ラベル表示なし**（モデルに labels フィールドが無い）。生成は LLM ではなく `{{placeholder}}` 機械整形（ADR-0042 の意図的決定） |
| HP10 Issue 起票 | 🔶 部分 | 起票＋ラベル付与は完成（`POST /api/sessions/{id}/export`）。**添付ファイル情報・会話ログの同梱は未実装** |

## 3. 「動かない・途切れる」の根本原因（安定化対象）

体感不具合（エラー・会話の途切れ）は既に P1 Issue として特定済み。ハッピーパスの前提はここ。

| 原因 | 内容 | 状態 | 関連 |
|------|------|------|------|
| C1 分析が音声を塞ぐ | ADK 多段分析（interview_lead+3体）が音声 worker と**同一イベントループ**で `await` される。タイムアウト境界（20s/8s）は導入済みだが `analyze_transcript` のスレッド隔離が未了 | 段階1済・段階2未 | #375 / ADR-0046 / `main.py::_run_analysis` |
| C2 発話分断 | Gemini Live native audio の VAD 依存。silence 1200ms 等に調整済みだが構造的に残存 | 緩和済・残存 | #374 / ADR-0038/0039 |
| C3 第一声の欠落 | 接続直後の generate_reply が黙って落ちる。リトライ網（最大3回）で救済済み。リトライ中は無音に見える | 救済済 | #374 / `open_interview()` |
| C4 観測性が本番で無効 | OTEL endpoint 未配線でトレース不通。障害の切り分けがログ手動再構成頼み | 未対応 | #376 / ADR-0051 |
| C5 worker の CD 未配線 | `apps/worker` が `deploy.yml` の対象外。動画解析のコード変更が本番反映されない | 未対応 | ADR-0040 フォローアップ |
| C6 再接続で解析詳細消失 | `GET context/files` が status のみ返し、抽出要件/矛盾の詳細はライブ購読でしか届かない | 未対応 | #355 |
| C7 product_id 未永続化 | セッション作成時に `product_id` を渡しておらず None 保存 | 未対応 | #315 |

## 4. 段階実装計画

### Phase 0 — 安定化（最優先: 「動く」を作る）

1. **P0-1 分析のスレッド隔離**（C1）: `_run_analysis` の `await analyze_transcript(...)` を `asyncio.to_thread`（専用ループ）へ逃がす。grounding 検索（`to_thread` 済）との非対称を解消。ADR-0046 段階1の残タスク。段階2（サービス分離）は効果計測後に判断。
2. **P0-2 観測性の本番配線**（C4）: ADR-0051 の Cloud Trace 直送を実装・配線（`CloudTraceSpanExporter`）。以降の音声不具合をトレースで切り分け可能にする。
3. **P0-3 worker の CD 配線**（C5）: `deploy.yml` に `apps/worker` の paths-filter とデプロイジョブを追加。`enable_video_analysis` 本番化は runbook（`docs/how-to/enable-video-analysis.md`）に従い手動 apply。
4. **P0-4 小粒バグ**: #315（product_id 永続化）、#355（`GET context/files` に解析詳細を含める→再接続復元）、`create_session` の `github_repo=""` で product 継承がスキップされるエッジケース修正。
5. **P0-5 1ターン1問ガード**（C2 緩和）: `ask_question` 連発の抑制（プロンプト＋ガード）。#374 のタスク。

受け入れ基準: 本番相当環境で 10 分の音声セッションが途切れ・沈黙死なく完走し、トレースで各ターンが追える。

### Phase 1 — ハッピーパス体験ギャップ（会話開始〜終了の流れ）

1. **P1-1 会話履歴の解析バブル（HP4/HP5）**
   - 原則: ADR-0023「実体に正直」を維持。フェイク進捗は出さない。
   - (a) 添付ファイル: 既存 `analysis.progress`（asset 単位, received 10→analyzing 50→done 100）を `ChatHistory` にも写像し、素材ごとの「解析中」バブル＋プログレスバーとして描画。`ChatBubble` に `kind="analysis"` variant を追加。参考資料タブとはストア（`RealtimeStore.analysis`）を共有するため二重管理なし。
   - (b) ソースコード読み取り: 実体は準備/連携時の索引（`GitHubIndexStatus`）。会話開始時に agent（または API join 時）が product の索引状態を読み、`context.progress`（新イベント: `source="repo"`, stage=pending/indexing/ready/partial/failed）として publish。索引済みなら「読み込み済み ✓」バブルを即時表示、indexing 中なら実状態を表示し ready で更新。commit が進んでいた場合の再索引は既存の (repo,branch,sha) キー再利用でスキップされるため、正直に「索引済みを利用」と表示する。
   - (c) ゴール読み取り: agent がシード完了時（`build_agent_instructions` 後）に `context.progress`（`source="prep"`, done）を 1 発 publish。「ゴールとゴール詳細を読み込みました」バブル。
   - realtime 契約（`docs/design/realtime-contract.md`）に `context.progress` を追記。ハイドレーションは `GET context/files` 拡張 or 新 `GET context/status`。
2. **P1-2 AI 主導のセッション終了（HP8）**
   - agent に function tool `propose_session_end`（終了提案の発話ガイド）と `complete_session`（ユーザー同意後に呼ぶ）を追加。`complete_session` は未解消 detection 0 件を検証 → `session.completed` publish → finalize 相当の永続化（API `finalize` を agent 資格で呼ぶ or shared repository 直呼び）→ 発話で締めて `ctx.shutdown()`。
   - VOICE_AGENT_INSTRUCTIONS に「全確認事項が解消したら終了を提案する」を追加（grill-me の「ディシジョンツリーを解消しきる」原則と接続）。
   - web: `ConversationSessionView` が `state.completed` を監視し、結果フェーズへ自動遷移（既存の終了ガードはそのまま活きる）。ユーザー起点の終了ボタン（`JudgmentGate`）は併存。
3. **P1-3 ホームの過去要件一覧＋ラベル（HP9）**
   - `SessionMeta` に `labels: list[str]` を追加し、finalize 時に `requirements_to_issue_labels` の算出結果を保存。`GET /api/sessions/mine` に載せる。
   - ホーム（`EntryFlow` home）に `SessionHistoryList`（直近 N 件＋「すべて見る→/results」）を配置。ラベルはバッジ表示。
4. **P1-4 ホームのアプリ選択を「GitHub 連携済み」前提に（HP2）**: 連携未済アプリ選択時は準備画面でリポジトリ連携を促す導線を明示（絞り込みではなく案内。連携なしでも開始自体は可能なまま）。

受け入れ基準: キャプチャ添付→会話開始→バブル3種表示→ゴール確認→深掘り→AI 終了提案→同意→自動終了→結果画面、が一連で通る。

### Phase 2 — 確認事項ロジックツリー（HP7、新規機能・要 ADR）

現状の検知はフラット集合であり、ツリーはデータモデル・agent・realtime・UI の4層すべて新設になる。**ADR 起票の上で着手**。

- データモデル（`sanba_shared`）: `sessions/{id}/inquiry_nodes/{node_id}`
  - `{ id, parent_id: str|None, kind: gap|contradiction|ambiguous|check, text, status: open|resolved|dropped, depth: int(≤5), origin: conversation|analysis|prep|material, created_seq, resolved_seq }`
  - 制約はサーバ側で強制: 深さ最大5・同一親の枝最大5（超過は最も確信度の低いノードを丸める）。
- agent: `analyze_requirements` の結果（open_topics/ambiguous/矛盾）をフラット publish ではなく「既存ツリーへの差分（ノード追加・解消・付け替え）」として書き込むツール `update_inquiry_tree` に置換。会話で解消された論点は resolved に落とす。深掘り中に解析が完了した場合は、該当ノードの子として枝を生やす（HP6 の「後追い確認」）。
- realtime: `inquiry.node`（upsert/resolve、reliable）イベント新設。既存 `detection.*` は互換期間の後にツリーへ統合。
- web: `DeepDiveList` をツリービューに置換（`RequirementsTab` 内）。未解消ノード数を確定ゲート（`JudgmentGate`）・状況バー・P1-2 の終了提案条件に接続。
- `Product.check_items`（事前確認項目）はツリーの初期ルートノード群としてシードする（kind=check）。

受け入れ基準: 会話・解析の進行でノードが増減し、全ノード resolved で AI が終了提案する。深さ・枝の上限がサーバ側で守られる。

### Phase 3 — Issue 起票の強化（HP10）

- 会話ログ: 発話 transcript を `<details>` 折りたたみで Issue 本文に同梱（既定 off のオプション、PII 配慮）。
- 添付ファイル: GitHub Issues API は画像アップロード非対応のため、素材は「ファイル名＋解析観察サマリ＋SANBA 結果画面へのリンク」を本文に記載する方式を推奨（署名 URL の直貼りは期限切れ・情報漏えいリスクがあるため不採用）。リポジトリへの blob コミット方式は書き込み権限拡大（現 GitHub App は read-only）が必要なため見送り。
- `POST /export` にオプション `{ include_transcript, include_materials }` を追加し、結果画面の起票 UI にチェックボックスを付ける。

## 5. 決定事項（2026-07-07 ヒアリング確定）

| # | 論点 | 決定 |
|---|------|------|
| Q1 | 着手順 | **Phase 0（安定化）→ 1 → 2 → 3 の直列**。P1-1(a)/P1-3 など独立な UI 系は並行可 |
| Q2 | HP9 の結果生成 | **ハイブリッド**: ADR-0042 の機械整形骨格を維持し、`{{conversation_summary}}` 等の要約系プレースホルダのみ LLM 生成で追加（ADR-0042 の改訂 or 補遺として記録する） |
| Q3 | ロジックツリー（Phase 2） | **Phase 0/1 で一気通貫を確保した後に着手**。それまで AI 主導終了（P1-2）の終了条件は「未解消検知 0 件」で代用 |
| Q4 | Issue への同梱（Phase 3） | **会話ログは要約のみ・素材はファイル名＋解析観察サマリ＋結果画面リンク・既定 off**（起票 UI のチェックボックスで opt-in） |

## 6. 関連 Issue 対応表

| 計画項目 | 既存 Issue |
|---------|-----------|
| P0-1 | #375（ADR-0046 段階1残） |
| P0-2 | #376（ADR-0051） |
| P0-4 | #315 / #355 |
| P0-5 | #374 |
| Phase 2 | #403/#354（open_topics 分類はツリー化時に kind へ吸収） |
| 文言整理 | #411〜#419（本計画とは独立、衝突注意: 会話系コンポーネントを両方が触る） |
