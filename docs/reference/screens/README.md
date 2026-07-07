# 画面別要件票 — モバイル一本道フロー

> **⚠ 正本の逆転（[ADR-0047](../../adr/0047-app-is-canonical-figma-follows.md) / 2026-07-06）**:
> 従来 Figma「📱 iPhone 13 Pro 操作フロー・正本」を唯一の正本としていたが、**ADR-0033 の全面刷新
> （白い紙×原色×動く棒人間）を実装・検証済みの現在、正本は `apps/web` の実装側に移った**。
> Figma は **2026-07-06 に一次反映済み**（全 36 フレームを新・視覚言語へ再構成。01 ホームは手本として全面再構築、
> 残りは配色＋書体の一括リマップ済み）で、**ステッカー化・棒人間配置・瑠璃淡状態などの残ポリッシュを人間が仕上げる**
> 段階にある（実施記録と残作業は [`../figma-redesign-spec.md`](../../notes/figma-redesign-spec.md) §7）。以後 Figma は
> **実装に追従する follower** であり、実装と食い違う場合は**実装を正**とする。本票の「Figma 対応」節は履歴・
> レイアウト参照として残すが、意匠（色・書体・意匠様式）の正は ADR-0033＋`apps/web` である。

各画面を実装可能な粒度の要件票に落とす。**1ファイル＝1系**（会話フェーズは系内の状態を票に内包）。
Figma フレーム（fileKey `eI6QvvCEO021zpdMmxr8Iq` / node `31:2`）とは 1:1 で対応するが、色・書体・意匠の正は実装側。

> スコープ（grill 2026-06-24）: **モバイル縦・一本道フロー**が正本。デスクトップ3分割は
> [`../README.md`](../../explanation/design-overview.md) の「次フェーズ（デスクトップ拡張）」へ退避。リアルタイム前提は
> [`../realtime-contract.md`](../realtime-contract.md)。
>
> **会話フェーズ（03〜08）改訂（2026-06-25）**: 会話を止めずに情報面を横断する **3 タブ
> （会話履歴 / 参考資料 / 要件絵巻）** へ再構成。詳細 [`../conversation-experience.md`](../conversation-experience.md)、
> 決定 [ADR-0018](../../adr/0018-conversation-experience.md)（ADR-0017 navigation を一部改訂）。
> 旧票（live-idle / live-speaking / detection / material / uploading / analysis / scroll / complete）は
> 現行票へ統合（git 履歴に残置）。

## 一覧と優先度

優先度は「核となる差別化 × 未実装ギャップ」で決める。P0=最優先（核かつ未実装）/ P1=必要 / P2=既存で軽微差分。

| # | 系 | ファイル | 優先度 | 現状 |
|---|---|---|---|---|
| 01 | ホーム | [`01-home.md`](01-home.md) | P2 | 実装済（差分小） |
| 02 | 準備 | [`02-prepare.md`](02-prepare.md) | P1 | 実装済（精緻化） |
| 03 | 会話開始（開始前/接続/許可/失敗） | [`03-conversation-start.md`](03-conversation-start.md) | P1 | 実装済（`ConversationStart`。開始前/接続中/失敗3導線/テキスト代替） |
| 04 | 会話履歴（音声・選択肢3モード・検知） | [`04-conversation.md`](04-conversation.md) | **P0** | 実装済（`ConversationShell`/`ChatHistory`/問いピン。検知＋通常質問 #181） |
| 05 | 参考資料（一覧/詳細/追加・背景解析） | [`05-materials.md`](05-materials.md) | **P0** | 実装済（`MaterialsList`。アップロード＋背景解析＋#184 復元） |
| 06 | 要件絵巻と深掘り（閲覧のみ） | [`06-requirements-scroll.md`](06-requirements-scroll.md) | **P0** | 実装済（`RequirementsTab`/`DeepDiveList`） |
| 07 | 判定（確定ゲート） | [`07-judgment.md`](07-judgment.md) | P1 | 実装済（`JudgmentGate`。確定は #186 finalize で永続化） |
| 08 | 結果（産婆結果＋出力） | [`08-result.md`](08-result.md) | P1 | 実装済（`ResultView`。GitHub Issue 起票） |

> **結線の現状（2026-06-26 更新）**: 03〜08 は `apps/web` に結線済み（TDD）。会話の双方向は
> リアルタイム契約に沿って実装: 検知の選択（`user.selection`）/ テキスト送信（`user.text` #185）/
> 通常質問の回答（`question.asked`・`user.answered` #181）/ 素材復元（GET `context/files` #184）/
> 確定の永続化（POST `finalize` #186）。残る seam は live Gemini ループ側のトリガ（ask_question の
> 発火条件・テキスト→応答の調整）で、実キー（`GOOGLE_API_KEY` 等）での実機検証が前提。

## フロー（正本）

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
  （[ADR-0017](../../adr/0017-figma-canonical-onepath-archaic-copy.md)）。色トークン（**現行 ADR-0033**）:
  **矛盾=朱 `--sanba-rec` `#E0402A`（文字は `--sanba-rec-text` `#C43A20`）/ 抜け=山吹 `--sanba-caution` `#7D560B`**
  （旧 `緋 #D2564B / 黄土 #E0A93B` は Superseded。実体は `apps/web/app/globals.css` と `lib/realtime/mapping.ts`）。
  **色のみに依存せずラベル＋アイコン併記**。
- アクセシビリティ：親指操作（タップ領域44px以上）、字幕の可読性、状態色は色のみに依存しない（アイコン/ラベル併記）。
