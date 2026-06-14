# ADR-0004: マルチモーダル入力（画面共有・モック画像）

- ステータス: Accepted
- 日付: 2026-06-14

## コンテキスト
要件は言葉だけでなく、画面・モック・ホワイトボードなど**視覚情報**に多く含まれる。
音声だけでは「この画面のこのボタン」が拾えない。Gemini はマルチモーダルであり、
LiveKit は画面共有/カメラの映像トラックを扱える。審査員 佐藤一憲氏もマルチモーダルを好む。

## 決定
- AgentSession を `RoomInputOptions(video_enabled=True)` で起動し、参加者の画面共有/カメラ
  フレームを Gemini Live にそのまま渡す（speech-to-speech に視覚を追加）。
- 視覚から読み取った要件は `note_visual_requirement(observation, statement)` ツールで記録し、
  出所を `screen-share` として残す（多対多のトレーサビリティと整合）。

## 影響
- フロントは画面共有の publish に対応（Phase 2 で UI 追加）。
- 映像はトークン/帯域コストが増えるため、共有中のみ有効化する制御を将来入れる。
