# ADR-0055: end_user モードの検知（gap/ambiguous）の扱い — 企業向け NFR gap を出さない

- ステータス: Accepted
- 日付: 2026-07-08
- 関連: [ADR-0032](0032-guest-join-and-enduser-mode.md)（ゲスト入場・end_user モード — 本 ADR が検知面の扱いを補う）/
  [ADR-0037](0037-decouple-analysis-from-voice-worker.md)（背景分析 — gap/ambiguous を publish する経路）/
  [ADR-0043](0043-audience-tagged-check-items-and-render-unification.md)（audience タグ付き確認項目 — モード別の論点供給の正典）/
  [ADR-0046](0046-decouple-analysis-from-voice-worker.md)（分析の音声ワーカー分離）
- 起票 Issue: #434（end_user モードのインタビュー体験を production-ready にする）

## コンテキスト

本番セッション `sess-80ac0e4b`（`interview_mode=end_user`・使用感インタビュー）で、会話が
**構造的に正常終了できない**欠陥が判明した。ユーザーは最終的に手動退出している。

検知の gap（抜け）は `analysis.heuristic_open_topics` が供給する。この関数は依存ゼロの
フォールバック / pre-filter として、企業向け NFR の固定 5 論点（性能・レイテンシ / 可用性・SLO /
セキュリティ・プライバシー / コスト・予算 / 対象ユーザー・規模）を**キーワード一致だけ**で
判定する。使用感インタビューでは該当キーワードが会話に出ないため、5 件すべてが恒久的に
「未確認」として残る。

この 5 件は `_publish_analysis_detections` が `interview_mode` に関係なく検知（`kind=gap`）として
永続化・publish し、`propose_session_end` は `_open_detection_count()` が 0 でないと終了提案を
出さない。結果として open=5 が最後まで残り、**終了提案カードが一度も出せない**。

一方 end_user ペルソナの instruction は NFR を追わない（ADR-0032 決定6）。よって会話上は
5 論点を無視するのに画面には未確認事項として出続ける、というちぐはぐも生じていた。

同じ「open 検知が終了・確定をブロックする」経路は #435（未 finalize での空 Issue 起票）とも
地続きである。finalize は `list_open_detections` が空でないと 409 で拒む設計であり、誤検知で
open が詰まると確定に到達できない。

## 決定

### end_user では NFR gap 検知を surface しない

`_publish_analysis_detections` は `interview_mode is END_USER` のとき、`heuristic_open_topics`
由来の gap（`kind=gap` / detector=NFR）を**永続化も publish もしない**。ambiguous（曖昧語）検知は
言い回し由来でモード非依存（利用者が「いい感じにして」と言うのは実在の曖昧さ）なので、
従来どおり出す。

判定はモードが確定している 1 箇所（agent 内 `self._interview_mode`）で行い、分析ロジック
（`heuristic_open_topics` 自体）には手を入れない。分析結果（`open_topics`）は観測性のため
`analysis` ログにはそのまま残す（何を検知したかは追える）。

### end_user の論点供給は確認項目（check_items）に寄せる

end_user で「何を確認すべきか」は、企業向け固定 NFR ではなく product 管理者が登録した
audience タグ付き確認項目（ADR-0043）と、instruction のペルソナで供給する。end_user 専用の
論点セット（使用感・つまずき・期待とのギャップ等）を gap 検知として自動生成するのは、
本 ADR のスコープ外の後続課題とする（#434 タスク1 の残作業）。

## 検討した代替案

- **`heuristic_open_topics` を end_user 用に差し替える**: end_user 用の別論点セットを返す。
  価値は高いが「良い end_user 論点とは何か」の設計と評価データセットが要る（LLMOps / ADR-0051）。
  終了不能という P1 の即時解消には過剰なので後続に回し、本 ADR は「出さない」を先に確定する。
- **`propose_session_end` を end_user だけ open 無視で通す**: 検知は出したまま終了だけ許す案。
  画面に無関係な未確認事項が残り続けるちぐはぐを解消できず、finalize の 409 ゲートとも衝突する
  ため採らない。検知そのものを出さないほうが UI と確定の両方が整合する。

## 影響・帰結

- end_user セッションは NFR gap で詰まらず、要件が揃えば `session_end_proposed` が発火できる。
- ambiguous 検知は残るため、end_user でも曖昧な要望の深掘りは従来どおり働く。
- developer モードの NFR gap は不変（回帰防止テストで固定）。
- 観測性は保つ（`analysis` ログの `open_topics` は従来どおり）。
- 後続: end_user 向けの論点セット生成（使用感・つまずき）と、finalize されずに離脱した際の
  保全導線（#435 関連）を別 Issue で扱う。
