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
  使い捨ては lossy 可。

## 2. エンベロープ

すべてのメッセージは UTF-8 JSON。共通フィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `v` | int | スキーマ版（現行 `1`） |
| `type` | string | イベント種別（§3） |
| `seq` | int | セッション内の単調増加連番。web は seq で整列・重複排除 |
| `ts` | string | ISO8601（agent 側の発行時刻） |
| `session_id` | string | 対象セッション |

web 側の適用規則: **`(type, id)` で冪等**（同じ要件/検知は upsert）、**`seq` で順序**を担保。
欠番を検知したら §4 のハイドレーションで取り直してよい。

## 3. イベント種別（agent → web）

| `type` | 主な画面 | ペイロード（`v/type/seq/ts/session_id` に加えて） |
|---|---|---|
| `status` | 03/04/05 | `phase`: `idle`\|`listening`\|`recognizing`\|`deliberating`、`agents_active?`: int（"検討中"の体数） |
| `transcript.partial` | 04 | `speaker`, `role`, `text`（確定前の認識中テキスト） |
| `transcript.final` | 04/05 | `speaker`, `role`, `text` |
| `detection.contradiction` | 05/08 | `id`, `summary`, `refs`:[utterance_id...], `options?`:[{`label`,`value`}], `detector`:`"contradiction_detector"` |
| `detection.gap` | 05/08 | `id`, `summary`, `category`, `detector`:`"scope_specialist"`\|`"nfr_specialist"` |
| `requirement.upserted` | 08/09 | `requirement`:{`id`,`statement`,`category`(`must`\|`should`\|`could`\|`wont`),`confidence`(0–1),`source_speaker`,`citations`:[{`kind`,`ref`}],`status`(`draft`\|`confirmed`)} |
| `analysis.progress` | 07 | `asset_id`, `pct`(0–100), `stage`（領域検出/OCR/突合 等の人間可読ラベル） |
| `analysis.visual` | 08 | `asset_id`, `extracted`:[string...], `conflicts`:[{`summary`,`refs`}] |
| `session.completed` | 09/10 | `summary`:{`contradictions_resolved`,`gaps_found`,`issues_created`}, `artifacts`:[{`kind`,`url`}] |

> エージェント識別子（`detector` / `source_speaker`）は **機能名**で送る。UI 上の色（緋=矛盾/黄土=抜け）は
> web 側のデザイントークンへのマッピングであり、ペイロードには持たせない。

## 4. ハイドレーション（リロード・途中参加）

データチャネルは**ライブ差分のみ**。リロードや途中参加では、まず現在状態を取得してから差分を重ねる。

```
[web 接続/再接続]
   1. GET /api/sessions/{id}/requirements        → 確定/下書き要件の現在スナップショット
   2. GET /api/sessions/{id}/detections?open=1   → 未解消の矛盾/抜け（任意・08で使用）
   3. データチャネル購読を開始し、(type,id) で upsert / seq で整列
```

### 追加が必要な API（要件・別PRで実装）

| メソッド | パス | 返却 | 優先度 |
|---|---|---|---|
| GET | `/api/sessions/{id}/requirements` | `{items:[requirement...], seq}` 現在の要件一覧（`seq` は適用済み連番） | **P0**（08/09 の前提） |
| GET | `/api/sessions/{id}/detections?open=1` | `{items:[detection...]}` 未解消検知 | P1（08 の途中参加補強） |
| POST | `/api/sessions/{id}/export` | `{issue_url, doc_url}` 確定要件→GitHub Issue/Markdown（agent の `export_requirements_to_github` を web から起動） | P1（09→10） |

- `seq` を併せて返すことで、スナップショット取得とライブ差分の**境界**が分かる（取得 seq 以下のイベントは破棄）。
- これらの GET は読み取り専用。書き込み（要件確定・矛盾の選択）は当面 agent 側のツールが担い、web は表示に徹する。

## 5. 観測性（CLAUDE.md 原則3）

- agent の publish 時に span/log を出し、`type` と `seq` を属性に乗せる（取りこぼし調査のため）。
- web 側はイベント受信〜描画反映の遅延を計測対象にできるよう、受信 `seq`/`ts` を保持する。
- ハイドレーション GET は既存の API トレースに乗る。要件数・検知数はメトリクス化して評価画面（ADR-0005）へ。

## 6. 非対象（今フェーズ）

- 書き込み系のリアルタイム（web → agent の確定操作）は**スコープ外**。data channel は agent→web の一方向。
- オフライン永続キュー・E2E 暗号化は扱わない（ルームの既存セキュリティに準ずる）。
