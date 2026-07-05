# ADR-0033: UI デザイン刷新 v2（白い紙の上の問答 — ステッカー×原色×動く棒人間）

- ステータス: **Accepted（受理・2026-07-05 確定 / 全 Phase 実装・検証完了 2026-07-05）**
  - Phase 1〜4: トークン・ステッカー意匠・棒人間配線・帯/動き（#305/#306/#308 ほか）。
  - Phase 5: 一貫性クリーンアップ（暗幕→墨・mapping トークン化・色クラス記法統一 / #310）。
  - Phase 6: 品質検証（AA / reduced-motion / 純黒 / 実機スモーク）→ [検証記録](../a11y-contrast-adr0033.md)。**実欠陥なし。**
- 日付: 2026-07-05
- 関連:
  - **[ADR-0025](0025-light-paper-redesign.md) を Superseded にする**（本 ADR が唯一の正）。
  - [ADR-0017](0017-figma-canonical-onepath-archaic-copy.md)（一本道 IA・古語文言）＝**維持**。
  - [ADR-0019](0019-google-signin-button-branding.md)（Google サインインの枠）／
    [ADR-0022](0022-conversation-realtime-model-ambiguous-and-voice-state.md)（音声状態）＝棒人間の配線先。
- 参考 / 正本:
  - [ノーミーツ／NOMEETS](https://no.meets.ltd/)（白地×手描き線画×動く人物×原色アクセント×流れる帯）。
  - **デザイン提案 v2（HTML）**。ステークホルダー確定。**同 HTML の CSS トークン・`@keyframes`・SVG 棒人間を実装の正**とする。

## コンテキスト

ADR-0025 で「漆黒×金 → 白い紙×原色」への移行を決め、トークン層は light 化済み。しかし実装が
**中途半端**だった:

1. **動く棒人間が実体験に配線されていない** — `Figure` は 5 状態で CSS アニメ実装済みだが、実画面での
   使用は home/login=`walking`・404=`asking` のみ。`listening`/`insight`/`writing` は dev 見本ページだけで、
   会話・音声・生成の本体験でサンバさんが活動しない。
2. **確定デザインとの乖離** — マーキー帯・手描きの揺らぎ角丸・マーカー下線強調・歩く一団（パレード）・
   ドックに座る棒人間、といった提案の「帯と動き」の要素が未実装。
3. **不統一** — 色クラス記法の二重運用（`bg-[var(--sanba-*)]` と `bg-sanba-*`）、`lib/realtime/mapping.ts`
   の色直書き、モーダル暗幕の純黒 `bg-black/55`。

ステークホルダーが具体的なデザイン提案 HTML を確定した。**旧 ADR-0025 の値・分析・過去の実装値は破棄**し、
本 HTML を唯一の正として全面適用する。**情報設計（一本道・3 タブ）と語彙（古語）と a11y は不変**——変えるのは
見た目と「動き」だけ。

## 決定

アートディレクションを **「白い紙の上の問答 — ステッカー×原色×動く棒人間」** に確定する。
`--sanba-*` トークンの**名前空間・参照箇所・コンポーネント API はすべて維持**し、値と意匠のみ差し替える。

### 1. カラートークン（HTML `:root` を正・和名の原色）

| 役割 | 和名 | 値 | トークン | 用途 |
|---|---|---|---|---|
| 下地 | 紙 kami | `#FCFBF7` | `--sanba-bg` | 画面下地（生成りがかった白） |
| 面 | 白 shiro | `#FFFFFF` | `--sanba-surface` | カード・入力の面 |
| 線 | 墨 sumi | `#221E1A` | `--sanba-frame`/`--sanba-cream`/`--sanba-ink` | 線・主要テキスト・強い枠 |
| 行動 | 朱 shu | `#E0402A`（面）/ `#C43A20`（文字） | `--sanba-rec` / `--sanba-rec-text` | 主要 CTA・録音・矛盾 |
| 選択 | 瑠璃 ruri | `#2A5CDB` / 淡 `#EAF0FF` | `--sanba-select` / `--sanba-select-pale` | 選択・ユーザー発話・リンク |
| 産章 | 山吹 yamabuki | `#F0A814` / 淡 `#FDF3DC` | `--sanba-gold` / `--sanba-gold-pale` | 産章・ひらめき・マイク |
| 認識 | 萌黄 moegi | `#7FA83C` | `--sanba-speak` | 音声認識中（**アイコン・太字・図形のみ**。3.2:1） |
| 補助 | 鈍 nibi | `#8C8478` | `--sanba-muted` | 補助テキスト |
| 区切 | 藁色 waraiiro | `#EDE8DC` | `--sanba-border` | 弱い区切り・淡い枠 |
| 影 | — | `rgba(34,30,26,.12)` | `--sanba-shadow` | ステッカーのベタ塗りオフセット影 |

現行実装値からの主な差分: `--sanba-rec` `#c43a20`→**面 `#E0402A`＋文字 `#C43A20` を分離**／`--sanba-speak`
`#4a6619`→**`#7FA83C`（明るい萌黄。小文字禁止・アイコン/太字限定）**／`--sanba-muted` `#6e675a`→`#8C8478`／
`--sanba-border` `#e7e1d3`→`#EDE8DC`。新設: `--sanba-gold-pale`・`--sanba-rec-text`・`--sanba-shadow`。

**純黒（`#000` / `bg-black`）は使用しない。** 影・暗幕・半透明はすべて墨ベース `rgba(34,30,26,α)`。
モーダル暗幕 `bg-black/55` は墨ベースへ置換する。

### 2. 書体

- 見出し（display）: **Zen Kaku Gothic New 800**（`@fontsource` で自前配信・[ADR は fonts self-host 済]）。
- 本文/UI: **Noto Sans JP 400/700**。行間 1.75、`-webkit-font-smoothing: antialiased`。
- 明朝: **Noto Serif JP** は**ロゴ円章の「産」一字のみ**（系譜の継承）。

### 3. ステッカー様式（意匠の核・"押せる"を形で示す）

- 面 `--sanba-surface`、枠 **2px `--sanba-frame`**、**手描きの揺らぎ角丸**
  `border-radius: 15px 17px 14px 18px / 17px 14px 18px 15px`、影 **`5px 5px 0 var(--sanba-shadow)`**。
- カード標準角丸 `--sanba-radius-card: 16px`。

### 4. ボタン

- **primary（朱ステッカー）**: 白文字を載せるため**面は AA 安全な朱 `#C43A20`（`--sanba-rec-text`）**を使う
  （白文字 5.3:1）。明るい `#E0402A`（`--sanba-rec`）は**文字を載せない図形/アクセント**（RECドット・枠・帯）専用。
  display 800・**2px 墨枠**・角丸 12px・影 `3.5px 3.5px 0 var(--sanba-frame)`・`letter-spacing .04em`。押下で影が潰れる。
  ※AA厳守（Codex #293 レビュー反映）: 白文字 × `#E0402A` は 4.3:1 で通常文字 AA 不足のため面色を分離した。
- **ghost（白ステッカー）**: 面 白・墨文字・2px 墨枠・角丸 12px・影 `3px 3px 0 rgba(34,30,26,.15)`。

### 5. 帯と動き（no.meets から借りる"軽やかさ"）

- **マーキー帯**: 上下 2px 墨・白地、キーメッセージが横スクロール（`slide` 22s）。語ごとに朱/瑠璃/山吹。
- **マーカー下線強調** `.u-shu`: `linear-gradient(transparent 68%, rgba(224,64,42,.38) 68%)` を見出しの要語に。
- **歩く一団（パレード）**: 画面下部を複数の棒人間が `paradeMove` で横断（`animation-delay` でずらす）。
- **ドックに座る棒人間**: 会話ドック右上に小さなサンバさんが座って耳を澄ます。

### 6. 棒人間「サンバさん」= 状態を伝える UI 部品（`components/sanba/Figure.tsx`）

SVG 線画＋CSS `@keyframes`（依存ライブラリ不要）。共通ストローク: `--sanba-frame` / width 3 / round cap /
no fill、頭は白 fill。**5 状態**と**実画面への配線**:

| 状態 | 動き | 配線先 |
|---|---|---|
| `walking` | 手足 `swingA` .72s alternate＋胴 `bob` | home ヒーロー・履歴の `strollAcross`・パレード |
| `asking` | 頭 `tiltHead`＋朱の「?」浮遊 | 404・問い提示中 |
| `listening` | 手を耳に＋萌黄の音波 `waveArc` 3 本ずらし | **会話：聞き取り中**（ADR-0022 status.phase=listening） |
| `insight` | 両腕 `cheer`／`cheerR`＋山吹の電球 `glowPulse` | **要件確定/結果・ひらめきカード** |
| `writing` | 書く腕 `scribble`＋紙 rect | **要件生成中・ドキュメント化中** |

**運用ルール（維持）**: 1 画面に同時に出すのは **1 体まで**。`prefers-reduced-motion: reduce` で全アニメを
静止（`animation-duration: .01ms; animation-iteration-count: 1`）。装飾は `aria-hidden`、意味を持つ場合のみ
`role="img"＋label`。

### 7. コンポーネント意匠（HTML 準拠）

- **Chip（役割）**: 1.5px 墨枠・角丸 99px。選択 `.on` は瑠璃ベタ＋白文字。
- **吹き出し**: エージェント＝白＋1.5px 墨・左上に 4px の角（尻尾）。ユーザー＝瑠璃淡 `#EAF0FF`＋1.5px 瑠璃・右上に角。
- **アバター**: 円・1.5px 墨。エージェント＝山吹地＋明朝「産」。
- **ひらめきカード**: 山吹淡 `#FDF3DC`＋1.5px 破線 `#C98F0D`＋電球。
- **ドック（音声）**: 上 2px 墨・白地。波形バー（墨、偶数バー萌黄）が `waveBar`。ステータス文言＝萌黄。
  マイク＝46px 山吹＋2px 墨＋オフセット影。
- **REC ピル**: 1.5px 朱枠・朱文字・ドット `glowPulse`。
- **端末枠（PhoneFrame）**: 2.5px 墨・角丸 30px・オフセット影。

### 8. 維持するもの（SANBA のアイデンティティ）

産章（山吹の円章＋明朝「産」）／和名の色と意味論（**朱=録音・矛盾／萌黄=認識中／瑠璃=選択・ユーザー**）／
一本道の情報設計（ADR-0017）／産婆術の語彙（吹き出し・要件絵巻 等）。

## 影響

- 変更は **`apps/web` のみ**。`--sanba-*` 名前空間・`components/sanba/*` の **props/API は不変**のため
  利用側ロジックの変更なし。作業実体は「トークン値の再調整＋各画面への棒人間配線＋帯/動きの新規実装＋
  意匠の HTML 準拠化＋不統一の解消」であり、dark→light の移行ではない（既に light）。
- **AA コントラスト**を基準に検証（墨 16.5:1 / 瑠璃 6.1:1 / 朱文字 `#C43A20` 4.6:1）。
  **萌黄 `#7FA83C`（3.2:1）と山吹 `#F0A814` は小さな地文には使わず、アイコン・大型太字・図形（3:1 基準）に限定。**
- モーダル暗幕・影を墨ベースへ統一（純黒禁止）。色クラス記法は `bg-sanba-*` ユーティリティへ統一し、
  `lib/realtime/mapping.ts` の直書き hex はトークン参照へ寄せる。
- Figma 正本（漆黒×金）とは乖離するため、本 ADR 適用後の実装を新たな見た目の正とする（ADR-0011 で追従）。

## 却下した代替案

- **no.meets への全面ミニマル化（墨線・ステッカーを捨て極薄の線と大余白へ）**: 「押せる感」と体温、
  SANBA の graphic な個性が消える。**帯・動く棒人間・原色アクセントは借りるが、太い墨枠＋ベタ塗り影の
  ステッカー様式は SANBA の核として残す**（提案 HTML の 06 REFERENCE 準拠）。
- **Lottie 等による棒人間アニメ**: 依存とバンドル増。SVG＋CSS で十分軽量（提案 HTML が実証）。
- **トークン全面リネーム**（`--sanba-gold`→`--sanba-yamabuki` 等）: 参照 348 箇所超に及び差分が肥大。
  名前空間を維持し値のみ差し替える。

## 検証（Phase 6・2026-07-05）

全 Phase 実装後の品質ゲート総点検。詳細と実測表は
[docs/a11y-contrast-adr0033.md](../a11y-contrast-adr0033.md)。**AA・reduced-motion・色のみ非依存・
純黒禁止のいずれも実欠陥なし**（UI 是正ゼロ・意匠不変）。要点:

- **AA コントラスト（WCAG 2.1 相対輝度で実測）**: 本文トークンは全て実使用面で 4.5:1 以上。
  図形/アイコンは 3:1 以上、または装飾（`aria-hidden`＋意味は隣接テキスト）で色に意味を負わせない。
  萌黄・山吹を素の文字色に使う箇所は 0（暗色 speak-text / gold-text を使用）。
- **§影響の概算コントラスト値を実測で更新**（本節を正とする）:
  瑠璃 select `#2A5CDB` = **5.75:1**（白地。旧記載 6.1）／朱文字 rec-text `#C43A20` = **5.29:1**（白地。
  旧記載 4.6 は淡面 4.68 相当）／萌黄 speak `#7FA83C` = **2.77:1**（白地。旧記載 3.2 は不正確）。
  萌黄は 3:1 未満だが、波形/音波の装飾（`role="img"` ＋ 墨バーと交互で形状判別）に限定のため許容。
- **reduced-motion**: 全 `@keyframes`（wave / glow-pulse / fig-* / slide / parade-move）に
  `prefers-reduced-motion: reduce` の静止規則が対応。JS 駆動アニメは無し（全て CSS メディアクエリで静止）。
- **純黒・直書き色**: `apps/web` で `bg-black`/`#000`/`rgba(0,0,0)`・素の `[var(--sanba-*)]` 記法・
  直書き rgba/hex いずれも 0。Phase 6 の是正は不統一解消のみ（`join/[token]` の記法回帰、
  未定義 `--sanba-danger`→`rec-text`、ghost 影を `--sanba-shadow-strong` へトークン化）で見た目 no-op。
- **実機スモーク**: `next start` で主要ルートが 200、not-found が 404。フルスタック docker の人手目視と
  Playwright E2E は推奨フォローアップ（本フェーズ未実施）。
