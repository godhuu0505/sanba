# ハッピーパス実装状況 — 実コード検証と確定計画（2026-07-08 / 最終更新 2026-07-09）

対象: 「GitHub 連携済みアプリの改修要望を、音声の要件インタビューで深掘りし、GitHub Issue 起票まで一気通貫で通す」ハッピーパス（HP1〜HP10）。

本書は [`happy-path-gap-analysis-and-plan.md`](happy-path-gap-analysis-and-plan.md)（2026-07-07 付）の §2 現状マップ・§3 安定化・§6 Issue 対応表を**上書きする正本**。前書は 2026-07-08 のマージ群で1日にして陳腐化したため、実コードに当てた再検証の結果でここに置き換える。HP の定義・段階実装の狙いは前書 §1/§4 を引き続き参照。HP7 の設計判断は [ADR-0059](../adr/0059-inquiry-logic-tree.md) を正本とする。

> **更新（2026-07-09）**: 唯一未実装だった **HP7 ロジックツリーは実装・本番リリース済み**（ADR-0059 / #460・#462）。
> `detection.*` は撤去し `inquiry.node` へ一本化。以下 §2/§3/§4/§5 の HP7・検知パイプライン記述はこの着地を反映済み。

検証方法: `apps/agent` / `apps/web` / `apps/api`+`packages/sanba_shared` / issue・commit の4系統を実コードに当てて突き合わせ。以下の file:line はすべて実コード引用。

---

## 1. 総括

一気通貫の**背骨（話す→掘る→終了→結果→起票）は端から端まで実コードで動く**。HP1〜HP10 のうち完成5・部分5・未実装0。最後まで未実装だった HP7 ロジックツリーも 2026-07-09 に実装・リリース済み（ADR-0059）。

再検証（コード直読）で分かった重要点: 検知パイプライン（gap/矛盾/確認観点）が現状ほぼ空なのは**放置バグや看板倒れではなく、品質向上のための意図的な移行の途中**である。ADR-0055 で誤検知だらけのハードコード NFR gap を撤去し（end_user モードの終了不能 #434 の原因だった）、ADR-0057 で LLM ベースの確認観点判定に置き換えている最中で、現在は「増分1＝算出＋log 出力」まで実装済み。コード側の docstring もこの設計意図を明記している（`agent:main.py:780-781`, `agent:tools/analysis.py:94-98,141-142`）。

したがって HP7 の前提（ツリーに載せるノードの供給源）は「壊れている」のではなく「ADR-0057 の後続増分でまだ UI に出していない」だけ。HP7 本体より先に、この供給源を UI/ゲートまで通す必要がある — ただし HP7 の設計深掘り（ADR-0059）で「フラット検知を経ず直接ノード書き込みで作る」と決めたため、この供給源整備は HP7 実装に統合される（§4 参照）。

> 検証時点のコード同一性: 本書のコードは `origin/main`（HEAD `7332757`）と一致。2026-07-08〜09 のマージ済み変更（#450〜#454 の観測性/インフラ）を反映済み。HP7 の8決定はこれらの変更で影響を受けないことを確認済み（§7）。

## 2. HP 別ステータス（実コード検証済み）

