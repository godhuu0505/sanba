# ADR-0055: 会話でカバーする観点をモード別・設定可能にし、ハードコード NFR gap 検知を廃止する

- ステータス: Accepted
- 日付: 2026-07-08
- 関連: [ADR-0032](0032-guest-join-and-enduser-mode.md)（end_user モード — 本 ADR がモード別の観点差を補う）/
  [ADR-0043](0043-audience-tagged-check-items-and-render-unification.md)（audience タグ付き確認項目 — 観点の設定・シードの正典。本 ADR がデフォルトとフォールバックを足す）/
  [ADR-0046](0046-decouple-analysis-from-voice-worker.md)（背景分析 — gap/ambiguous を publish する経路）/
  [ADR-0051](0051-google-native-observability-and-llmops.md)（LLMOps — 品質採点のルーブリック）
- 起票 Issue: #434（end_user モードのインタビュー体験を production-ready にする）

## コンテキスト

本番セッション `sess-80ac0e4b`（`interview_mode=end_user`・使用感インタビュー）で、会話が
**構造的に正常終了できない**欠陥が判明した。原因は gap（抜け）検知の供給源だった
`analysis.heuristic_open_topics`。この関数は企業向け NFR の固定 5 論点（性能・レイテンシ /
可用性・SLO / セキュリティ・プライバシー / コスト・予算 / 対象ユーザー・規模）を
**キーワード一致だけ**で判定していた。

この設計には二重の問題があった。

1. **誤検知でブロックする**: 使用感インタビューでは NFR キーワードが会話に出ないため 5 件が
   恒久 open となり、終了提案（`propose_session_end` は open=0 が条件）・確定（サーバ
   `finalize` は `list_open_detections` が空でないと 409）を永久にブロックした。同じ NFR が
   詰まる現象は developer セッション `sess-6523db5e`（#435）でも起きていた。
2. **観点がハードコードで、対象アプリに合わない**: 固定 5 論点はアプリや会話相手（利用者か
   開発者か）に依らず一律。ADK チームの NFR/矛盾サブエージェントも `open_topics` を上書き
   せず（`_run_adk` は heuristic 値をそのまま返していた）、キーワード一致が実質唯一の
   「gap 供給源」だった。「単発・薄い実装」を避ける本リポジトリの方針（CLAUDE.md）にも反する。

一方で「会話で必ず確認する観点」を持つ仕組みは既に `check_items`（ADR-0043）にある。product
の管理者が audience タグ付きで登録し、モードで絞り込んで instruction にシードする。ただし
**未設定時のフォールバックが無く**、また gap 検知（ハードコード NFR）と二本立てで重複していた。

なお #434 タスク1 の初手は「end_user のときだけ gap を publish しない」ゲート（`gate_gaps`）
だった。これは誤検知でのブロックは止めるが、ハードコード論点がアプリに合わない問題と重複は
残るため、本 ADR の「廃止 + モード別・設定可能な観点」で**置き換える**（その暫定ゲートは撤去）。

## 決定

### 1. ハードコードの NFR gap 検知（`heuristic_open_topics`）を廃止する

`heuristic_open_topics` を削除し、`analyze_transcript` / `heuristic_result` / `_run_adk` は
`open_topics` を空にする。gap 検知の**チャネル**（`_publish_analysis_detections` の gap 経路・
`detection.gap` イベント・`AnalysisResult.open_topics`）は汎用の配線として残すが、現状は誰も
供給しない。終了・確定を gap でブロックするのは曖昧語（ambiguous）検知だけになる。ambiguous は
言い回し由来でモード非依存なので従来どおり出す。

### 2. 会話でカバーする観点を「モード別・設定可能・デフォルト付き」にする

観点は `check_items`（ADR-0043、product 管理者が設定）を正典にし、**該当モードの設定が 1 件も
無ければモード別デフォルト**へフォールバックする（`sanba_shared.check_points_for_scope`）。

- **end_user（利用者）— 現場への影響を聞く**: 使う場面（ユースケース） / 誰がどんなことに
  困っているか（ユーザーストーリー） / 規模・頻度 / 深刻度・緊急度 / 現状の受け止め（温度感）。
- **developer（開発者）— 技術面を深掘る**: 性能・レスポンス / セキュリティ・権限・データ保護 /
  コスト・予算 / 他機能・仕様との整合性と影響範囲 / 運用での回避策（ワークアラウンド）の有無。

設定があればそのモードではデフォルトを出さない（「事前設定 > デフォルト」）。デフォルトは
**product があるときだけ**適用する（product 不在の旧 1:1 セッション・セッション文書が読めない
フェイルクローズ時は素のまま。private 情報混入を避ける既存方針と揃える）。観点は instruction に
シードして会話で追わせる（advisory）＝ gap 検知でゲートしない。

### 3. 評価の nfr_coverage ルーブリックは残す

LLMOps の品質採点（ADR-0051）の `nfr_coverage` 軸は「開発者会話で技術面を十分掘れたか」を
可視化する価値があるので**残す**。ハードコード関数への依存だけを外し、LLM judge が無い
フォールバック採点は evaluation 内のローカルなキーワード近似（会話ゲートではない）に閉じる。

## 検討した代替案

- **gap をゲートから外すだけ（残置）**: gap 検知を非ブロッキングのヒントに格下げする案。
  誤検知でのブロックは消えるが、ハードコード 5 論点がアプリに合わない問題と重複は残る。
  観点を product 設定＋モード別デフォルトに寄せるほうが筋が良いので採らない。
- **ADK の本物 gap に置換**: ADK の NFR/矛盾サブエージェント出力を構造化 gap に配線して
  heuristic を置換する案。品質は上がるが工数大＋評価データセット（ADR-0051）が要る。
  即時の終了不能解消には過剰なので後続（動的観点）に回す。

## 影響・帰結

- end_user / developer セッションは NFR 誤検知で詰まらず、要件が揃えば終了・確定に到達できる。
- 観点が対象アプリの管理者設定に従い、未設定でもモードに合ったデフォルトが働く。
- developer モードの技術観点に「整合性・影響範囲」「運用回避策の有無」を追加（owner 要望）。
- 品質可視化（nfr_coverage）は維持。gap 検知チャネルは将来の動的観点のために温存。
- 後続（follow-up）:
  - **動的観点**: 会話の進行に応じて観点を出し入れする（gap チャネルを再利用して `open_topics`
    を賢く埋める）。体験向上のための拡張で、評価データセットを伴う。
  - 管理画面で「未設定時に使われるデフォルト観点」を提示・複製できる UI。**実装済み**:
    `DEFAULT_CHECK_POINTS` を single source of truth とし、`GET /api/products/{id}` のレスポンスに
    `check_point_defaults`（mode→list）を同梱する（`output_format_defaults` と同じミラー方式で
    drift を防ぐ）。web の `ProductCheckItemsCard` は、そのモードに該当する `check_items` が 1 件も
    無い（＝デフォルトが働く）モードについてデフォルト観点を提示し、「デフォルトを複製」で当該
    モードの対象（end_user→利用者向け / developer→開発者向け）付き `check_items` として投入する
    （`MAX_CHECK_ITEMS=10` の上限を尊重）。併せて end_user デフォルト観点に「操作でつまずいた箇所」
    「期待とのギャップ」を追加し、体験ベースの論点を厚くした。
  - finalize されずに離脱した際の保全導線（#435 関連）。
