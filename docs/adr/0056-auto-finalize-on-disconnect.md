# ADR-0056: 未確定のまま離脱したセッションを離脱後始末で自動確定し、要件を保全する

- ステータス: Accepted
- 日付: 2026-07-08
- 関連: [ADR-0053](0053-github-permission-split-and-issue-export-gate.md)（確定＝export の起点・起票ゲート。#435 の finalize ゲートを追加した ADR）/
  [ADR-0046](0046-decouple-analysis-from-voice-worker.md)（背景分析の分離・離脱後始末のドレン）/
  [ADR-0032](0032-guest-join-and-enduser-mode.md)（ゲストセッションの承認・TTL 方針）
- 出典: 本番セッション `sess-6523db5e`（Issue #435 🟠）

## コンテキスト

`finalize`（確定）は「要件の承認（draft→approved / TTL 解除）と export の起点」（ADR-0053）。
本番 `sess-6523db5e` では、参加者が確定導線に乗らず未解消トピックを残したまま disconnect
（`CLIENT_INITIATED`）し、**12 件の要件が draft のまま**残った。draft は 30 日 TTL の対象なので、
export しなければ**消える**。さらに #435 で追加した finalize ゲートにより、未確定セッションは
export も塞がれる（結果画面には 12 件見えるのに「未確定」で起票不可）。

会話を締めた happy path は web が `POST /api/sessions/{id}/finalize` を呼ぶが、離脱・強制終了・
タブ閉じ・回線断ではこれが発火しない。つまり**離脱時に成果物が保全されない穴**がある。

## 決定

### 離脱後始末（agent の close callback）で自動確定する

voice agent の `entrypoint` 終了コールバック（`_on_close`）で `auto_finalize_if_needed()` を呼び、
**未 finalized かつ確定要件が 1 件以上あるセッションを最小構成で確定**する。agent は disconnect を
サーバ側で確実に受けられる（web 依存の導線と違い、突然の切断でも発火する）。

確定処理は既存の共有部品を使い、api の `finalize` と同じ意味論にそろえる:

- 確定集合 = **却下（rejected）以外**の要件（`requirements_to_render_dicts` / `requirement_doc_to_contract`
  と同じ倒し方）。ラベルは `requirements_to_issue_labels`（api / agent 共通）。
- `SessionRepository.finalize_session` で確定スナップショット（`finalized_requirement_ids` / 件数 /
  ラベル）を刻み、`set_requirement_status(APPROVED)` で TTL を解除する（ゲストは `keep_expiry=True`
  を踏襲＝セッション文書自体の TTL に従う / ADR-0032）。
- `approved_by="agent:auto_finalize"` で自動確定を監査上区別する。`session_auto_finalized` を構造化
  ログに残す。

### LLM 生成（タイトル・要約）は行わない

退出猶予（LiveKit ~10s。score_session の SIGKILL 対策と同じ制約）を圧迫しないため、通常 finalize が
行う会話タイトル・要約の LLM 生成は**しない**。これらは表示上の付加価値で、欠けてもデータ保全・
export 整合には影響しない（会話を締めた通常 finalize では従来どおり生成される）。確定処理は
Firestore への軽量な書き込みだけなので猶予内に収まる。データ保全を最優先するため、`_on_close` では
ドレン・採点より**前**に自動確定を実行する。

### 未解消検知は確定を妨げない

api の finalize エンドポイントは未解消検知 0 件を要求する（409）が、自動確定は**要求しない**。
離脱ケースは未解消を残したまま抜けるのが常態であり、そこで確定を拒むと保全できない。07 判定の
「未解消 0 件で確定可」は会話を締める通常フローの UX ガードであって、離脱時のデータ保全とは目的が
異なる。

## 検討した代替案

- **保全のみ（TTL 解除だけ、finalize しない）**: 要件は消えないが status は未確定のままで export は
  引き続き不可（「見えるが起票できない」が残る）。データ保全と export 整合を両取りできないため不採用。
- **web で離脱前に確定を促す**: 強制終了ダイアログや `beforeunload` で finalize を呼ぶ。突然の切断
  （タブ閉じ・回線断）で取りこぼすため、サーバ側の確実な発火に劣る（併用は可）。
- **agent から api の finalize エンドポイントを HTTP で呼ぶ**: ロジック重複ゼロだが、agent に api の
  URL とセッショントークン発行（署名鍵）が必要になり結合が増える。かつ api 側で LLM 生成が走ると
  退出猶予を超えうる。共有ヘルパ経由の最小確定のほうが軽く堅い。

## 影響・帰結

- 離脱しても確定要件が保全され（approved / TTL 解除）、export も可能になる（#435 🟠 を解消）。
- 自動確定と手動確定は `approved_by` / `session_auto_finalized` ログで区別できる。
- 既に finalized なら冪等に no-op（happy path と二重確定しない）。
- タイトル・要約は自動確定では付かない（表示上の差。データには影響しない）。
- ゲストセッションは従来どおり `keep_expiry=True`（セッション文書の TTL に従う）。
- 部分書き込み耐性: スナップショット（`finalize_session`、1 write）を承認ループの**前**に置くため、
  仮に多数の要件で承認ループ中にプロセスが kill されても、確定マーカと export スナップショットは
  残る（未承認の末尾要件は draft のまま TTL に従う）。書き込みは `set_requirement_status` が
  要件ごとに get+write する分、件数に比例するので、退出猶予を守るためデータ保全を最優先に配置する。
- 失敗は握りつぶさず `auto_finalize_failed` を残す（`_on_close` は例外でシャットダウンを止めない）。
- 後続: web の強制終了/離脱導線でも確定を促す UX（サーバ自動確定の上乗せ）。
- 既知の制約: `score_session` は end_user でも developer ルーブリックで採点する既存の課題があり
  本 ADR では触れない（別途 mode 別採点の導入で解消する）。