| # | ステップ | 状態 | 実態と根拠（file:line は各 app 相対） |
|---|---|---|---|
| HP1 | ログイン | ✅ | `web:login/page.tsx` + `web:lib/auth.tsx`（GIS）。全ページ authGate 保護 |
| HP2 | 連携済みアプリ選択 | 🔶 | 選択は動くが**「GitHub 連携済み」絞り込みは無い**。開始ゲートは `slug` 有無で判定（`web:EntryFlow.tsx:750,443-450`）。未連携でも開始可能。#441 と直結 |
| HP3 | 準備画面 | 🔶 | goal/goal_detail/添付/同意は完成（`web:EntryFlow.tsx:503-635`）。**リポジトリ/ブランチ選択は準備画面に無く**、プロダクト単位バインドで代替（`web:ProductRepoCard.tsx:129-152`） |
| HP4 | 開始と同時に裏解析 | 🔶 | 「同時に裏起動」は存在しない。上流(API/worker/ES)が事前実行 → agent は `github_index_status` を**同期ブロッキングで読むだけ**（`agent:main.py:1835,178-184`）。ゴール読取は会話前に同期シード（`agent:main.py:207-232`） |
| HP5 | 解析中バブル | 🔶 | UI バブルは実装済（`web:ChatHistory.tsx` の Setup/Context/Material）。ただし **agent は `analysis.progress` を一切 publish しない**（publish は worker のみ）。context.progress（prep/repo）だけ agent が出す（`agent:main.py:423-437,2016`） |
| HP6 | AI 主導ゴール確認 | ✅ | `open_interview`（第一声リトライ付, `agent:main.py:1611-1650`）+ `DEVELOPER_OPENING_WITH_PREP_INSTRUCTIONS`（`agent:prompts/interview.py:212-218`） |
| HP7 | **確認事項ロジックツリー** | ✅ | **実装・本番リリース済み**（ADR-0059 / #460・#462）。`inquiry_nodes`（`shared:models.py`・`shared:inquiry.py` の `InquiryTree`）・`inquiry.node` イベント・`GET /inquiry`・`web:InquiryTree.tsx`。深さ5/枝5・confidence 剪定・kind 別ゲート。`detection.*`/`DeepDiveList` は撤去 |
| HP8 | AI 主導終了 | ✅ | `propose_session_end`/`complete_session`（`agent:main.py:1327-1389`）→ web 自動遷移（`web:ConversationSessionView.tsx:222-226`） |
| HP9 | 結果生成・一覧 | 🔶 | 3対象者整形/AIタイトル/labels 完成。整形は機械 `{{placeholder}}`（`api:result_document.py:191-221`）で LLM は title/summary の2箇所のみ。ホーム過去一覧は `7f55c66` で意図的 revert、`/results` 専用 |
| HP10 | Issue 起票 | ✅ | `POST /export`、#435 finalize ゲート済（`api:deps.py:217-218`）、要約/素材 opt-in 同梱。※ 0件 finalize の残エッジは §3(B5) |

進捗要約: 完成 5（HP1/6/7/8/10）・部分 5（HP2/3/4/5/9）・未実装 0。HP7 は 2026-07-09 に着地（ADR-0059）。

## 3. 検知パイプラインの移行状態と、実バグ

### (a) 検知の供給源 — ADR-0055/0057 による移行 → ADR-0059 で完了

> **解消済み（2026-07-09 / ADR-0059）**: 下表 T1〜T3（当時の移行途中の状態）は着地済み。gap/矛盾は ADK 出力を
> 構造化して `inquiry.node`（kind=gap/contradiction）として発火し、coverage は check ノードへ、終了ゲートへ
> 算入されるようになった。以下は当時の分析記録として残す。

| # | 実態 | 根拠 | HP7 への含意 |
|---|---|---|---|
| T1 | **gap（`open_topics`）は現状ほぼ空。** 誤検知の多かったハードコード NFR gap を撤去済み | `open_topics=[]` を明示（`agent:tools/analysis.py:147,186`）。docstring が意図を明記 | ADR-0055 で誤検知除去（#434 解消）。gap は LLM 由来で再生成する枠だけ残る |
| T2 | **矛盾は構造化 publish されず、要約テキストに含まれる。** | `_run_adk` は疑問文1行のみ抽出（`agent:tools/analysis.py:183-190`）。`detection.contradiction` は agent 未呼び出し | HP7 で矛盾ノードを作るには ADK 出力の構造化が必要 |
| T3 | **確認観点カバレッジ（`coverage_open`）は算出済みだが log 止まり（ADR-0057 増分1 の設計通り）** | 算出は実装（`agent:tools/analysis.py:93-133`）だが `log.info` で終わり（`agent:main.py:693-700`）。publish・終了ゲート算入は未 | HP7 の「確認事項」に最も近い。増分2 で publish＋ゲート化すればノード源になる |

→ これらは HP7 の土台。ADR-0059 の決定で、フラット検知を経ず**最初から `inquiry_nodes` として書く**（=A1 を HP7 に吸収）。

### (b) 実バグ（是正対象）

| # | 問題 | 根拠 | 影響 |
|---|---|---|---|
| B5 | **0件 finalize → 実質空 Issue が可能** | finalize に確定要件の下限ガード無し（`api:routers/sessions.py:988-996`） | #435 とは別経路の空 Issue |
| B6 | **起票 UI の二重系統・非対称** | `web:ResultView.tsx:211-226` は opt-in 有、`web:results/[id]/page.tsx:123-134` は無条件起票 | 挙動差・PII 配慮の不整合 |

