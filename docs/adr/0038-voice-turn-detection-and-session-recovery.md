# ADR-0038: 音声ターン検出を保守側に倒し、音声セッションを自動復旧させる

- ステータス: Accepted
- 日付: 2026-07-05

## コンテキスト
実際のインタビュー運用で、音声エージェントに2つの問題が観測された。

1. **被せ発話**: 参加者が話している途中（文中の息継ぎ・考える間）に、エージェントが
   「話し終えた」と判定して応答を被せてしまう。Gemini Live の自動音声区間検出
   （automatic activity detection）はサーバ既定のままで、`RealtimeModel` には
   `realtime_input_config` を渡していなかった。既定の終端判定はレイテンシ最優先で、
   要件インタビューのような「考えながら話す」会話には敏感すぎる。
2. **沈黙死**: エージェントが落ちると、その後いっさい反応しなくなる。原因は二層ある。
   - **セッション打ち切り**: `context_window_compression` 未設定のため、長いインタビュー
     ではコンテキスト上限で Gemini Live セッションが打ち切られる。また一時的な接続断は
     プラグインが session resumption handle で再接続するが、リトライ上限
     （`conn_options.max_retry=3`）を使い切ると回復不能エラーになる。
   - **閉じたまま放置**: 回復不能エラーが出ると livekit-agents は `AgentSession` を
     `CloseReason.ERROR` で閉じるが、entrypoint は `close` イベントを見ておらず、
     エージェント participant がルームに残ったまま無反応になる（利用者からは
     「聞こえているのに黙っている」ように見える最悪の形）。

## 決定
1. **ターン検出を保守側に倒す**（発話終端の判定を遅らせる）。
   `build_turn_detection()` が env 設定から Gemini の `AutomaticActivityDetection` を
   組み立てる。既定は `end_of_speech_sensitivity=LOW` + `silence_duration_ms=800`:
   参加者が 0.8 秒黙るまで応答を始めない。応答開始は遅くなるが、要件インタビューでは
   「話し終わるまで待つ」ことが最優先（産婆術の前提は傾聴）。感度・無音時間・
   prefix padding は `TURN_*` 環境変数で調整でき、未知の値はサーバ既定へフェイル
   セーフする（設定 typo で接続自体を壊さない）。発話開始感度は既定でサーバ既定の
   まま: LOW に倒すと短い相槌（「はい」）を取りこぼすリスクがあるため、必要な
   環境だけ opt-in する。
2. **コンテキスト圧縮を既定で有効化**。`context_window_compression`
   （sliding window, trigger 25600 / target 12800 tokens）により、長時間セッションが
   コンテキスト上限で打ち切られなくなる。
3. **`CloseReason.ERROR` での自動再起動**。`close` イベントを監視し、エラー起因の
   close なら新しい `AgentSession` + `RealtimeModel` を作り直して同じ `SANBAAgent`
   インスタンスで再開する（close 時に activity が外れるため再利用でき、transcript・
   utterance/seq 採番・検知の重複抑止状態が維持される = web の ID 空間が壊れない）。
   指数バックオフ（既定 2s→4s→8s）・1 job あたり上限（既定 3 回）。Gemini 側の
   会話履歴は新セッションに引き継がれないため、`resume_instructions()` が Python 側
   transcript の末尾 10 発話を文脈として渡し、「一言お詫び → 続きから再開」させる。
   復旧後は `status(listening)` を再送して web の状態表示を同期する。
4. **上限を使い切ったら退出**。再起動上限に達したら `ctx.shutdown()` で job を終える。
   エージェント participant がルームから退出することで、web は接続断として観測でき、
   「無反応のまま居座る」状態を作らない。
5. **観測性**: `error` / 再起動の各段階（restarting / restarted / restart_failed /
   restarts_exhausted）を構造化ログに出す（CLAUDE.md 原則3）。

## 結果
- 応答開始は最大で `silence_duration_ms` 分遅くなる（意図したトレードオフ）。
  現場で敏感/鈍感が合わない場合は env で再調整する（コード変更不要）。
- 一時的な Gemini 障害・セッション打ち切りでは、数秒の沈黙ののち同じ文脈で会話が
  再開する。永続障害では最大 `2+4+8=14` 秒 + 接続試行ののち退出する。
- web 側の変更なし: status 契約（`idle|listening|recognizing|deliberating`）の範囲で
  復旧を表現する（復旧後に `listening` を再送）。復旧中を明示する phase の追加は
  必要になったら別 ADR で検討する。

## 却下した代替案
- **LiveKit 側 VAD / turn detector plugin への切り替え**: native audio (speech-to-speech)
  ではターン検出はサーバ側（Gemini）が持つのが前提で、二重に検出系を持つと
  割り込み挙動が競合する。Gemini の VAD チューニングで足りる。
- **`SessionMeta` 経由の per-session チューニング**: 感度はデプロイ環境（マイク品質・
  会議室ノイズ）に依存する運用パラメータであり、セッション毎に変える需要がまだない。
  env で十分。
- **job 終了 → LiveKit dispatch 任せの再参加**: dispatch はルーム作成時に走るため、
  job を終えると同じルームに worker が自動で再参加しない。プロセス内での
  AgentSession 再構築が唯一「同じルーム・同じ文脈」で復旧できる。
