# ADR-0055: end_user モードの論点検知 — 開発者向け NFR gap を出さず会話を終われるようにする

- ステータス: Accepted
- 日付: 2026-07-08
- 関連: [ADR-0032](0032-guest-join-and-enduser-mode.md)（ゲスト入場・end_user モードの語彙遮断）/
  [ADR-0022](0022-conversation-realtime-model-ambiguous-and-voice-state.md)（検知 gap/contradiction/ambiguous）/
  [ADR-0024](0024-grill-me-interview-persona.md)（grill-me ペルソナ）/
  [ADR-0042](0042-result-output-formats-and-check-items.md)（確認項目・確定ゲート）
- 出典: 本番セッション `sess-80ac0e4b`（Issue #434 タスク1）

## コンテキスト

`interview_mode=end_user` は「アプリの利用者に使い心地を聞く」モードで、技術用語を出さず
体験の具体化（いつ・どの画面で・何に困ったか）を掘る（ADR-0032）。一方、要件分析の
gap 検知は `tools/analysis.py::heuristic_open_topics` が返す**開発者向け NFR の固定5論点**
（性能・レイテンシ / 可用性・SLO / セキュリティ・プライバシー / コスト・予算 / 対象規模）を
キーワード一致で判定している。

本番 `sess-80ac0e4b`（end_user・約5分）で次の破綻が起きた:

- 使用感の会話には上記 NFR キーワードが出ないため、5論点が**常に全件 gap（未解消）**として
  検知・表示され続けた。
- end_user ペルソナのプロンプトは NFR を追わないので会話では無視される → 「表示されるが
  会話では触れられない」ちぐはぐな体験。
- `propose_session_end` は未解消検知が0件でないと終了提案しない（ADR-0042 の確定ゲート）。
  よって `open=5` が永久に残り、**AI 主導の終了提案が一度も発火せず、正常終了できない**
  （ユーザーは手動退出）。

`_publish_analysis_detections` に `interview_mode` のゲートが無いのが直接原因。

## 決定

**end_user モードでは gap（開発者向け NFR の open_topics）を検知として publish しない。**
ambiguous（会話中の曖昧語 = 使用感インタビューでも有意）は従来どおり出す。

- `_publish_analysis_detections` で end_user のとき gap 集合を空にする（永続化も publish も
  しない）。developer モードは従来どおり。
- これにより end_user の `_open_detection_count()` は「実際の曖昧語」だけで決まり、要件が
  揃えば（`propose_session_end` の要件≥1条件を満たせば）終了提案が発火する。
- 「未解消 N」カードにも無関係な NFR が出なくなり、プロンプト（無視）と表示が一致する。

## 検討した代替案

- **end_user 専用の論点セット（使用感・つまずき・期待とのギャップ等）へ差し替え**: より
  リッチだが、新しいヒューリスティック/プロンプト設計と評価データが要る。まず破綻
  （終了不能）を最小変更で止めることを優先し、専用論点セットは将来の改善（別 issue）とする。
- **gap も出すが `propose_session_end` の条件から end_user では除外**: 表示の
  ちぐはぐ（無関係カードが残る）が解消しない。検知自体を出さない方が一貫する。

## 影響

- end_user セッションが構造的に正常終了できる（AI 終了提案 → 同意 → 自動確定）。
- developer モードの gap 検知・NFR 追跡は不変（回帰テストで担保）。
- 将来: end_user 向けの体験ベース論点セットは未実装（`heuristic_open_topics` は開発者向けの
  まま）。導入時は本 ADR を改訂する。
