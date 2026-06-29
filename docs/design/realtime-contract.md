# リアルタイム契約 — LiveKit データチャネル & ハイドレーション

Figma 正本（モバイル10画面）の 03〜09 が依存する、**agent → web のリアルタイム伝送**と
**状態復元（リロード・途中参加）**の契約。画面別要件票（`screens/`）はこの契約を前提に AC を書く。

> 決定（grill 2026-06-24）: リアルタイムは **LiveKit データチャネル**（新インフラ無し・低レイテンシ・
> 既存ルーム接続を再利用）。リロード/途中参加時の状態復元は **GET でハイドレーション + データチャネルで
> ライブ差分**。擬人化（緋/黄土/侍/産婆）は**デモ演出**であり、本契約・コピーは**機能名**で記述する。

## 1. 伝送経路

```
apps/agent (LiveKit 参加者)
   │  publishData(payload, {reliable:true, topic:"sanba.events"})
   ▼
LiveKit ルーム（音声と同一接続）
   │  RoomEvent.DataReceived / useDataChannel("sanba.events")
   ▼
apps/web（@livekit/components-react で購読）
```

- agent は確定要件・検知・状態を **データメッセージ**として publish する。音声トラックと同一ルーム・同一接続。
- web は `useDataChannel("sanba.events")`（または `room.on(RoomEvent.DataReceived)`）で購読する。
- 信頼性が要る要件/検知イベントは **reliable** で送る。`status`/`transcript.partial` のような高頻度・
  使い捨ては lossy 可。reliable / lossy は **seq 名前空間を分ける**（§2 / ADR-0021）。

## 2. エンベロープ

すべてのメッセージは UTF-8 JSON。共通フィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `v` | int | スキーマ版（現行 `2`。ADR-0021 で reliable/lossy seq を分離した破壊的変更） |
| `type` | string | イベント種別（§3） |
| `seq` | int | **reliable** ストリーム専用の連続・単調増加連番。整列・重複排除・**欠番検知（ギャップ）の基準**。lossy イベントは持たない |
| `lossy_seq` | int | **lossy** ストリーム専用の連番（欠番許容）。lossy イベントだけが持つ。種別ごとの上書き/巻き戻し防止にのみ使い、ギャップ検知には使わない |
| `ts` | string | ISO8601（agent 側の発行時刻） |
| `session_id` | string | 対象セッション |

### reliable / lossy の seq 名前空間（ADR-0021）

seq は **reliable と lossy で別空間**を持つ。これにより lossy（status / transcript.partial /
会話由来 analysis.progress）が通常のパケット欠落で落ちても reliable `seq` に穴が空かず、
web のギャップ検知（欠番→GET 再ハイドレーション）が**誤発火しない**（#122）。

- **reliable イベント**: `seq` を持つ。agent / API はそれぞれ reliable 専用カウンタで連続採番する
  （共有 seq 空間 / `reserve_session_seq`）。web は `seq` の欠番だけを「本当の取りこぼし」とみなす。
- **lossy イベント**: `lossy_seq` を持つ（`seq` は持たない）。落ちても良い・後続で上書きされる種別。
  web は種別ごとの `lossy_seq` ガード（status の巻き戻し防止 / transcript.partial の上書き）で整列する。
- **`analysis.progress` は二重生産者**: アップロード解析（API / #145）は離散・少数なので **reliable**
  （`seq`）、会話中の画面共有由来（agent）は高頻度なので **lossy**（`lossy_seq`）。web は種別名ではなく
  **どちらの seq フィールドを持つか**でストリームを判別する。

web 側の適用規則: **`(type, id)` で冪等**（同じ要件/検知は upsert）、**reliable は `seq`・lossy は
`lossy_seq`** で順序を担保。**reliable `seq` の欠番**を検知したら §4 のハイドレーションで取り直してよい。

## 3. イベント種別（agent → web）

> 配信種別の凡例（§2 / ADR-0021）: **R**=reliable（`seq` を持つ）、**L**=lossy（`lossy_seq` を持つ）。

