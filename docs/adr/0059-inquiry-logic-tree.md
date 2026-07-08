# ADR-0059: 確認事項ロジックツリー（HP7）— 会話/解析で増減するノードの木を一級の状態にする

- ステータス: Proposed
- 日付: 2026-07-09
- 関連: [ADR-0057](0057-dynamic-check-point-coverage.md)（確認観点カバレッジ 増分1 — 本 ADR がその増分2/3。ノード供給源）/
  [ADR-0055](0055-end-user-detection-handling.md)（モード別・ハードコード NFR gap 廃止 — 終了不能 #434 の構造的解決）/
  [ADR-0046](0046-decouple-analysis-from-voice-worker.md)（背景分析の off-loop 分離 — ノードフィーダの経路）/
  [ADR-0021](0021-realtime-reliable-seq-and-persistence.md)（realtime の reliable/seq/冪等 — `inquiry.node` の契約基盤）/
  [ADR-0042](0042-result-output-formats-and-check-items.md)（結果の機械テンプレート整形 — HP9 出力への接続）/
  [ADR-0043](0043-audience-tagged-check-items-and-render-unification.md)（audience タグ付き確認項目 — ルートノードのシード源）
- きっかけ: オーナーとの設計深掘り（grill-me による一問一答で全8決定を確定）。
  正本の現状把握は [`../notes/happy-path-status-2026-07-08.md`](../notes/happy-path-status-2026-07-08.md)。

## コンテキスト

ハッピーパス HP7 は「確認事項（矛盾・未確認・整合性）をノード化し、会話/解析の進行で増減・更新する
ロジックツリー」を求める（深さ最大5・枝最大5）。しかし現状の検知は**フラット集合**であり、木構造の
データモデル・agent・realtime・UI はいずれも存在しない（`AnalysisResult.open_topics` / `DeepDiveList.tsx`）。

各 HP の前後関係を読むと、このツリーは「検知結果を後から可視化する飾り」ではなく、次を兼ねる**一級の
状態オブジェクト**だと分かる:

- HP6「解析未完なら分かる所から深掘り、完了したら**枝を生やして後追い確認**」→ 親子関係を保持する主体。
- HP8「**全ノード解消で AI が終了提案**」→ 終了判定がツリーの状態を読む（ツリーが終了条件）。
- HP9「会話ログ＋参考資料＋**確認事項**を出力フォーマットに整形」→ 解消済みツリーが成果物の骨格。
- HP3「事前確認項目（check_items）」→ ツリーの初期ルートノード群。

ADR-0057 は確認観点カバレッジを LLM で判定するパイプライン（増分1）を入れ、「増分2 で可視化・gating へ
昇格」を将来課題とした。本 ADR はその増分2/3 にあたり、**カバレッジ・矛盾・抜けを個別イベントではなく
一つのツリーのノードに統合**する。

前提として本プロダクトは**未リリース・実ユーザーは開発者本人のみ**。この事実が移行方式の判断を左右する。

## 決定

ツリーを正本とし、agent 側（プロセス）が権威ある書き手になる。8つの決定を層ごとに記す。

### ① 正本性: ツリーが正本（web 派生ビュー・二重執筆は不採用）
`sessions/{id}/inquiry_nodes` を検知の正本にする。web で親子を推論する派生ビュー（B）は HP6「枝を生やす」・
HP8「全ノード解消で終了」を駆動できず破綻。独立二重執筆（C）は ADR-0021 の冪等/整列を揺らすドリフト
リスク。Phase A の検知実効化（ADR-0057 の続き）を「ノード書き込み」として実装し HP7 と収束させる。

### ② データモデル
`inquiry_nodes/{node_id}`:
```
id / parent_id: str|None (None=root) / kind: gap|contradiction|ambiguous|check /
text / status: open|resolved|dropped / confidence: float(0-1) / depth: int(≤5,再計算保存) /
origin: conversation|analysis|prep|material / refs: list[str] / created_seq / resolved_seq
```
- サーバ側で制約強制: 深さ≤5・同一親の子≤5。超過時は `confidence` 最小の open ノードを `dropped` に丸める。
- `confidence` は剪定順の実装に必須。`refs` は根拠発話/grounding 参照で HP9 出力・トレーサビリティに使う。
- 確定要件（`requirement.upserted`）はツリーに含めない。ツリーは「未解決の確認事項」で、HP9 で両者を合成。

### ③ ツール契約: システム調停 ＋ 薄い LLM ツール
- 背景分析（`analyze_transcript`, ADR-0046）は**純粋関数のまま**、検知の束 `{kind,text,confidence,refs}` を返す。
- on-loop の調停器（`_publish_analysis_detections` を置換）が、それを**現在フォーカス中のノードの子として
  upsert**（HP6 の後追い確認）し、最新パスに現れない open を自動 resolve（既存の gap 調停ロジックの拡張）。
