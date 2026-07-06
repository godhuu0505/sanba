# ADR-0039: 音声入力の精度を上げる（言語固定・ノイズ抑制・ターン検出の再調整）

- ステータス: Accepted
- 日付: 2026-07-06

## コンテキスト
実運用の要件セッションで、音声入力に2系統の問題が観測された（ADR-0038 の被せ発話・沈黙死
とは別の「精度」の問題）。

1. **会話が途切れ途切れに投稿される**: 参加者が考えながら話して間が空くと、そこで発話が
   途中確定し、1つの発話が複数の吹き出し（utterance）に分断される。短い相槌や一瞬の環境音で
   区切られることもある。ADR-0038 で `silence_duration_ms=800` / `end_sensitivity=low` に
   倒したが、「考えながら話す」要件インタビューにはまだ待ちが短かった。
2. **認識が別言語・変な文字にドリフトする**: 日本語で話しているのに、短い発話・雑音・曖昧な
   音で文字起こしが韓国語や中国語、あるいは無意味な文字列になる。誤ったキーワードに化ける。
   原因は `build_realtime_model()` が **言語を一切指定していなかった**こと（`language` も
   `input_audio_transcription` の言語ヒントも未設定）。Gemini Live が発話ごとに言語を自動
   推定するため、雑音・PC 内蔵マイク・別話者の被りが多い環境でドリフトが起きやすかった。

SANBA の音声は Gemini Live のネイティブ音声モデル（speech-to-speech）で、独立した STT は
持たない（ADR-0038 / architecture.md）。したがって精度対策は Gemini Live の設定と入力音声の
前処理で行う。デプロイは LiveKit Cloud（Krisp BVC が使える）。

## 決定
音声モデル方針は「**ネイティブ音声を維持し、言語だけ固定する**」（声の自然さ・感情表現を
保つ）。その上で多層で精度を上げる。

1. **言語を固定する**（認識ドリフトの主対策）。設定 `GEMINI_LANGUAGE`（BCP-47・既定 `ja-JP`）
   を導入し、2箇所へ与える:
   - 入力文字起こしの言語ヒント `AudioTranscriptionConfig(language_codes=[...])`。入力音声を
     その言語として認識させる。ネイティブ音声モデルでも入力側のヒントは有効で、これが
     韓国語/中国語化を抑える中心。
   - 出力音声の `speech_config.language_code`（`RealtimeModel(language=...)`）。ネイティブ音声は
     出力言語を自動選択する面があるため補助的だが、指定できる範囲で日本語へ寄せる。
   - **プロンプトでも日本語固定を明示**（`VOICE_AGENT_INSTRUCTIONS` / `END_USER_VOICE_AGENT_INSTRUCTIONS`）:
     「必ず日本語で聞き取り・応答し、聞き取れないときは別言語で推測せず日本語で聞き返す」。
     ネイティブ音声の出力言語自動選択に対する最も確実なレバーとして併用する（多層防御）。
   - 空文字（`GEMINI_LANGUAGE=`）にすると language_codes を付けず自動判定に戻せる（従来挙動）。
2. **入力ノイズを抑える**（雑音・PC 内蔵マイク・別話者の被り対策）。LiveKit Cloud の
   Krisp Background Voice Cancellation（BVC）をエージェント側の音声入力に適用する
   （`RoomInputOptions.noise_cancellation`）。`NOISE_CANCELLATION_ENABLED`（既定 true）で切替。
   プラグイン未導入・self-host では自動で無効化して会話は継続する（**フェイルソフト**）。
   併せて Web 側のマイク取得で `echoCancellation` / `noiseSuppression` / `autoGainControl` /
   `voiceIsolation` を明示し、入口でも雑音を減らす（対応ブラウザのみ voiceIsolation 実効）。
3. **ターン検出を精度側へ再調整**（分断対策）。ADR-0038 の env レバーはそのままに既定値を更新:
   - `TURN_SILENCE_DURATION_MS`: 800 → **1200**（考えながらの沈黙で途中確定しにくくする）。
   - `TURN_PREFIX_PADDING_MS`: 0 → **100**（一瞬の環境音・相槌の漏れで start が誤検出され
     発話が区切られるのを抑える。100ms の連続発話を start 確定の条件にする）。
   - `TURN_END_SENSITIVITY=low` / `TURN_START_SENSITIVITY=`（サーバ既定）は据え置き。start を
     LOW に倒すと短い返事を取りこぼすため、雑音対策は BVC と prefix padding に委ねる。
4. **観測性**（CLAUDE.md 原則3）: BVC が設定 ON なのに使えない構成では一度警告
   （`noise_cancellation_unavailable`）。言語・ターン設定は既存の `agent_instructions_built` 等の
   構造化ログと env で追える。

## 結果
- 日本語セッションでの韓国語/中国語ドリフト・変な文字が、入力言語ヒント＋プロンプト固定で
  大きく減る想定。空文字設定で従来の自動判定へ即戻せる。
- 応答開始は最大 `silence_duration_ms`（1200ms）分だけ遅くなる（ADR-0038 と同じ意図した
  トレードオフ。傾聴優先）。現場に合わなければ env で再調整（コード変更不要）。
- 雑音の多い環境・PC 内蔵マイクでの誤認識が Krisp BVC ＋ブラウザ前処理で低減する。
  BVC は LiveKit Cloud 専用のため、self-host ではブラウザ側前処理のみ効く。
- Web 側は `audioCaptureDefaults` の明示のみで、既存の接続・許可フローは不変。

## 却下した代替案
- **half-cascade モデル（`gemini-live-2.5-flash-preview`）への全面移行**: 言語を厳密に固定でき
  認識は最も安定するが、声がやや機械的になる。ネイティブ音声の自然さ・感情表現を優先する
  方針のため採らない。ドリフトが解消しない場合の次善策として env でのモデル差し替えは可能
  （`GEMINI_LIVE_MODEL`）。
- **独立 STT（Deepgram/Whisper 等）を前段に挟む**: S2S の即応性（ADR-0038 / architecture.md）を
  損なう。往復遅延が増え、産婆術の対話テンポに反する。
- **`TURN_START_SENSITIVITY=low` を既定化**: 雑音由来の誤 start は減るが、「はい」等の短い返事を
  取りこぼすリスクがある（ADR-0038 の判断を踏襲）。prefix padding + BVC で代替する。