| `type` | 配信 | 主な画面 | ペイロード（共通枠 ＋ R は `seq` / L は `lossy_seq` に加えて） |
|---|---|---|---|
| `status` | L | 03/04/05 | `phase`: `idle`\|`listening`\|`recognizing`\|`deliberating`、`agents_active?`: int（"検討中"の体数） |
| `transcript.partial` | L | 04 | `speaker`, `role`, `utterance_id`（仮払い出し）, `text`（確定前の認識中テキスト） |
| `transcript.final` | R | 04/05 | `speaker`, `role`, `utterance_id`（確定ID・`detection.*.refs` と同一ID空間）, `text` |
| `detection.contradiction` | R | 05/08 | `id`, `summary`, `refs`:[utterance_id...], `options?`:[{`label`,`value`}], `detector`:`"contradiction_detector"` |
| `detection.gap` | R | 05/08 | `id`, `summary`, `category`, `refs`:[utterance_id...], `detector`:`"scope_specialist"`\|`"nfr_specialist"` |
| `detection.ambiguous` | R | 06/07 | `id`, `summary`, `refs`:[utterance_id...], `detector`:`"ambiguity_detector"`（#182 / ADR-0022）。矛盾でも抜けでもない不明瞭な論点。`resolved` まで未解消として確定ゲートの件数に算入（`list_open_detections`／web 集計は kind 非依存） |
| `detection.resolved` | R | 05/08 | `detection_id`（解消対象）, `resolution`:`"user_selected"`\|`"agent_resolved"`, `selected_value?`（選択肢タップ時） |
| `requirement.upserted` | R | 08/09 | `requirement`:{`id`,`statement`,`category`(`functional`\|`non_functional`\|`constraint`\|`scope`\|`open_question`),`priority`(`must`\|`should`\|`could`\|`wont`),`confidence`(0–1),`source_speaker`,`citations`:[{`kind`,`ref`}],`status`(`draft`\|`confirmed`)} |
| `question.asked` | R | 04 | `id`, `prompt`, `options?`:[{`label`,`value`}]（#181）。通常質問（金枠）を問いピンに出す。選択肢があればタップで `user.answered` を返す。web は seq ガードで最新1問を保持 |
| `question.cleared` | R | 04 | `question_id`（クリア対象 `question.asked` の `id`）（#212 / ADR-0020）。回答（タップ/音声/テキスト）で現在質問が解消されたことを全参加者へ伝播し、重複回答を防ぐ。`cleared_seq` は本イベントの **envelope `seq` そのもの**。web は `question_id === current?.id` かつ `seq > lastQuestionSeq` のときだけピンを畳む。`question.asked` と対称に seq 境界（`last_seq`）は進めない |
| `analysis.progress` | R/L | 07 | `asset_id`, `pct`(0–100), `stage`（人間可読ラベル）。アップロード素材の解析は **API（サーバ identity）が直接 publish**（#145 / ADR-0023）＝**reliable（`seq`）**。実体に正直な粗ステージ `received`(10)→`analyzing`(50)→`done`(100)/`failed` を出し、フェイクの中間 pct は作らない。会話中の画面共有由来は従来どおり agent が送る＝**lossy（`lossy_seq`）**。web は seq フィールドの有無でストリームを判別する（ADR-0021） |
| `analysis.visual` | R | 08 | `asset_id`, `extracted`:[string...], `conflicts`:[{`summary`,`refs`}]。アップロード解析の完了は API が publish（#145）。`conflicts`（言葉×画の矛盾 / ADR-0004）は突合実装まで空配列可 |
| `session.completed` | R | 09/10 | `summary`:{`contradictions_resolved`,`gaps_found`,`issues_created`}, `artifacts`:[{`kind`,`url`}] |

> エージェント識別子（`detector` / `source_speaker`）は **機能名**で送る。UI 上の色（緋=矛盾/黄土=抜け）は
> web 側のデザイントークンへのマッピングであり、ペイロードには持たせない。

## 4. ハイドレーション（リロード・途中参加）

データチャネルは**ライブ差分のみ**。リロードや途中参加では、まず現在状態を取得してから差分を重ねる。

```
[web 接続/再接続]
   1. データチャネル購読を開始しイベントをバッファ（欠落防止のため購読を先行）
   2. GET /api/sessions/{id}/requirements        → 確定/下書き要件のスナップショット（seq=N を返す）
   3. GET /api/sessions/{id}/detections?open=1   → 未解消の矛盾/抜け（任意・08で使用）
   4. バッファから seq ≤ N のイベントを破棄、seq > N のみ (type,id) で upsert
```

### 追加が必要な API（要件・別PRで実装）

