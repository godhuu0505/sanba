# ADR-0058: 音声リカバリが選択肢付きの問いを消さないよう supersede をガードし、深掘りの選択肢方針を定める

- ステータス: Accepted
- 日付: 2026-07-08
- 関連: [ADR-0020](0020-question-asked-hydration.md)（現在質問のライフサイクル・supersede/clear）/
  [ADR-0038](0038-voice-turn-detection-and-session-recovery.md)（開始一言の音声リカバリ・再試行）
- 出典: #434 task4（冒頭でタップ可能な選択肢が消える）

## コンテキスト

`open_interview` は開始一言を最大 `voice_opening_max_attempts` 回リトライする（Gemini Live が冒頭
生成を無言ドロップするため / ADR-0038）。各リトライで live LLM が `ask_question` を呼びうる。
`ask_question` の supersede 判定は「現在の未回答の問いがあり、かつ同一ターンで再度問いが来た」
（`_current_question_id is not None and _question_asked_turn == _user_turn`）で、last-write-wins で
前問を clear する。

会話冒頭は参加者が未発話なので `_user_turn` は 0 のまま動かない。冒頭リトライは全て turn=0 を
共有するため、**先に出た選択肢付きの問いが、後から出た選択肢無しの問いに supersede/clear される**。
結果、参加者がタップできる選択肢が会話開始直後に消える。

## 決定

### (a) supersede ガード: 選択肢無しの後発は、選択肢付きの現行を消さない

`ask_question` に「新しい問いが選択肢無し **かつ** 現在の未回答の問いが選択肢付き」のときは
supersede/clear を**行わず、後発の問いを出さずに現行を維持する**ガードを入れる。現在の問いが
選択肢を持つかは `_current_question_has_options`（bool）で追跡し、clear / publish 失敗時のリセットを
`_current_question_id` と揃える。スキップ時は `question_superseded_skipped` を info ログに残し
（観測性）、ツール返り値に「選択肢付きの問いを維持した」旨の note を返して live LLM に伝える。

逆順（選択肢無し→選択肢付き）・両方選択肢付き・別ターンの問いは**従来どおり** supersede する
（ガードは「選択肢付きを選択肢無しで潰す」ケースだけを止める最小介入）。

### (b) 深掘りの選択肢方針: 現状を明文化する（(iii) 最小）

`ask_question` の `options` は任意で、自由回答の深掘りでは省略される。web は 0 options の問いを
ピンに出さない（`selectActiveQuestion` は options>0 のときだけ返す / `ChoiceStrip` は 0 options で
非表示）。したがって**自由回答の深掘りは音声/テキストで回答**し、**ピンは選択肢がある問いのみ**、
というのが現状の仕様である。本 ADR ではこれを正式な決定として明文化する。

検討した拡張は次の 2 つで、いずれも体験計測後に判断する:

- **(i) 深掘りでも代表選択肢を出す**: prompt/ツールで深掘りにも 2〜4 択を促す。評価が要る。
- **(ii) 自由記述を UI で扱う**: `selectActiveQuestion` を 0 options でも返し、ピンにテキスト入力を
  配線する（`sendAnswer({text})` はプロトコル対応済みだが入力 UI が未配線）。web 変更が中規模。

まず (a) のガードでタップ質問の消失を止め、(b) は (iii) 明文化に留める。

## 影響・帰結

- 冒頭の音声リカバリ・リトライで、タップできる選択肢付きの問いが選択肢無しの後発に潰されなくなる。
- 自由回答の深掘りは音声/テキストで答える運用が明確になり、ピンは選択肢がある問いに限定される。
- ガードは最小介入で、逆順・両選択肢付き・別ターンの supersede 挙動は不変（回帰リスクが小さい）。
- 後続: 体験計測の上で (i)（深掘りにも代表選択肢）や (ii)（自由記述の入力 UI 配線）を検討する。
