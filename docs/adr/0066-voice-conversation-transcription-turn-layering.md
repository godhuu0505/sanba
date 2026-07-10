# ADR-0066: 音声会話の三層分離（会話・文字起こし・ターン制御）と終了フロー是正

- ステータス: Proposed
- 日付: 2026-07-10
- 関連: [ADR-0038](0038-voice-turn-detection-and-session-recovery.md)（Gemini Live 自動 VAD・ターン検出の出典。本 ADR はその設定を見直す）
- 関連: [ADR-0039](0039-voice-input-accuracy.md)（入力音声の精度・Krisp BVC・言語固定。分離 STT は BVC 済み音声を読む前提）
- 関連: [ADR-0056](0056-auto-finalize-on-disconnect.md)（離脱時 auto-finalize。終了フロー是正の前提）
- 関連: [ADR-0059](0059-inquiry-logic-tree.md)（未解消ゲート。②の 409 判定の出典）

## コンテキスト

本番セッション `sess-424c76e8`（2026-07-10）の不具合調査を GCP ログ（app structlog / LiveKit・GenAI transport）・
Elasticsearch `sanba-grounding`・Firestore・実ソースで横断復元し、3 つの問題を確定した。

1. **① 会話中にエージェント発話が途中で止まる（自己バージイン）**
   - room ログに `_SegmentSynchronizerImpl.playback_finished ... audio_done:true, text_done:false` が2回。エージェントの
     TTS が生成途中で打ち切られていた。応答トークンも平常 350–436 に対し切断ターンは 34–38 と桁違いに小さい。
   - 原因は Gemini Live サーバ VAD の設定非対称。終端は保守化（`turn_end_sensitivity=low` + `turn_silence_duration_ms=1200`）
     済みだが、**発話開始側 `turn_start_sensitivity` が未設定（サーバ既定＝敏感）**で、エージェント発話中の残響・
     ユーザーの続き発話を「発話開始」と誤判定し自分の TTS を割り込みで止めていた（ADR-0038 の設定の穴）。
   - 併発して、**文字起こしの精度が低い**。入力転写は Gemini Live 依存で `ミッション画面で`/`はん画面で` のような崩れが出て、
     遅れて届く final が「文字起こし中→再差し替え」としてエージェント発話に被っていた。

2. **② 「確定して終える」が常に失敗して無反応**
   - 終了ダイアログの「確定して終える」は未解消件数のガードが無い。だがこのダイアログは `JudgmentGate` の
     「未解消のまま終える」からしか開かない＝到達時点で必ず未解消>0。サーバ finalize は未解消ノード
     （open かつ kind∈{contradiction,gap,check}）が残ると 409（ADR-0059 のゲートをサーバでも担保）を返すため、
     このボタンは**構造上必ず 409**で、catch が文言を出すだけ・画面遷移しない。
   - しかも裏では agent が離脱時に `auto_finalize_if_needed`（ADR-0056）で確定要件を保全しており、
     クライアントが「確定できません」と見せる一方でサーバは finalized になる矛盾があった。

3. **③ 「途中まで整理しました」中間画面の文言・挙動不一致**
   - 「確定せず終える」後の中間 SPA 画面（同一 URL・`pushState`）が provisional 表示のままで、サーバ実態
     （auto-finalize 済）と矛盾。「全文を確認する」は会話中シェルに逆戻り、「新しい会話を始める」は
     `window.location.reload()` 経由でリザルトに着地し、文言と挙動が食い違っていた。

### 実装検証で確定したファクト（`livekit-agents/plugins-google 1.6.0`）

分離 STT・手動ターンの実現可否を実ソースで裏取りした（企画の前提）。

- **別 STT は AgentSession に native 併走できる**: 参加者音声は realtime と STT の両方へ fan-out され
  （`agent_activity.py`）、手動タップ不要で **BVC 除去後の音声**を STT が読む。ただし STT の転写を採用するには
  `RealtimeModel(input_audio_transcription=None)` が必須（realtime の `user_transcription` capability が生きている間は
  STT 転写は握り潰される）。入力/出力転写は独立で、input を切っても**エージェント自身の吹き出し（output 転写）は維持**できる。
- **手動ターン（`turn_detection="manual"` + `commit_user_turn`）は generation を起こすが、Gemini に
  `activity_start/activity_end` を送らない実装**で「枠なし音声＋turn_complete」になる。実 API で正しく応答するかは
  未保証＝PoC を要する。manual では自動バージインが無効化され、`session.interrupt()` は Gemini playout を止められる。
- **PTT↔ハンズフリーのランタイム切替**（`update_options(turn_detection=...)`）は agents 側では動くが、realtime では
  `"stt"` は無視・`"vad"` は silero（未導入）必須・Gemini の activity 検出モードは setup 時のみで runtime 変更不可。
  「Gemini 常時 manual + 即時トグル」は現状パッケージ単体では不可。

## 決定

音声会話を **3 層に分離**する設計原則を採る。会話（Gemini Live native audio）を低遅延のまま維持し、
文字起こしとターン制御をそこから切り離す。