| メソッド | パス | 返却 | 認可 | 優先度 |
|---|---|---|---|---|
| GET | `/api/sessions/{id}/requirements` | `{items:[requirement...], seq}` 現在の要件一覧（`seq` は適用済み連番） | join 済みトークン（Bearer / Cookie）。`session_id` 単体では不可 | **P0**（08/09 の前提） |
| GET | `/api/sessions/{id}/detections?open=1` | `{items:[detection...]}` 未解消検知 | 同上 | P1（08 の途中参加補強） |
| GET | `/api/sessions/{id}/context/files` | `{items:[{id,name,kind,status,extracted?}]}` 投入済み素材のメタ（#184）。リロード/再接続で実ファイル名・解析状態を復元。web は realtime の analysis 行と `id`(=asset_id) で統合 | 同上 | P1（05 参考資料の復元） |
| GET | `/api/sessions/{id}/questions/current` | `{question:{id,prompt,options}\|null, seq}` 現在の未回答質問（金枠ピン / #212・ADR-0020）。回答済み/未提示なら `question=null`。**`null` でも `seq`（クリア時点の `cleared_seq`）を返す**ことで、遅延 null が新しい live 質問を消す逆転を防ぐ。`seq` は active なら `asked_seq` | 同上 | P1（04 問いピンの復元） |
| POST | `/api/sessions/{id}/finalize` | `{finalized:true, confirmed_count}`（#186）。07 判定の「確定」を永続化（session=finalized・確定件数を刻む不可逆マーカ）。要件の draft→approved 承認は管理画面の責務（ADR-0014）なので触れない | 同上 | P1（07→08） |
| POST | `/api/sessions/{id}/export` | 成功: `{exported:true, issue_url, count}` + `doc_url?`（Markdown 生成が有れば追加）、失敗: `{exported:false, reason}` — agent ツール `export_requirements_to_github` を起動し `{exported, url, count}` を受け取り、web 向けに `issue_url=url` へリネームして返す | 同上 | P1（09→10） |

- `seq` を併せて返すことで、スナップショット取得とライブ差分の**境界**が分かる（取得 seq 以下のイベントは破棄）。
- 認可: 既存の署名付き招待トークンと同等の条件を適用する。`session_id` をパスに含むだけでは参加者以外に要件・検知が漏洩するため、実装時は必ずトークン検証を入れること。

## 4.5 web → agent 送信（ユーザー選択操作）

画面 05（検知カード）でユーザーが選択肢をタップした場合、web は選択結果を agent へ送信する。

| `type` | 発火条件 | ペイロード |
|---|---|---|
| `user.selection` | 検知カードの選択肢ボタンタップ | `detection_id`（対象 detection の `id`）, `selected_value`（選択した `options[].value`）, `session_id` |
| `user.text` | ボトムバーのテキスト送信（#185） | `text`（本文）, `session_id`。agent は発話として記録（`transcript.final` で会話履歴へ反映）し応答を生成する。従来のセッション文脈投入の暫定動線を置換 |
| `user.answered` | 通常質問（金枠）の回答（#181） | `question_id`（対象 `question.asked` の `id`）, `selected_value?`（選択肢タップ時）/ `text?`（自由記述）, `session_id`。agent は発話として記録し次の問いへ進む |

```
apps/web
   │  room.localParticipant.publishData(payload, {reliable:true, topic:"sanba.events.web"})
   ▼
LiveKit ルーム（agent→web とは逆方向）
   │  DataReceived（topic="sanba.events.web"）
   ▼
apps/agent — 受信後に対応ツール（解消・確定など）を呼び出す（実装は別PR）
```

- topic を `sanba.events.web` と分けることで agent→web トラフィックと混在しない。
- 実装前の段階でもこのイベント定義を契約に含めることで、画面 05 のボタンが「音声回答の視覚補助」ではなく**実際に操作可能な選択 UI** として実装できる。

## 5. 観測性（CLAUDE.md 原則3）

- agent の publish 時に span/log を出し、`type` と `seq` を属性に乗せる（取りこぼし調査のため）。
- web 側はイベント受信〜描画反映の遅延を計測対象にできるよう、受信 `seq`/`ts` を保持する。
- ハイドレーション GET は既存の API トレースに乗る。要件数・検知数はメトリクス化して評価画面（ADR-0005）へ。

## 6. 非対象（今フェーズ）

- 書き込み系のリアルタイム（web → agent）は §4.5 の `user.selection` / `user.text`（#185）/ `user.answered`（#181）を対象とする。要件確定の永続化は §4 の POST `/finalize`（#186・非リアルタイム）で行い、矛盾の強制解消など全般的な双方向操作は**スコープ外**。
- オフライン永続キュー・E2E 暗号化は扱わない（ルームの既存セキュリティに準ずる）。
