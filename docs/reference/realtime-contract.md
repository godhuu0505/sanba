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

- agent は確定要件・確認事項・状態を **データメッセージ**として publish する。音声トラックと同一ルーム・同一接続。
- web は `useDataChannel("sanba.events")`（または `room.on(RoomEvent.DataReceived)`）で購読する。
- 信頼性が要る要件/確認事項イベントは **reliable** で送る。`status`/`transcript.partial` のような高頻度・
  使い捨ては lossy 可。
- **seq 系統は reliable/lossy で分離する（#122・ADR-0021）**。`seq`（reliable 連番）は reliable
  イベントにのみ採番し、欠番検知の基準にする。lossy イベントは `seq` を消費せず**現在の reliable seq を
  echo**し、独立の `lossy_seq` で順序付ける。これにより lossy が落ちても reliable seq に穴が空かず、
  web が誤って欠番（ギャップ）と判定して不要な GET 再取得をすることを防ぐ。

## 2. エンベロープ

すべてのメッセージは UTF-8 JSON。共通フィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `v` | int | スキーマ版（現行 `1`） |
| `type` | string | イベント種別（§3） |
| `seq` | int | reliable ストリームの単調増加連番。整列・重複排除・**欠番検知**の基準。lossy は現在値を echo（消費しない） |
| `reliable` | bool? | reliable イベントか（既定 true / #122）。false = lossy（`status`/`transcript.partial`）。欠番検知は reliable のみ対象 |
| `lossy_seq` | int? | lossy イベント専用の単調増加連番。lossy の順序・重複排除に使う（reliable には無い） |
| `ts` | string | ISO8601（agent 側の発行時刻） |
| `session_id` | string | 対象セッション |

web 側の適用規則: **`(type, id)` で冪等**（同じ要件/確認事項ノードは upsert）、reliable は **`seq` で順序**、lossy は
**`lossy_seq` で順序**を担保。欠番検知は reliable seq のみで行い、検知したら §4 のハイドレーションで取り直してよい。

## 3. イベント種別（agent → web）