- **層1 会話**: Gemini Live native audio（音声→音声）。応答は文字起こしを待たない（critical path に STT を入れない）。
- **層2 ターン制御**: 既定は **PTT-A（クライアントの mic ゲート）**。PTT 窓の間だけ mic を publish、エージェント発話中は
  mute。Gemini VAD は ON のままで、モード切替（PTT↔ハンズフリー）は Gemini 設定を変えず**クライアントのみで即時**。
  自己バージインは mute で構造的に消える。ハンズフリーは mic 常時 publish（現状挙動）。
- **層3 文字起こし**: **Vertex STT（Chirp）を AgentSession に native 併走**（`input_audio_transcription=None` + `stt=`）。
  BVC 除去後の音声を読み、`user_input_transcribed` 経由で既存ハンドラ・`record_user_final`→ES/要件が高精度化。
  非同期・傍観のため会話レイテンシは増やさない。

### 段階導入（リスク昇順）

本設計は複数フェーズに分割し、本番音声パイプラインへ入る変更は実機検証を伴う別 PR で段階投入する。

- **本 PR（S2 + ②③・実機検証不要で安全）**:
  - S2: `turn_start_sensitivity` の既定を `""`→`"low"` にして①の自己バージインを即時緩和（env 上書き可・可逆）。
  - ②: 終了ダイアログ（未解消>0 でしか開かない）から「確定して終える」を撤去。確定は未解消0の
    `JudgmentGate`「要件を確定する」経路のみに残す。文言を「保全される」実態へ合わせる。
  - ③: 「確定せず終える」を中間画面を挟まず `/results/{id}`（サーバ実態）へ遷移。「新しい会話を始める」は
    `reload` をやめホーム `/` へ。read-only ゲスト等 router が無い経路は従来の provisional 画面へフォールバック。
- **S1（別 PR・要実機検証）**: 層3 の Chirp 分離。描画の順序を発話開始位置に固定し、partial には必ず final を返す
  （store に行削除が無いため）。PoC で日本語精度と final 遅延を実測。
- **S3（別 PR・要実機検証）**: 層2 の PTT-A（mic ゲート + モードトグル + `user.interrupt`）。
- **S4（任意・PoC 必須）**: 決定論的な PTT-B（`turn_detection="manual"`）。Gemini manual 契約の実 API 検証と
  silero 追加（即時トグル用）が前提。初期スコープ外。

## 結果 / 影響

- **①**: 本 PR の S2 で自己バージインの発火を下げる。恒久解は S1/S3（分離 STT と mic ゲート）で構造的に断つ。
  効果検証は当面 GCP ログ横断（`playback_finished text_done:false` を代替シグナルに前後比較）で行う。
  この WARNING のメトリクス化・自己バージイン率アラートは**未実装で後続スコープ**とする（未決事項5・CLAUDE.md 原則3）。
- **②**: 到達不能な失敗操作が UI から消える。確定の意味論（client 表示 vs auto-finalize）の齟齬は③の /results 直行で
  「サーバ実態を単一の正」にすることで解消方向に向かう。
- **③**: 逆戻り・誤遷移・未確定表示矛盾を一掃。`/results` は非 finalized セッションでも下書き要件を表示するため
  （`get_my_session_requirements` の非 finalized 分岐）、auto-finalize の非同期完了前に遷移しても空表示にならない。
- **レイテンシ**: 層3 は傍観で会話をブロックしないため、S1 導入後も会話レイテンシは増えない（検証済みの native fan-out）。
- **コスト**: S1 で Chirp ストリーミング ~$0.01–0.02/分が増える。予算次第で「ライブ描画=Gemini interim＋確定=発話ごと batch」へ縮退可能。

## 代替案

- **VAD 調整のみで①を解く**: `turn_start_sensitivity=low` は②方向（バージイン）を緩めるが、沈黙での早期終端
  （フラグメント化）と騒音下の誤検知が残る。恒久解にならないため本 PR では緩和に留め、構造解は分離 STT/PTT に委ねる。
- **文字起こしを Gemini 入力転写のまま使う**: 追加コスト0だが日本語精度が低く、遅れて届く final が被る。要件文の質にも直結するため
  分離を選ぶ（S1）。
- **中間画面のボタン文言だけ直す（画面を残す）**: provisional 表示とサーバ実態の矛盾が残る。/results 直行の方が
  「サーバ実態が単一の正」の原則に合う。
- **PTT-B（manual）を既定にする**: ①を決定論的に断つが Gemini manual 契約が未検証で、即時トグルに silero を要する。
  リスクが高く PoC 後判断とする。

## 未決事項（後続 PR / PoC で確定）

1. S1 の STT モデル: `chirp_3` ストリーミング vs コスト最適 batch。
2. 既定モード: PTT-A を既定にするか、ハンズフリー既定＋PTT オプションか。
3. S4（PTT-B / silero 追加）を将来スコープに残すか。
4. 会話音声（Gemini 解釈）と表示テキスト（Chirp）の乖離の観測方法。
5. ①の効果検証: `playback_finished text_done:false`（自己バージインの代替シグナル）のメトリクス化
   （ログメトリクス or agent 内カウンタ）と自己バージイン率アラートの実装。
