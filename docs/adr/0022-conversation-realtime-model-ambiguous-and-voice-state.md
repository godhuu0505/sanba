# ADR-0022: 会話 realtime モデルの拡張 — 不明瞭検知（ambiguous）と音声状態の表現

- ステータス: Proposed
- 日付: 2026-06-28
- 関連: ADR-0018（会話体験・3タブ・確定ゲート）を**補う**。#182（DetectionKind に ambiguous）/
  #183（音声状態 読み上げ/消音/一時停止 の表示契約）/ 契約 `docs/design/realtime-contract.md` §3,§4
- 下敷き: ADR-0008（中核＝矛盾・抜け検知）/ ADR-0018 §6 確定ゲート

## コンテキスト

ADR-0018 で会話フェーズ（04 会話履歴 / 07 確定ゲート）を確定したが、実装に落とす段で 2 つの
**realtime モデル上の未決事項**が露見した（#182 / #183）。いずれも「正本（Figma/ADR）に対し
実装の型・契約が足りない」差分で、ADR-0018 を補って決める必要がある。

1. **不明瞭（ambiguous）の扱い（#182）**: 確定ゲート（07）と深掘り（06）で「不明瞭な論点」を扱いたいが、
   現行 `DetectionKind = "contradiction" | "gap"`（`apps/web/lib/realtime/types.ts`）に `ambiguous` が無く、
   `detection.ambiguous` イベントも無い。ADR-0018 §6 は「未解消 0 件で確定可」とだけ定め、**不明瞭を一級概念と
   するかを明示していない**。
2. **音声状態の表現（#183）**: 04 で「読み上げ中 / 消音 / 一時停止」を表示したいが、`status.phase` は
   `idle | listening | recognizing | deliberating` のみ。一方 ADR-0018 §4 は **消音＝音声出力 ON/OFF の
   ローカルトグル**と定義しており、消音や一時停止は本質的に**クライアント/LiveKit track の状態**で、
   サーバ会話フェーズ（`status.phase`）とは層が違う。

## 決定

### 1. 不明瞭は DetectionKind の第三値として一級概念にする（#182）
- `DetectionKind` に **`"ambiguous"`** を追加し、`detection.ambiguous`（reliable）を契約 §3 に定義する。
  ペイロードは `gap` に準じる（`id`, `summary`, `refs`, `detector`, 任意 `category`）。
- **確定ゲートの定義を更新**: ADR-0018 §6 の「未解消」に **ambiguous を含める**。すなわち未解消
  ＝ open な contradiction / gap / ambiguous の合計。`list_open_detections`（API）と web の集計
  （`store.ts` のセレクタ・06 深掘りリスト）を同じ定義に揃える。
- 色/ラベル: 矛盾=緋・抜け=黄土に対し、**ambiguous は別トークン**（案: 藍/鈍色）を `lib/realtime/mapping.ts` に
  追加し、a11y のため「ラベル＋アイコン併記」を維持（ADR-0017 ガードレール）。
- 理由: 「不明瞭」は矛盾でも抜けでもない第三の未解消状態で、gap に丸めると深掘り導線・確定判定の意味が濁る。
  産婆術（問いで曖昧を解く）の中核体験に直結するため一級にする。

### 2. 音声状態は「層」で分離する（#183）
- **`speaking`（読み上げ中＝TTS 再生中）だけ**をサーバ由来の状態として扱う。実装案は 2 択で、
  **Option B（推奨）**= `status.phase` を肥大させず、エージェントの発話/読み上げは
  **LiveKit の track 状態（リモート参加者の audio track active）からクライアントで導出**する。
  TTS 再生の明示が必要なら `status.phase` ではなく**専用の軽量イベント**（lossy 可）にする。
- **`muted`（消音）/ `paused`（一時停止）は `status.phase` に載せない**。これらは ADR-0018 §4 の
  ローカル音声出力トグル/クライアント操作であり、`useRealtimeSession` のローカル状態（既存 `muted`）と
  LiveKit track 状態で表現する。サーバ会話フェーズに混ぜると層が壊れ、複数参加者で不整合になる。
- 却下した **Option A**（`status.phase` に speaking/muted/paused を単純追加）: muted/paused をサーバ
  フェーズ化する点で設計不整合（ローカル操作がサーバ状態を名乗る）。

## 帰結
- **良い**: 確定ゲートが「矛盾・抜け・不明瞭」を一貫して数えられ、06/07 の体験が正本に揃う。音声状態は
  層分離により多人数でも破綻しない。`status.phase` の肥大を避けられる。
- **トレードオフ**: `DetectionKind` 追加は契約・型・集計・色トークンに波及する（破壊的ではないが網羅修正が要る）。
  音声状態を track 由来にするとクライアント実装（購読）が必要。
- **影響先**: agent `events.py`（`detection.ambiguous` / 任意の speaking イベント）、web `types.ts`/`parse.ts`/
  `store.ts`/`mapping.ts`（kind 追加・集計・色）、API `list_open_detections`（ambiguous を open に含める）、
  `realtime-contract.md` §3。#120 で入れた parse の enum 検証（`DetectionKind`）も追従する。

## 検討したが採用しなかった選択肢
- **ambiguous を gap のサブ種別（category）で表現**: 確定ゲートの数え方が category 依存になり脆い。第一級 kind が明快。
- **音声状態を全部 `status.phase` に入れる**（#183 Option A）: 上記のとおり層が壊れるため却下。
- **据え置き（#182/#183 未対応）**: 07 の未解消件数から不明瞭が漏れ、04 の音声状態が出せない。正本との差分が残る。

## 状態
- Proposed。実装は #182（ambiguous）と #183（音声状態）に分割し、本 ADR を親設計に紐付ける。
  最終採用は人間レビューを経て Accepted とする（CLAUDE.md 原則1）。