- 単一の書き手 `InquiryTreeRepository`（voice ループ上）が seq 採番・深さ/枝強制・剪定・冪等 id
  （`hash(kind + 正規化text)`、`parent_id` は可変フィールド）を担う。
- LLM に公開するツールは `resolve_inquiry(text)` と `add_inquiry(text, parent_hint)` の2つだけ。**id/深さ/剪定は
  触らせない**（音声 LLM の id 台帳維持は重複・誤親を招く）。フォーカスは「直近に触れた open ノード」で近似。

### ④ realtime: クリーンカットオーバー（互換投影を作らない）
- 新イベント `inquiry.node`（reliable, seq 付き, op=upsert|resolve|drop、ノード全体を upsert セマンティクスで送る）を
  単一正本にする。**同一変更で `detection.*` と `DeepDiveList` を置換・削除**。互換層・二重発火は作らない。
- ハイドレーション: 新 `GET /sessions/{id}/inquiry`（ツリー全体＋max seq、ADR-0021 の seq gap 埋め）。
- 未リリース・実ユーザー無しのため段階移行の相手が居らず、互換投影は使い捨てコストになる。開発手順として
  同一ブランチで `InquiryTree.tsx` を先に作ってから `DeepDiveList` を削除する。

### ⑤ 終了ゲート（HP8 接続）
- 終了をブロックするのは `open かつ confidence ≥ τ かつ kind ∈ {contradiction, gap, check}`。
  `ambiguous` は advisory（表示のみ・終了を止めない）。既存の「確定要件 ≥1件」は維持。
- `check` はモード別シード（`check_points_for_scope`）で end_user に企業向け観点が生えないため、#434
  （終了不能）を構造的に解決する。`τ`（confidence 閾値）は設定値化しモード別に調整可能。
- 既存の `_open_detection_count` を「ゲート対象ノード数」へ付け替える。

### ⑥ UI（`InquiryTree.tsx`）
- `docs/notes/happy-path-detailed-design.md §06` に準拠: インデント＋罫線の木、kind 別意匠
  （check=萌黄✓ / gap=山吹? / ambiguous=藍鼠〜 / contradiction=朱!）、ヘッダ集計、タップで根拠発話（refs）。
  `RequirementsTab` で `DeepDiveList` を置換。
- `JudgmentGate`/`StatusBar` のゲート数＝⑤のゲート対象ノードに限定（ヘッダの総 open とは別表示で、終了提案と
  同じ数字を見せる）。resolved は淡色✓で残し、dropped は既定非表示（折りたたみ「除外 M」）。
- 手動操作は「不要(drop)」のみ公開（`user.inquiry_drop` → 書き手が drop 適用）。**resolve は会話駆動**のまま
  （手動 resolve は終了ゲートの gaming を招くため置かない）。誤検知の剪定は人間の品質責任（CLAUDE.md）。

### ⑦ 実装統合: フラット検知を経ず直接ノード書き込み
Phase A の「検知実効化（A1）」を HP7 に吸収する。実装順: ①データモデル+repository → ②ノードフィーダ
（check_items シード ＋ 背景分析調停器 ＋ 薄い LLM ツール）→ ③realtime → ④UI（`DeepDiveList`/`detection.*` 削除）
→ ⑤終了ゲート付け替え。#403/#354（open_topics の機能/非機能分類）は gap ノードの category で吸収しクローズ。

### ⑧ HP9 接続: 解消済みノードを出力に機械レンダリング
finalize 時、`inquiry_nodes` の resolved かつ kind ∈ {check, gap, contradiction} を「確認済みの論点」チェック
リストとして新プレースホルダ（例 `{{validated_inquiries}}`）に描画。ambiguous/dropped は除外。ADR-0042 の
機械骨格を維持（要約系のみ LLM の Q2 方針に整合）。refs で各論点に根拠発話リンクを付ける。

## 検討したが採用しなかった選択肢

- **正本性 B（web 派生ビュー）/ C（独立二重執筆）**: B は agent 側に権威ある木が無く HP6/HP8 を駆動できない。
  C は ADR-0021 の冪等/整列を揺らすドリフト。→ ①で不採用。
- **realtime 案1（サーバ側二重発火で detection.* を互換投影）**: 新旧クライアント混在（デプロイ途中の
  キャッシュ済み旧 web）に強く、実ユーザーがいれば最有力。だが本プロダクトは未リリース・実ユーザー無しで
  混在が起きず、投影は作ってすぐ捨てる純コスト。→ ④でクリーンカットオーバーを採用。
