# ADR-0057: 会話の観点（check-points）カバレッジを LLM で動的に判定する（増分1: パイプライン + 観測）

- ステータス: Accepted
- 日付: 2026-07-08
- 関連: [ADR-0055](0055-end-user-detection-handling.md)（ハードコード NFR gap を廃し、観点をモード別・設定可能にした ②）/
  [ADR-0043](0043-audience-tagged-check-items-and-render-unification.md)（audience タグ付き確認項目 — 観点の正典）/
  [ADR-0046](0046-decouple-analysis-from-voice-worker.md)（背景分析の分離 — 判定を走らせる経路）/
  [ADR-0051](0051-google-native-observability-and-llmops.md)（LLMOps — 観測とルーブリック）
- きっかけ: オーナー要望「会話を進める中で観点が動的に変わると体験が良い」（②の続き）

## コンテキスト

② で「会話でカバーする観点」は `check_points_for_scope`（product 管理者設定 or モード別デフォルト）に
一本化し、開始時に instruction へシードした。ただしこれは**静的**（開始時に一度渡すだけ）で、会話の
進行に応じて「どの観点が確認済みか」を追う仕組みは無かった。`②` の gap チャネルは温存したが未供給。

「動的観点」を一度に作ると、LLM によるカバレッジ判定（品質）と、それを終了ゲートに絡めるか（②で
消した『gap で終われない』の再来リスク）と、UI 表示の 3 つが絡む。まず**小さく安全な増分**から始める。

## 決定（増分1）

### 観点カバレッジを LLM で判定し、パイプラインに載せる

背景分析（`analyze_transcript`）に、このセッションの check-points を渡し、会話でまだ十分に触れられて
いない観点を LLM が構造化 JSON で返す（`assess_check_point_coverage` / `AnalysisResult.coverage_open`）。
ADK 本体と**並行**に走らせて遅延を足さない。返すのは与えた観点の部分集合のみ（未知の文言は surface
しない安全側）。creds 無し・失敗・空入力では空を返す。キーワード一致は ADR-0055 で廃した誤検知の
再来なので使わない。

### 増分1 は「終了ゲートに絡めない」「UI にはまだ出さない」— 観測に留める

カバレッジは `check_point_coverage` 構造化ログ（総数・未カバー観点）に出すのみとし、**検知として
publish しない**。理由:

- **終了ゲートへの巻き込みを避ける**: web は未解消の `detection.gap` を一律 `unresolved` に数え
  （`selectMiniStatus`）、さらに終了提案カード（`EndProposalCard`）を `openDetections.length === 0` で
  ゲートする。カバレッジを `detection.gap` で流すと、②でまさに消した「未確認で終われない」を web 側で
  再導入してしまう。advisory を担保するには web の gating/表示から除外する必要があり、増分1 の範囲を
  超える。
- **品質が未検証**: LLM のカバレッジ判定はまだ評価データセットで固めていない。ログで実データの精度を
  観測してから UI・ゲートに載せる方が安全。

## 検討した代替案

- **キーワードでカバレッジ判定**: ADR-0055 で廃したハードコード論点の誤検知が再来するため不可。
- **カバレッジを gap 検知として終了ゲートに絡める**: 07 判定の「未解消0件で確定可」に合流させる案。
  判定が正確なら望ましいが、未検証の LLM 判定で gating を再導入すると「また終われない」を招くため増分1
  では採らない（精度確認後の増分で検討）。
- **detection.gap を再利用して UI に出す（advisory）**: web の `unresolved`/`EndProposalCard` gating から
  除外すれば非ブロッキングにできるが、既存の検知リストと概念が混ざる（ブロッキングと advisory の分離）。
  専用の「観点の進捗」表示コンポーネントで出すのが筋で、これは増分2 とする。

## 影響・帰結

- 観点カバレッジの LLM 判定パイプラインが入り、`check_point_coverage` ログで実データの精度・分布を観測
  できる（LLMOps / ADR-0051）。既存の終了・確定フローには一切影響しない（gating に絡めない）。
- `AnalysisResult.coverage_open` は増分2 以降（UI 表示・動的な観点の出し入れ）が再利用する土台。
- 後続（増分2 以降）:
  - **可視化**: ブロッキング検知と分離した「観点の進捗」UI（covered/uncovered をライブ更新）。web の
    `unresolved`/`EndProposalCard` gating と混ざらないよう専用チャネル/セレクタで出す。
  - **動的な出し入れ**: カバレッジを分析にフィードバックして未カバー観点を優先的に深掘りさせる。
  - **品質**: 代表シナリオでカバレッジ判定を CI 回帰評価（ADR-0051）。精度が固まれば gating への昇格を検討。
