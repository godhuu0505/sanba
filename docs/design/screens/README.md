# 画面別要件票 — Figma モバイル正本

Figma「📱 iPhone 13 Pro 操作フロー・正本」（fileKey `eI6QvvCEO021zpdMmxr8Iq` / node `31:2`）を**唯一の正本**とし、
各画面を実装可能な粒度の要件票に落とす。**1ファイル＝1系**（会話フェーズは系内の状態を票に内包）、Figma と対応する。

> スコープ（grill 2026-06-24）: **モバイル縦・一本道フロー**が正本。デスクトップ3分割は
> [`../README.md`](../README.md) の「次フェーズ（デスクトップ拡張）」へ退避。リアルタイム前提は
> [`../realtime-contract.md`](../realtime-contract.md)。
>
> **会話フェーズ（03〜08）改訂 v2（2026-06-25）**: 会話を止めずに情報面を横断する **3 タブ
> （会話履歴 / 参考資料 / 要件絵巻）** へ再構成。詳細 [`../conversation-experience-v2.md`](../conversation-experience-v2.md)、
> 決定 [ADR-0018](../../adr/0018-conversation-experience-v2.md)（ADR-0017 navigation を一部改訂）。
> 旧票（live-idle / live-speaking / detection / material / uploading / analysis / scroll / complete）は
> v2 票へ統合（git 履歴に残置）。

## 一覧と優先度

優先度は「核となる差別化 × 未実装ギャップ」で決める。P0=最優先（核かつ未実装）/ P1=必要 / P2=既存で軽微差分。

| # | 系 | ファイル | 優先度 | 現状 |
|---|---|---|---|---|
| 01 | ホーム | [`01-home.md`](01-home.md) | P2 | 実装済（差分小） |
| 02 | 準備 | [`02-prepare.md`](02-prepare.md) | P1 | 実装済（精緻化） |
| 03 | 会話開始（開始前/接続/許可/失敗） | [`03-conversation-start.md`](03-conversation-start.md) | P1 | 未実装 |
| 04 | 会話履歴（音声・選択肢3モード・検知） | [`04-conversation.md`](04-conversation.md) | **P0** | 未実装（核） |
| 05 | 参考資料（一覧/詳細/追加・背景解析） | [`05-materials.md`](05-materials.md) | **P0** | 未実装（核） |
| 06 | 要件絵巻と深掘り（閲覧のみ） | [`06-requirements-scroll.md`](06-requirements-scroll.md) | **P0** | 未実装（核） |
| 07 | 判定（確定ゲート） | [`07-judgment.md`](07-judgment.md) | P1 | 未実装（新規） |
| 08 | 結果（産婆結果＋出力） | [`08-result.md`](08-result.md) | P1 | 未実装 |

## フロー（正本 v2）

```
01 ホーム → 02 準備 →
  03 会話開始 → 04 会話履歴 ⇄ 05 参考資料 ⇄ 06 要件絵巻 → 07 判定 → 08 結果
                └ 04〜06 は「会話を止めない」3タブの同一シェル（素材は背景解析で随時合流）
```

## 要件票のフォーマット

各票は以下の節を持つ。実装者がこの票だけで着手できることを目標にする。

1. **目的 / Figma 対応** — 画面の狙いと正本ノード。
2. **UI 要素** — Figma 上の主要素を実装観点で列挙。
3. **状態 / 遷移** — 画面の状態と入出力イベント（[`../realtime-contract.md`](../realtime-contract.md) の `type` を参照）。
4. **連携** — 呼ぶ API / 購読するデータチャネルイベント。
5. **受け入れ基準（AC）** — Given/When/Then 主体のチェックリスト。
6. **現状差分** — 既存実装（`apps/web/app/page.tsx` 他）との差分。
7. **優先度と根拠**。

## 用語・表記の方針

- **機能名で書く**：矛盾検知（`contradiction_detector`）/ 抜け検知（`scope_specialist`・`nfr_specialist`）/
  インタビュー統括（`interview_lead`）。
- **表示コピーは全面古語**（デモ演出）。ただし**機能名・契約・コードは機能名**で書き、**a11y ラベルは現代語**
  （[ADR-0017](../../adr/0017-figma-canonical-onepath-archaic-copy.md)）。色トークン: **矛盾=緋 `#D2564B` / 抜け=黄土 `#E0A93B`**
  （意味↔色のマッピング・[`../README.md`](../README.md) §4 由来）。**色のみに依存せずラベル＋アイコン併記**。
- アクセシビリティ：親指操作（タップ領域44px以上）、字幕の可読性、状態色は色のみに依存しない（アイコン/ラベル併記）。
