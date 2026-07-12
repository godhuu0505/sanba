# ADR-0073: PTT の手動ターン化（押している間は途切れず・離したら即応答）

- ステータス: Accepted
- 日付: 2026-07-13
- 関連: [ADR-0066](0066-voice-conversation-transcription-turn-layering.md)（音声三層分離。本 ADR は
  そこで将来スコープ S4 として残した決定論的 PTT-B の実現）/
  [ADR-0038](0038-voice-session-resilience-and-turn-detection.md)（セッション再起動と自動ターン検出）
- きっかけ: 本番セッション sess-51131210 で、PTT ボタンを押して話している最中に少し間を空けると
  会話が途切れ、押しっぱなしのままなのに音声エージェントが被せて話し始める、とオーナーが報告。
  本来 PTT は「押している間は聴いて待機し、間が空いても聴き続け、離したら話し始める」挙動が期待される。

## コンテキスト

ADR-0066 S3 で導入した PTT-A は、クライアントの mic ゲート（押下＝publish / 離す＝停止）だけで
実装されており、Gemini Live のサーバ側自動発話終端検知（VAD）は `disabled=False` のまま常時有効
（既定 `silence_duration_ms=1200`）だった。よって押下中でも 1.2 秒の無音で Gemini が発話終了と判定し、
エージェントが応答を開始する。ボタン押下状態は mic ゲートとしてクライアントに閉じており、
サーバは「無音」しか見ないため、これは PTT-A の設計上の限界だった（ADR-0066 §結果でフラグメント化
リスクとして明記済み）。

`livekit-agents` / `plugins-google 1.6.0` のソースで、決定論的な手動ターンの実 API を検証した。

- `RealtimeModel` を `realtime_input_config.automatic_activity_detection.disabled=True` で構築すると
  サーバ VAD が切れ、`capabilities.turn_detection=False`・`_manual_activity_detection=True` になる
  （`plugins/google/realtime/realtime_api.py`）。
- 手動時は `RealtimeSession.start_user_activity()` が `activity_start` を、`generate_reply()` が
  `_in_user_activity` のとき `activity_end` を送ってから生成を起こす（Gemini は最後を user ターンで
  終える必要があるため placeholder を挿入する契約）。`commit_audio()` は Gemini では no-op。
- `AgentSession.interrupt()` は `activity.interrupt()` 経由で `rt_session.interrupt()`→
  `start_user_activity()` を呼ぶ。よって**押下時の明示バージインがそのまま `activity_start`（＝手動
  ターン開始）を兼ねる**。自動 VAD 由来のバージインは手動時に無効化されるが、明示バージインは効く。
- `realtime_input_config` は構築時固定で `update_options` では変えられない。よって auto↔manual の
  切替は Gemini セッション再構築を要する（ADR-0066 §37 の「常時 manual + 即時トグルは不可」に一致）。

## 決定

1. **PTT モードのセッションを手動ターンで構築する。** `build_turn_detection(manual=True)` で
   `automatic_activity_detection.disabled=True`（VAD 全停止）、`AgentSession(turn_detection="manual")` を
   組む。handsfree モードは従来どおり auto VAD（`disabled=False`・framework 既定ターン検出）で構築し、
   挙動を変えない（回帰なし）。
2. **押下＝ターン開始、離す＝ターン確定。** web は PTT のライフサイクルを明示イベントで送る。
   - 押下 `user.turn_start` → agent は `interrupt_playback`（＝`session.interrupt()`）を呼ぶ。手動時は
     これが `activity_start` を送って発話ターンを開き、同時に読み上げ中のエージェントを黙らせる（バージイン）。
   - 離す `user.turn_commit` → agent は応答監視つきの `generate_reply`（`_guarded_turn_reply`）を呼ぶ。
     手動時はこれが `activity_end`＋生成をトリガし、離した瞬間に応答が始まる。
   押下中は Gemini VAD が動かないため、無音がどれだけ続いても発話は途切れない。
3. **モード切替はセッション再構築で反映する。** web は接続時と切替時に `user.mic_mode` を送る。
   agent は現在の手動/自動と食い違うときだけ再構築する（`user_turn_claims` の予算＝エラー再起動枠は
   消費しない専用経路）。文脈は既存の resume 機構（transcript 末尾の注入）で保つ。既定モードは PTT
   なので通常フローで切替＝再接続はほぼ発生しない。