| `type` | 主な画面 | ペイロード（`v/type/seq/ts/session_id` に加えて） |
|---|---|---|
| `status` | 03/04/05 | `phase`: `idle`\|`listening`\|`recognizing`\|`deliberating`、`agents_active?`: int（"検討中"の体数） |
| `transcript.partial` | 04 | `speaker`, `role`, `utterance_id`（仮払い出し）, `text`（確定前の認識中テキスト） |
| `transcript.final` | 04/05 | `speaker`, `role`, `utterance_id`（確定ID・`inquiry.node` の `refs` と同一ID空間）, `text` |
| `inquiry.node` | 05/06/07/08 | `op`:`upsert`\|`resolve`\|`drop`, `node`:{`id`,`parent_id`(str\|null=root),`kind`(`gap`\|`contradiction`\|`ambiguous`\|`check`),`text`,`status`(`open`\|`resolved`\|`dropped`),`confidence`(0–1),`depth`(1–5),`origin`(`conversation`\|`analysis`\|`prep`\|`material`),`refs`:[utterance_id...],`created_seq`,`resolved_seq`(int\|null)}（ADR-0059）。確認事項ロジックツリーのノード変化。ノード全体を upsert セマンティクスで送る（冪等）。未解消ゲート数（確定ゲート・終了提案に算入）は `open` かつ `kind∈{contradiction,gap,check}` かつ `confidence≥τ`。**`ambiguous` は advisory**（表示のみ・ゲートに算入しない）。矛盾=緋/抜け=黄土/確認観点=萌黄/曖昧=藍鼠の色写像は web 側で `kind` から行う |
| `requirement.upserted` | 08/09 | `requirement`:{`id`,`statement`,`category`(`functional`\|`non_functional`\|`constraint`\|`scope`\|`open_question`),`priority`(`must`\|`should`\|`could`\|`wont`),`confidence`(0–1),`source_speaker`,`citations`:[{`kind`,`ref`}],`status`(`draft`\|`confirmed`)} |
| `question.asked` | 04 | `id`, `prompt`, `options?`:[{`label`,`value`}]（#181）。通常質問（金枠）を問いピンに出す。選択肢があればタップで `user.answered` を返す。web は seq ガードで最新1問を保持 |
| `question.cleared` | 04 | `question_id`（クリア対象 `question.asked` の `id`）（#212 / ADR-0020）。回答（タップ/音声/テキスト）で現在質問が解消されたことを全参加者へ伝播し、重複回答を防ぐ。`cleared_seq` は本イベントの **envelope `seq` そのもの**。web は `question_id === current?.id` かつ `seq > lastQuestionSeq` のときだけピンを畳む。`question.asked` と対称に seq 境界（`last_seq`）は進めない |
| `analysis.progress` | 07 | `asset_id`, `pct`(0–100), `stage`（人間可読ラベル）。アップロード素材の解析は **API（サーバ identity）が直接 publish**（#145 / ADR-0023）。実体に正直な粗ステージ `received`(10)→`analyzing`(50)→`done`(100)/`failed` を出し、フェイクの中間 pct は作らない。会話中の画面共有由来は従来どおり agent が送る |
| `analysis.visual` | 08 | `asset_id`, `extracted`:[string...], `conflicts`:[{`summary`,`refs`}]。アップロード解析の完了は API が publish（#145）。`conflicts`（言葉×画の矛盾 / ADR-0004）は突合実装まで空配列可 |
| `context.progress` | 04 | `source`(`prep`\|`repo`), `stage`(`running`\|`done`\|`reused`\|`partial`\|`failed`), `label?`, `detail?`（P1-a）。会話開始時の前提読み込み（ゴール/ゴール詳細=prep・ソースコード索引=repo）の状態を **agent が publish** し、会話履歴のシステム吹き出しへ写像する。素材の進捗は `analysis.progress` が担うので重複させない。実体に正直な段階のみ（`reused`=既存索引利用・進捗バーなし / `running`=索引中）。end_user モードでは repo は送らない（private repo 情報を利用者会話に出さない多層防御） |
| `session.end_proposed` | 07 | `open_count`(=0), `requirement_count`, `material_count`（P1-b）。未解消ゲートノード（`open` かつ `kind∈{contradiction,gap,check}`）が 0 件になったとき **agent が `propose_session_end` で publish**。web は終了提案カードを出し、ユーザーが同意（音声=agent が `complete_session`／タップ=web が直接 finalize）すると確定へ進む。「まだ続ける」は web ローカルでカードを閉じるだけ |
| `session.completed` | 09/10 | `summary`:{`contradictions_resolved`,`gaps_found`,`issues_created`}, `artifacts`:[{`kind`,`url`}]。集計はツリー（解消済み contradiction/gap ノード）から導出。agent の `complete_session`（ユーザー同意後）または Issue 起票で publish。web は受信で自動的に finalize→結果画面へ遷移する（P1-b） |

> 確認事項の種別は `inquiry.node` の `kind`、要件の出所は `source_speaker` として**機能名/機能値**で送る。
> UI 上の色（緋=矛盾/黄土=抜け/萌黄=確認観点/藍鼠=曖昧）は web 側のデザイントークンへのマッピングであり、
> ペイロードには持たせない。

## 4. ハイドレーション（リロード・途中参加）

データチャネルは**ライブ差分のみ**。リロードや途中参加では、まず現在状態を取得してから差分を重ねる。

```
[web 接続/再接続]
   1. データチャネル購読を開始しイベントをバッファ（欠落防止のため購読を先行）
   2. GET /api/sessions/{id}/requirements        → 確定/下書き要件のスナップショット（seq=N を返す）
   3. GET /api/sessions/{id}/inquiry             → 確認事項ツリーの全ノード + seq（06/07/08 で使用）
   4. バッファから seq ≤ N のイベントを破棄、seq > N のみ (type,id) で upsert
```

### 追加が必要な API（要件・別PRで実装）

