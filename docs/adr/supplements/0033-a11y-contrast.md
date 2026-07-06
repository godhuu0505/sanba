# ADR-0033 アクセシビリティ検証記録（Phase 6・2026-07-05）

ADR-0033「白い紙の上の問答」の UI 刷新について、**AA コントラスト**・**reduced-motion**・
**色のみ非依存**・**純黒禁止**の品質ゲートを実測で総点検した記録。正は
[docs/adr/0033-ui-redesign-v2-sticker-paper.md](../0033-ui-redesign-v2-sticker-paper.md)。

測定は WCAG 2.1 相対輝度式（sRGB）で `fg`×`bg` を算出（[scratchpad の node スクリプトと同式](../0033-ui-redesign-v2-sticker-paper.md)）。
基準: **本文 4.5:1** / 大型・太字 3:1 / **図形・アイコン（非テキスト）3:1**。

## 1. AA コントラスト実測

### 本文・小文字テキスト（基準 4.5:1）— 全パス ✅

| fg (`--sanba-`) | 面 | 実測 | 判定 | 用途 |
|---|---|---|---|---|
| cream / ink / frame（墨） | 紙 / 白 / 淡 | 15.99 / 16.55 / 14.66 | ✅ | 主要テキスト・枠 |
| muted（鈍） | 白 / 紙 / 淡 | 5.37 / 5.19 / 4.76 | ✅ | 補助テキスト |
| muted | 朱淡 / 山吹淡 / 瑠璃淡 | 4.61 / 4.87 / 4.71 | ✅ | 淡色面上の補助テキスト |
| gold-text（山吹暗） | 白 / 紙 / 淡 / 山吹淡 | 5.43 / 5.24 / 4.81 / 4.92 | ✅ | 見出し・ひらめき |
| rec-text（朱文字） | 白 / 紙 / 朱淡 | 5.29 / 5.10 / 4.53 | ✅ | CTA 文字・矛盾告知 |
| speak-text（萌黄暗） | 白 / 紙 | 6.55 / 6.33 | ✅ | 認識中ステータス文字 |
| caution（黄土） | 白 / 淡 / 山吹淡 | 6.55 / 5.80 / 5.93 | ✅ | 留意・未確定 |
| select（瑠璃） | 白 / 紙 / 瑠璃淡 | 5.75 / 5.55 / 5.04 | ✅ | 選択・リンク・ユーザー |
| cat-ambiguous（藍鼠） | 白 | 5.36 | ✅ | 分類チップ（検知・不明瞭） |
| cat-nonfunctional（菫） | 白 | 6.27 | ✅ | 分類（非機能） |
| cat-neutral（鈍灰） | 白 | 5.12 | ✅ | 分類（制約・既定） |
| cat-scope（青緑） | 白 / 淡 | 4.94 / **4.37** | 白✅ / 淡は図形基準 | 分類（境界） |