## 4. 確定計画（Phase A→D）

前書 §5 Q1 の「Phase 0→1→2→3 直列」は既に崩れている。実態に合わせ以下へ再スコープ。HP7 の設計深掘り（ADR-0059）で Phase A の検知ストリームと HP7 を統合した。

### Phase A — 「本物が動く証拠」を固める（最優先・P0）
- **A1** = HP7 のノードフィーダとして実装**済み**（ADR-0059 決定⑦ / #462）。フラット検知を復活させず、ADK 出力を構造化して `inquiry_nodes` へ直接書く（contradiction/gap、coverage→check）。#403/#354 は gap category で吸収しクローズ可能。
- **A2** 本番観測性の配線（#376）: **ほぼ完了**（2026-07-08〜09）。api/worker の Cloud Trace 直送 #453、grounding 縮退/背景タスク失敗の計測＋fail-safe #450、CD terraform 収束修復 #454。残は agent 側 span の一部。
- **A3** 本番 KB seed（#357, `scripts/seed_kb`）: 未着手。
- **A4** 0件 finalize ガード＋起票 UI 一本化（B5/B6）: 未着手。小粒で効果大。

### Phase B — 体験ギャップの穴埋め（P1）
- agent が `analysis.progress` を publish し HP5 を素材以外にも通す／HP2・#441 の repo 連携導線／#374 残（STT 品質 #442・途中切れ切り分け）。

### Phase C — HP7 ロジックツリー（ADR-0059）— ✅ 実装・リリース済み（2026-07-09）
8決定に沿って実装済み: ①データモデル+repository（#460）②ノードフィーダ ③realtime(inquiry.node+GET /inquiry) ④UI(InquiryTree→DeepDiveList/detection.* 削除) ⑤終了ゲート付け替え（#462）。A1 の検知実効化を本 Phase に統合。#403/#354 は gap の category 付与で吸収しクローズ可能。

### Phase D — ドキュメント整合
- 本書で gap-analysis §2/§3/§6 を置換。前書側にも本書への参照を追記。

## 5. Issue 対応表（2026-07-09 現在）

| 計画項目 | Issue | 状態 |
|---|---|---|
| A1 = HP7 ノードフィーダ | #403 / #354 | ✅ 実装済み（#462, HP7 に統合）。#403/#354 はクローズ可能 |
| A2 観測性配線 | #376（epic, p1） | **ほぼ完了**（#450/#453/#454）。agent span の一部が残 |
| A3 KB seed | #357（p1） | 未着手 |
| A4 0件 finalize / 起票UI | 新規（本書 B5/B6） | 未起票 |
| C HP7 ツリー | ADR-0059 | ✅ 実装・リリース済み（#460/#462） |

closed 済: #315、#411〜#419（ADR-0054）、#438/#440。

## 6. 計画に関わる未マージの設計提案 PR（Proposed）

| PR | 提案 | 状態 | 計画との関係 |
|---|---|---|---|
| #445 | A2A 委譲境界（初弾 repo-scout） | Proposed・未マージ | ADR-0046 段階2 の発展形。番号は再採番の可能性 |
| #430 | DevOps/LLMOps 成熟度ロードマップ（ADR-0058） | Proposed・未マージ | Phase A2 観測性の上位ロードマップ |

## 7. HP7 の8決定への障害対応の影響チェック（2026-07-09）

深掘り中にマージされた #450〜#454（観測性/インフラ #376＋fail-safe）が HP7 の8決定に影響しないことを確認。

- 変更ファイルは retrieval.py（grounding fail-safe）・api/worker observability・terraform・テストのみ。**検知パス4ファイル（main.py/analysis.py/events.py/background.py の検知ロジック）・finalize/export/models・DeepDiveList/RequirementsTab は未変更**。
- 決定③はむしろ確証（#451 が `analyze_transcript(transcript, check_points)` の2引数署名を確定）。決定⑦で「独立」と切り出した A2 が独立に前進しデリスク。
- 追記事項: HP7 新設経路（`inquiry.node` 発火・`GET /inquiry`・`resolve_inquiry`/`add_inquiry`・調停器のノード書き込み）も Cloud Trace span を張る（観測性の統一規律）。ADR-0059 の観測性節に反映。
