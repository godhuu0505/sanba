# ADR-0039: 正本の逆転 — アプリ実装を唯一の正本とし、Figma を追従させる

- ステータス: **Accepted（受理・2026-07-06）**
- 日付: 2026-07-06
- 関連:
  - **[ADR-0011](0011-figma-mcp-design-loop.md)（Figma MCP デザインループ）＝方向を改訂**。
    「デザイン → コード」を主とする前提を、本 ADR で「**コード（実装）→ デザイン**」主体へ反転する。
  - **[ADR-0033](0033-ui-redesign-v2-sticker-paper.md)（白い紙の上の問答 — ステッカー×原色×動く棒人間）＝視覚言語の正**。
    本 ADR は ADR-0033 の実装を「唯一の正本」と定義するだけで、意匠そのものは ADR-0033 に委ねる。
  - [ADR-0025](0025-light-paper-redesign.md)（Superseded）／[ADR-0017](0017-figma-canonical-onepath-archaic-copy.md)（一本道 IA・古語文言＝維持）。
  - 監査記録: [`docs/design/figma-implementation-audit.md`](../design/figma-implementation-audit.md)、
    画面票: [`docs/design/screens/README.md`](../design/screens/README.md)。

## コンテキスト

これまでの設計運用では、Figma「📱 iPhone 13 Pro 操作フロー・正本」（fileKey `eI6QvvCEO021zpdMmxr8Iq`）を
**唯一の正本**とし、`apps/web` の実装がそれに追従する形をとってきた（`docs/design/screens/README.md`・
`figma-implementation-audit.md`・ADR-0011）。

しかし ADR-0025 →**ADR-0033** で視覚言語が **「漆黒×金（黄土色を主とする暗色＋金彩グラデ）」から
「白い紙の上の問答（明るい白地×原色アクセント×動く棒人間）」へ全面刷新**され、その全 Phase の実装・
品質検証（AA / reduced-motion / 純黒禁止・[検証記録](../a11y-contrast-adr0033.md)）が完了した。

結果として、**現時点で「正しいデザイン」を体現しているのは実装（`apps/web`）側**であり、
Figma 正本は旧・漆黒×金のまま取り残されている。実際、Figma の各画面（例: `40:2` ホーム）は
いまも暗色地（`#3A2C12`／`#241A0F`）＋金彩グラデ（`#8A5A14`→`#D4AF37`）＋明朝主体で構成され、
実アプリ（生成りの白 `#FCFBF7`・ステッカー意匠・棒人間アイコン・原色は差し色）と乖離している。

「Figma を正、実装を従」のまま運用を続けると、監査（`figma-implementation-audit.md`）の差分は
**すべて「実装が正本から外れている」方向で誤検出**され、正しい実装を旧デザインへ引き戻す圧力になる。
これは事実と逆であり、有害である。

## 決定

1. **`apps/web` の実装（ADR-0033 に準拠した現行 UI）を、SANBA UI/UX の「唯一の正本」とする。**
   視覚言語の定義そのものは ADR-0033、トークンの実体は `apps/web/app/globals.css` の `:root`、
   棒人間は `apps/web/components/sanba/Figure.tsx`、コンポーネント見本は `apps/web/app/design/page.tsx` を正とする。

2. **Figma ファイル `eI6QvvCEO021zpdMmxr8Iq` は「正本」ではなく「実装を映す設計面（follower）」に格下げする。**
   Figma は実装に**追従**して更新する。今後、実装と Figma が食い違った場合は**実装を正**とし、Figma を直す。

3. **Figma を現行アプリのデザインに合わせて再構成する。** 再構成の指針（トークン対応・画面別の
   置換方針・36 フレームの範囲）は [`docs/design/figma-redesign-spec.md`](../design/figma-redesign-spec.md) に定義する。
   反映は Figma MCP `use_figma`（コード → デザイン）で行い、破壊的変更に備え Figma の版履歴を退避に用いる。

4. **ドキュメントの文言を反転させる。** `screens/README.md`・`figma-implementation-audit.md` の
   「Figma を唯一の正本とし実装が追従する」旨の記述を、「**実装を正本とし Figma が追従する**」へ改める。

## 理由 / 検討した代替案

- **実装を正本にする（採用）**: 「正しいデザインの製本は実アプリ」というステークホルダー判断（本タスクの明示要件）に整合。
  ADR-0033 の意匠は既に実装・検証済みで、動く棒人間・ステッカー・原色の意味論（朱=行動/録音・瑠璃=選択・
  山吹=ひらめき・萌黄=認識）は**コードでしか完全に表現できない**（アニメーション・状態遷移を含むため）。
  実装を正とすることで、監査の差分が「Figma が実装から外れている」正しい向きで出るようになる。
- **Figma を正本のまま維持し実装を旧デザインへ戻す**: 却下。ADR-0033 の全面刷新・検証を無に帰す。
  ステークホルダーの「旧・黄土色デザインは過去のもの。今は全く違う」という明示方針に反する。
- **両者を対等の二正本とする**: 却下。差分監査の判定基準が定まらず、どちらへ寄せるかで恒常的に揺れる。
  「成果物の品質責任は人間・単一の正を持つ」（CLAUDE.md 原則）に反する。
- **Figma を廃止する**: 却下。要件 → 画面イメージの検討面としての Figma の価値（ADR-0011）は残る。
  正本ではなく follower として使い続ける。

## 影響 / フォローアップ

- **Figma 側**: 36 フレーム（ログイン/ログアウト 11–15・管理 91–94・ホーム/準備 01–02・
  会話 03–08 と状態バリエーション）を新・視覚言語へ再構成する。対応表と画面別方針は
  `figma-redesign-spec.md`。反映は `use_figma` で段階的に行い、各フレームは `get_design_context` の
  読み戻しで構造的に照合する（本環境はスクリーンショットの画像取得が egress ポリシーで不可のため、
  ピクセル目視ではなく構造照合＋人間の Figma 上目視で担保する）。
- **観測性/セキュリティ**: ADR-0011 の前提（MCP は OAuth・成果物責任は人間・`/security-review` 対象）は不変。
- **ドキュメント**: `screens/README.md` 冒頭と `figma-implementation-audit.md` の方向性注記を更新（本 ADR と同時）。
  監査表の各差分の「期待」列は、今後 **Figma 側を直す**前提で読む（実装を期待値とする）。
- **回帰**: 実装の見た目は `apps/web` の lint / `tsc --noEmit` / Playwright E2E と ADR-0033 検証記録で担保済み。
  Figma 追従作業は外部 I/O のため CI 対象外（成果物責任は人間・CLAUDE.md）。

> 本 ADR は「どちらが正か」の**方向**のみを定める。意匠の中身は ADR-0033、具体的な Figma 反映手順は
> `figma-redesign-spec.md` を参照。