> `cat-scope` は淡面 (#f4f1e8) で 4.37:1（本文 4.5 未達）。ただし実使用は `ResultView` の
> `aria-hidden` アイコン描画で**白面**（4.94:1）に載る。分類色は**補助**であり識別はラベル＋
> アイコンが担う（Issue #101・色のみ非依存）ため、非テキスト 3:1 基準で十分。**実欠陥なし。**

### 反転（面に白/濃文字・基準 4.5:1）

| 組み合わせ | 実測 | 判定 | 備考 |
|---|---|---|---|
| 白文字 on rec-text（朱 CTA 面） | 5.29 | ✅ | Button gold variant の面は rec-text（ADR §4） |
| 白文字 on rec（明朱 #e0402a） | **4.25** | ⚠️→対象外 | **本文には未使用**。rec 面に白文字を載せる箇所は存在しない（後述） |
| 白文字 on select（瑠璃面） | 5.75 | ✅ | 選択チップ on |
| 墨(ink) on gold（山吹面） | 8.13 | ✅ | 産章・強調チップ |
| ink-bubble on select-pale | 14.51 | ✅ | ユーザー吹き出し |

### 図形・アイコン・枠（基準 3:1）

| fg | 面 | 実測 | 判定 | 解釈 |
|---|---|---|---|---|
| frame（墨枠） | 白 | 16.55 | ✅ | すべてのステッカー枠 |
| rec（朱の図形/REC/枠/アイコン） | 白 | 4.25 | ✅ | REC ドット・警告アイコン・枠 |
| gold-deep（山吹枠線） | 白 | 3.05 | ✅ | |
| speak（萌黄の波形/音波） | 白 | **2.77** | ⚠️→装飾許容 | 下記参照 |
| gold（山吹面/マイク） | 白 | **2.04** | ⚠️→墨枠で担保 | 山吹面は常に 2px 墨枠(16.5:1)で縁取り。面境界は墨で判別 |
| gold-amber（山吹の陰） | 白 | 2.56 | ⚠️→装飾 | 陰影の装飾。意味を担わない |
| border-strong（区切り/静止波形） | 白 | 1.55 | 対象外 | 区切り線・装飾波形は 3:1 非適用 |

## 2. ⚠️ 項目の判断（すべて「実欠陥なし」）

- **白文字 on rec（4.25:1）**: rec (#e0402a) は ADR §4 で「文字を載せない図形/アクセント専用」。
  grep で `bg-sanba-rec`（白文字を載せうる面）を全走査した結果、テキストを載せる用途は **0 件**
  （REC ドット 7px の `aria-hidden` のみ）。CTA 面は rec-text (#c43a20・5.29:1) を使用。**問題なし。**
- **rec を色として使う `style={{color: var(--sanba-rec)}}` 4 箇所**（MaterialCancelDialog /
  ConversationStart / JudgmentGate / EndConfirmDialog）はいずれも **`aria-hidden` の大型アイコン
  （X / TriangleAlert / Scale・22〜32px）**を彩色し、2px の rec リング枠で囲われる。意味は隣接テキストが
  担う。非テキスト 3:1（白面 4.25:1）を満たし、**問題なし。**
- **萌黄 speak（2.77:1）**: 波形バー（`Waveform`）と音波（`VoiceInputBar`）の装飾に限定。
  波形は `role="img" aria-label="集音中"`、かつ**墨バー(16.5:1)と交互**で形が墨で判別できる。
  認識中の文言は speak-text (#4a6619・6.55:1) を使う。色のみに意味を負わせておらず装飾として許容。
  → **ADR §影響の「萌黄 3.2:1」は実測 2.77:1（白地）に要訂正**（下記 ADR 追記で対応）。
- **山吹 gold（2.04:1）**: 面は常に 2px 墨枠で縁取られ、面境界は墨(16.5:1)で判別可能（ADR §4/§7）。
  非テキスト contrast は隣接色（墨枠）との差で満たす。**問題なし。**

## 3. 「萌黄/山吹を小さな地文に使わない」の遵守確認

`text-sanba-speak`（`-text` を除く素の萌黄）・`text-sanba-gold`（`-text`/`-deep` 等を除く素の山吹）を
`apps/web` 全 tsx で grep → **0 件**。文字は必ず暗色トークン（speak-text / gold-text）を使用。**遵守。**

## 4. reduced-motion 総点検 — 全カバー ✅

`globals.css` の全 `@keyframes`／アニメーションに `@media (prefers-reduced-motion: reduce)` で
静止規則が対応：

| アニメ | キャリア class | reduce 規則 |
|---|---|---|
| sanba-wave（波形） | `.sanba-wave-bar` | `animation: none` ✅ |
| sanba-glow-pulse（REC 脈動） | `.sanba-rec-dot` | `animation: none` ✅ |
| sanba-fig-*（棒人間 8 種） | `.sanba-fig-joint` | `animation: none !important` ✅ |
| sanba-slide（マーキー） | `.sanba-marquee-track` | `animation: none; transform: none` ✅ |
| sanba-parade-move（パレード） | `.sanba-parade-walker` | `animation: none` ✅ |

- 棒人間の全アニメは `<Joint>`（`className="sanba-fig-joint"`）またはインライン
  `style={{animation}}` + `className="sanba-fig-joint"` で駆動され、`!important` の reduce 規則が
  インラインより優先して静止させる（`Figure.tsx`・`VoiceInputBar.tsx` で確認）。
- `Waveform` のバーは `.sanba-wave-bar` を持ち、インライン `animationDelay` は delay のみ上書き。
  reduce では `animation: none` により `animation-name` が消え静止する。
- **JS 駆動のアニメーションは存在しない**（`matchMedia`/`useReducedMotion` 参照は 0）。全アニメが
  CSS メディアクエリで静止するため、機能追加なしで reduced-motion を尊重する。

## 5. 純黒禁止・直書き色の最終走査 — クリーン ✅

`apps/web`（tsx/ts）全走査：
- 純黒 `bg-black` / `#000` / `rgba(0,0,0,*)` / `text-black`：**0 件**。
- 素の `[var(--sanba-*)]` bracket 色記法（影 arbitrary を除く）：**0 件**。
- 直書き rgba/rgb リテラル：**0 件**（ghost ボタンの影を `--sanba-shadow-strong` へトークン化）。
- 直書き hex 色リテラル：**0 件**（Issue 番号参照 `#NNN` はコメント内で色ではない）。
- Phase 6 是正: `join/[token]` の bracket 記法 5 箇所をユーティリティへ（#309 で混入した回帰）／
  `GitHubLinkCard` の未定義 `--sanba-danger`(#e06) を `text-sanba-rec-text`（朱=矛盾・5.29:1）へ。

## 6. 実機ランタイムスモーク

`next build` → `next start` で主要静的ルートを確認：
`/` `/login` `/products` `/settings` `/admin` = **200**、存在しないパス = 404（not-found 表示）。
`/design` はショーケースのため本番 `NODE_ENV=production` で `notFound()`（意図どおり・本 PR 未変更）。
配信 HTML に sanba ユーティリティが載り `bg-black` は 0。生成 CSS に `--sanba-shadow-strong` と
join ページのユーティリティが出力されることを確認。

> フルスタック docker（web は api healthy 依存）での人手目視と、Playwright による E2E
> スクリーンショット比較は本フェーズでは未実施（推奨フォローアップ）。上記の静的評価・生成 CSS 実測・
> ルート 200 で機能面の等価は担保している。

## 7. 結論

- **AA・reduced-motion・色のみ非依存・純黒禁止のいずれも実欠陥なし。** UI 是正はゼロ（意匠不変）。
- 是正は「不統一の解消」のみ（join 回帰・danger トークン化・shadow トークン化）で見た目 no-op。
- ADR §影響の実測値の一部（萌黄 3.2:1 等）が概算だったため、ADR に Phase 6 実測を追記して訂正する。