| メソッド | パス | 返却 | 認可 | 優先度 |
|---|---|---|---|---|
| GET | `/api/sessions/{id}/requirements` | `{items:[requirement...], seq}` 現在の要件一覧（`seq` は適用済み連番） | join 済みトークン（Bearer / Cookie）。`session_id` 単体では不可 | **P0**（08/09 の前提） |
| GET | `/api/sessions/{id}/inquiry` | `{nodes:[inquiry_node...], seq}` 確認事項ツリーの全ノード（ADR-0059）。再接続で木ごと復元し seq 欠番を埋める | 同上 | P1（06/07/08 の途中参加補強） |
| GET | `/api/sessions/{id}/context/files` | `{items:[{id,name,kind,status,extracted?,extracted_texts?}]}` 投入済み素材のメタ（#184）。リロード/再接続で実ファイル名・解析状態を復元。`extracted_texts`（解析済み素材の観察テキスト / #355）で `analysis.visual` 相当の詳細も復元し、web は realtime の analysis 行と `id`(=asset_id) で統合（ライブイベントが常に優先） | 同上 | P1（05 参考資料の復元） |
| GET | `/api/sessions/{id}/questions/current` | `{question:{id,prompt,options}\|null, seq}` 現在の未回答質問（金枠ピン / #212・ADR-0020）。回答済み/未提示なら `question=null`。**`null` でも `seq`（クリア時点の `cleared_seq`）を返す**ことで、遅延 null が新しい live 質問を消す逆転を防ぐ。`seq` は active なら `asked_seq` | 同上 | P1（04 問いピンの復元） |
| POST | `/api/sessions/{id}/finalize` | `{finalized:true, confirmed_count}`（#186）。07 判定の「確定」を永続化（session=finalized・確定件数を刻む不可逆マーカ）。要件の draft→approved 承認は管理画面の責務（ADR-0014）なので触れない | 同上 | P1（07→08） |
| POST | `/api/sessions/{id}/export` | リクエスト（任意）: `{include_summary?, include_materials?}`（既定 false / P3・Q4）。成功: `{exported:true, issue_url, count}` + `doc_url?`（Markdown 生成が有れば追加）、失敗: `{exported:false, reason}`。opt-in で本文末尾に会話の要約（確定時に生成・保存済み `conversation_summary`）と参考資料サマリ（ファイル名＋解析観察＋`web_base_url/results/{id}` リンク・画像実体は載せない）を付す。起票成功時は Issue URL を `SessionMeta.exported_issue_url` に保存（過去要件一覧の「起票済み」表示） | 同上 | P1（09→10）/ P3 |

- `seq` を併せて返すことで、スナップショット取得とライブ差分の**境界**が分かる（取得 seq 以下のイベントは破棄）。
- 認可: 既存の署名付き招待トークンと同等の条件を適用する。`session_id` をパスに含むだけでは参加者以外に要件・確認事項が漏洩するため、実装時は必ずトークン検証を入れること。

## 4.5 web → agent 送信（ユーザー操作）

確認事項ツリー（06）でユーザーが誤検知を「不要」にした場合、web はその剪定を agent へ送信する。ノードの
解消（resolve）は会話駆動で、手動 resolve は公開しない（終了ゲートの gaming を避ける / ADR-0059 決定⑥）。

| `type` | 発火条件 | ペイロード |
|---|---|---|
| `user.inquiry_drop` | 確認事項ノードの「不要」操作 | `node_id`（対象ノードの `id`）, `session_id`。agent は `InquiryTree.drop` → `inquiry.node`(op=drop) で全参加者へ反映 |
| `user.text` | ボトムバーのテキスト送信（#185） | `text`（本文）, `session_id`。agent は発話として記録（`transcript.final` で会話履歴へ反映）し、**音声のバージインと同様に読み上げ中の応答を中断**した上で、本文を user ターンとして会話文脈へ注入して応答を生成する（音声入力と同等の扱い）。従来のセッション文脈投入の暫定動線を置換 |
| `user.answered` | 通常質問（金枠）の回答（#181） | `question_id`（対象 `question.asked` の `id`）, `selected_value?`（選択肢タップ時）/ `text?`（自由記述）, `session_id`。agent は発話として記録し、読み上げ中なら中断して次の問いへ進む |
| `user.interrupt` | PTT（押して話す）押下開始（ADR-0066 S3） | `session_id` のみ（付加フィールド無し）。agent は読み上げ中の応答を即時中断する（`session.interrupt()`）。クライアント側 mic ゲート（押下中だけ publish）と対で、エージェント発話へのバージインを決定論的にする |

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
- ハイドレーション GET は既存の API トレースに乗る。要件数・確認事項数はメトリクス化して評価画面（ADR-0005）へ。

## 6. 非対象（今フェーズ）

- 書き込み系のリアルタイム（web → agent）は §4.5 の `user.inquiry_drop` / `user.text`（#185）/ `user.answered`（#181）を対象とする。要件確定の永続化は §4 の POST `/finalize`（#186・非リアルタイム）で行い、確認事項の手動 resolve など全般的な双方向操作は**スコープ外**（resolve は会話駆動 / ADR-0059）。
- オフライン永続キュー・E2E 暗号化は扱わない（ルームの既存セキュリティに準ずる）。
