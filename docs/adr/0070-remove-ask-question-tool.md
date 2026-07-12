# ADR-0070: ask_question ツールと問いピン（金枠）機構の撤廃 — 音声・テキスト自由入力へ一本化

- ステータス: Accepted
- 日付: 2026-07-12
- 関連: [ADR-0020](0020-question-asked-hydration.md)（本 ADR が置き換える。現在質問のハイドレーション方式）/
  [ADR-0058](0058-voice-recovery-question-supersede-guard.md)（本 ADR が置き換える。supersede ガード）/
  [ADR-0038](0038-voice-turn-detection-and-session-recovery.md)（音声リカバリ・再起動。本 ADR の対象外で存続）/
  PR #536・#538（ask_question livelock のサーキットブレーカ）

## コンテキスト

`ask_question` は「モデルが音声で問いかけると同時にツールを呼び、画面の問いピン（金枠）に
選択肢つきで提示し、タップでも回答できる」ための機構だった（#181）。しかしローカル検証
セッション sess-132d35e5 の調査で、この機構が音声品質の不具合の温床になっていることが
確定した。

- Gemini Live はツール応答を受け取ると自動で継続 generation を開始する。livekit-agents は
  全発話の再生完了を待ってからツール応答を送るが、モデルは継続 generation で再び
  `ask_question` を呼びがちで、supersede（後勝ち差し替え）→ 注意文つきツール応答 → さらに
  継続 generation という自己増殖ループになる（「何度も発言する」不具合の正体）。
- PR #536/#538 のサーキットブレーカ（3 周で `StopResponse`）はループを止めるが、ターン途中で
  応答を打ち切るため、参加者には「言いかけて途切れて黙る」と体感される。断片発話
  （1 秒前後の generation）と沈黙が sess-132d35e5 のターン 2・4 で観測された。
- 問いピンの状態同期（Firestore `questions/current` の CAS・tombstone・ハイドレーション・
  supersede ガード）は #434 → #468 → #534 → #538 と修正が連鎖しており、複雑さのコストが
  便益を上回っている。

一方で問いの文面は元々モデルが音声で読み上げており、`transcript.final` で画面にも表示される。
タップ回答の代替は音声（PTT）とテキスト自由入力（`user.text`）で成立する。

## 決定

`ask_question` ツールと問いピン機構を全層から撤廃し、問いかけは音声発話のみ、回答は音声または
テキスト自由入力のみとする。

- **agent**: `ask_question` ツール、現在質問の状態（`_current_question_id` ほか）、supersede /
  reask サーキットブレーカ、`question.asked` / `question.cleared` の publish、`user.answered`
  受信経路（`respond_to_answer`）、現在質問のハイドレーションを削除する。プロンプトは
  「問いは音声で 1 ターン 1 つ。選択肢を示したいときも口頭で読み上げる」に改める。
- **sanba_shared / api**: `questions/current` の永続化（save/get/clear）と
  `GET /api/sessions/{id}/questions/current`、`sanba_question_hydrations_total` メトリクスを
  削除する。
- **web**: ChoicePin / ChoiceStrip、question 系イベントの parse / store / 型、`sendAnswer`
  （`user.answered` 送信）、復元 fetch を削除する。
- **契約**: `docs/reference/realtime-contract.md` から `question.asked` / `question.cleared` /
  `user.answered` / `GET /questions/current` を削除する。

ADR-0020 と ADR-0058 は本 ADR で置き換える（Superseded）。ADR-0038 の音声リカバリ・再起動
機構（reply watchdog / restart hook）と #468 の `resolve_inquiry` 対策は question 機構と独立の
ため存続する。

## 検討したが採用しなかった選択肢

- **`RealtimeModel(tool_behavior=NON_BLOCKING, tool_response_scheduling=SILENT)`**: ツール応答
  起点の継続 generation を全ツールで止められるが、ツール結果を踏まえた発話が必要なツール
  （`propose_session_end` の保留理由の読み上げ等）まで巻き込む。全体設定でしか制御できず
  リスクが大きい。
- **ツール内で `speech_handle.wait_for_playout()` を待つガード**: livekit-agents 1.6 は
  ツール応答送信前に全発話の再生完了を待つ実装（agent_activity の tool output 送信ループ）に
  なっており冗長。切断の主因でもなかった。
- **supersede を先勝ちに変える等の縮小修正**: ループの燃料（差し替え＋注意文）は減るが、
  ツール応答→継続 generation という構造は残り、同系統の不具合が再発しうる。状態同期の
  複雑さも残る。
- **問いピンを表示専用（エージェント状態と非同期）で残す**: 将来選択肢 UI が必要になった
  ときの再設計案としては有力だが、現時点では利用実績に対して維持コストが見合わない。
  必要になった時点で「エージェント状態と同期しない表示専用サジェスト」として別 ADR で
  再設計する。

## 影響

- **解消される不具合**: 同一ターン内の再 ask ループ（「何度も発言する」）、サーキット
  ブレーカ由来のターン途中の沈黙、問いピンの高速な表示⇄クリア（チラつき）。
- **残存する既知事象（本 ADR の対象外）**:
  - PTT 押下（`user.interrupt`）は仕様として再生を即中断する（barge-in / ADR-0066 S3）。
  - 発話が割り込まれた場合、livekit-agents はツール実行を cancel し応答未送のまま返すため、
    残ツールでも Gemini 側に未応答 tool call が残るケースはありうる。
- **観測性**: `question_asked` / `question_cleared` / `question_superseded` / 各サーキット
  ブレーカのログと `sanba_question_hydrations_total` メトリクスは削除される。問いの品質は
  transcript ベースの評価ルーブリック（`question_specificity` / `single_question`。
  `ask_question` 非依存であることを確認済み）で引き続き監視する。
- **データ**: Firestore `sessions/{id}/questions/current` は書き込み・参照とも停止する。既存
  ドキュメントは無害なので移行処理は行わない。
- **テスト**: supersede / reask / hydration 系の回帰テスト（PR #536/#538 で追加分を含む）を
  削除し、`user.answered` を受信しても無視されることは契約から外れるため web の parse
  テストのみ更新する。
- **フォローアップ**: 実機で「PTT を押していないのに途切れる」体感が残る場合は、PTT の
  スペースキー誤爆を別 issue で検証する。