4. **手動ターン中はターン沈黙 watchdog を止める。** `_TurnReplyWatchdog` は user final で arm され、
   無応答なら nudge（`generate_reply`）→再起動で回復する自動 VAD 向けの安全網。手動 PTT では
   Gemini が押下中に途中 final を出しうるため、これが押しっぱなし中に nudge して被せ発話を再発させる。
   押下（`turn_start`）で disarm し、押下中は final でも arm しない。応答は離した確定でのみ起こす。
5. **config フラグ `PTT_MANUAL_TURN_ENABLED`（既定 ON）で段階導入・即ロールバック可能にする。**
   OFF なら手動ターン化を無効にし、PTT は従来の PTT-A（mic ゲート＋auto VAD）に戻る。web は常に
   新イベントを送るが、agent はフラグと現在モードで実行可否を判定するので web/agent のデプロイ順に
   依存しない。

## 検討したが採用しなかった選択肢

- **PTT 時だけ `silence_duration_ms` を延ばす（例 5 秒）**: ①離した後もその秒数ぶん無音待ちが入り
  「離したら即応答」に反する、②閾値超えの間は結局途切れ根治しない、③`silence_duration_ms` も構築時
  固定でモード別化には結局再構築が要る（グローバル延長は handsfree を重くする）。どの軸でも手動ターンに
  劣る。却下。
- **Gemini を常時 manual にして handsfree を silero VAD で駆動する**: 切替の再構築を無くせるが、
  handsfree の終端検出を別実装に載せ替えることになり回帰面が大きい。既定 PTT では切替自体が稀なので、
  再構築コストを払う方が安全。見送り（ADR-0066 の代替案 silero と同旨）。
- **押下の `user.interrupt` を流用し新イベントを足さない**: 押下は既存 `user.interrupt` で兼ねられるが、
  離しの確定信号は新設が必須で、押下側だけ流用すると「押下＝interrupt / 離し＝turn_commit」と非対称に
  なり意図が読めない。PTT ライフサイクルを `turn_start`/`turn_commit` の対で明示する方が保守的。却下。

## 影響

- apps/agent `config.py`: `ptt_manual_turn_enabled`（env `PTT_MANUAL_TURN_ENABLED`, 既定 True）を新設。
- apps/agent `main.py`: `build_turn_detection(manual)` / `build_realtime_model(manual_turn)` を手動対応に。
  entrypoint に現在モード（`manual_turn_active`）・押下状態（`ptt_hold_active`）を持たせ、`_start_session`
  がモードで VAD と `turn_detection` を選ぶ。`_rebuild_for_mode`（再起動枠非消費）を新設。`_on_data` に
  `user.mic_mode` / `user.turn_start` / `user.turn_commit` を配線。user final の watchdog arm を押下中は抑止。
- apps/agent `events.py`: `decode_user_mic_mode` / `decode_user_turn_start` / `decode_user_turn_commit` を新設。
- apps/web `types.ts` / `parse.ts` / `useRealtimeSession.ts` / `usePushToTalk.ts`: `user.mic_mode` /
  `user.turn_start` / `user.turn_commit` のエンコード・送信、PTT の押下/離し/モード変更/接続・再接続時に
  送出。押下=`turn_start`（従来の `user.interrupt` を置き換え）、離し=`turn_commit` の対で必ず送り、
  ターンの開閉を一致させる（dangling turn を作らない）。接続時の `mic_mode` は agent 既定（PTT=手動）と
  一致するので冪等だが、agent 再起動で既定に戻った場合の再整合として再接続時にも送る。
- docs `realtime-contract.md`: §4.5 に 3 イベントを追記。
- 観測性: `ptt_mic_mode_changed` / `ptt_turn_committed` / `voice_session_mode_rebuilt` を残す。
- 回帰境界: handsfree のセッション構築・ターン検出は不変。フラグ OFF で PTT も従来挙動へ戻る。
- テスト: agent はデコーダ 3 種・`resolve_manual_turn`・`build_turn_detection(manual)`・押下中の watchdog
  抑止・確定での応答生成を、web は 3 エンコーダと usePushToTalk の送出タイミングを検証する。

## 未決事項

1. Gemini manual 契約の実機挙動（`activity_start`/`activity_end` の往復と生成タイミング）は本番相当の
   実セッションで最終確認する（ユニットは framework 契約とロジックまで）。
2. モード切替時の再接続 UX（切替ボタンの一瞬のローディング表示）は必要になれば別 PR で足す。
3. 誤タップ（極短押下・ほぼ無音の commit）の抑止（最短ホールド or `turn_cancel`＝`clear_user_turn`）は、
   実運用で blurt が問題になれば別 PR で足す。v1 は turn の開閉を必ず一致させる単純形にする。