- **realtime 案3（既存 detection.* を拡張し parent_id/depth を相乗り）**: detection.* の語彙は「検知が在る/解消」
  だけで drop（剪定）・reparent（付け替え）・depth・再open・check kind を表現できず、結局新 kind 増設で
  「新イベント無しで簡潔」の利点が消える。→ 不採用。
- **LLM が `update_inquiry_tree` でノード差分を直接発行**: 柔軟だが音声 LLM の id 台帳維持が不安定で重複/
  誤親を招く。→ ③でシステム調停＋薄いツールに。
- **終了ゲートに全 open ノードを算入（HP8 文言通り）**: ambiguous の heuristic ノイズで「終われない」#434 を
  再導入する。→ ⑤で kind/confidence を絞る。
- **HP9 を LLM でツリー込み全文合成**: ADR-0042 の機械テンプレート決定（Q2）を破り LLM コスト/ぶれが増える。
  → ⑧で機械レンダリングに。
- **HP7 を後回しにし先にフラット検知を復活（当初計画）**: detection を作って壊す二度手間・手戻り。→ ⑦で統合。

## 影響

- **データモデル（`packages/sanba_shared`）**: `inquiry_nodes` サブコレクションと `InquiryNode` モデル・
  `InquiryTreeRepository`（seq・深さ/枝強制・剪定・冪等 id）を新設。`AnalysisResult` は純粋出力のまま。
- **agent（`apps/agent`）**: `_publish_analysis_detections` を調停器へ置換。ADK 出力を構造化して矛盾/gap を
  ノード化、coverage（ADR-0057）を check ノードへ。`resolve_inquiry`/`add_inquiry` ツール追加、フォーカス
  追跡、終了ゲート付け替え。ADK に矛盾/抜けの構造化 JSON 出力を要求する（ADR-0055 で撤去した誤検知を
  再導入しないよう、キーワード一致は使わない）。
- **realtime / API**: `inquiry.node` イベント（ADR-0021 の reliable/seq/dedup 機構を再利用）と
  `GET /sessions/{id}/inquiry` ハイドレーションを追加。`detection.*` と `GET /detections` は削除（#355 の
  再接続復元も inquiry 経路へ移す）。
- **web（`apps/web`）**: `InquiryTree.tsx` 新設 → `DeepDiveList` 削除。`RequirementsTab`/`JudgmentGate`/
  `StatusBar` をゲート対象ノード数に接続。`user.inquiry_drop` 送信を追加。
- **HP9 / 結果（`apps/api`）**: finalize で解消済みノードをスナップショットし `{{validated_inquiries}}` を
  出力テンプレートへ追加（ADR-0042）。
- **観測性**: HP7 が新設する経路（`inquiry.node` 発火・`GET /inquiry`・`resolve_inquiry`/`add_inquiry`・調停器の
  ノード書き込み）に Cloud Trace span を張る（api/worker は #453 で Cloud Trace 直送に統一済み。
  CLAUDE.md「観測できないものは運用できない」）。剪定・自動 resolve・fallback 縮退はメトリクス化する。
- **IaC**: 新規の永続化・エンドポイントは既存 Firestore/Cloud Run 構成の範囲。専用のインフラ追加は無い想定。
- **テスト**: repository の深さ/枝/剪定/冪等 id を純ロジックで単体テスト。調停器の「フォーカス子へ upsert・
  不在で自動 resolve」を単体テスト。終了ゲートの kind/confidence 分岐を単体テスト。`detection.*` の既存
  テストは `inquiry.node` 用に書き換え。LLM の矛盾/カバレッジ判定は ADR-0051 の回帰評価データセットへ。
- **移行 / フォローアップ**:
  - クリーンカットオーバー（④）。開発中は同一ブランチで `InquiryTree.tsx` を先に作ってから `DeepDiveList`
    を削除する。#355 の一時退行・UI の一時欠けは実ユーザー無しのため許容。
  - #403/#354 は gap ノードの category 付与で吸収しクローズ。
  - Phase A の検知実効化（A1）は本 ADR に統合される。独立に残るのは A2（観測性 #376・ほぼ完了）と
    A3（KB seed #357）と A4（0件 finalize/起票 UI のバグ）。
  - 受容したリスク: ambiguous を終了ゲートから外す（重要な曖昧さは会話で gap/contradiction に昇格させる）、
    スコープが Phase A を兼ねて拡大（二度作らない分トータルは軽い）。

> 本 ADR は grill-me セッションで確定した設計判断を記録するもので、実装前の提案（Proposed）。
> 実装着手時に人間が再レビューする前提で、ノード確信度の算出方法や `τ` の初期値など数値は実データで調整する。
