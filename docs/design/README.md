# SANBA — UI/UX 機能拡張デザイン

> **⚠ 正本の逆転・アートディレクション刷新（[ADR-0042](../adr/0042-app-is-canonical-figma-follows.md) /
> [ADR-0033](../adr/0033-ui-redesign-v2-sticker-paper.md) / 2026-07-06）**:
> 本ファイルは当初「**UI/UX 正本は Figma**」「アートディレクション＝産婆術アトリエ（**金彩 / 漆黒×金**）」を
> 掲げていたが、いずれも**過去のもの**。現在の正は次のとおり:
> - **正本＝`apps/web` の実装**（Figma は追従する follower。ADR-0042）。
> - **アートディレクション＝「白い紙の上の問答」（明るい白地×原色アクセント×動く棒人間）**（ADR-0033。§0「産婆術アトリエ／金彩」と §4「indigo/金彩トークン」は **Superseded**）。
> - **トークンの実体＝`apps/web/app/globals.css` `:root`**、棒人間＝`components/sanba/Figure.tsx`、ロゴ＝`components/sanba/Logo.tsx`（棒人間マーク／[ADR-0034](../adr/0034-app-icon-and-stick-figure-logo.md)）。
>
> 以下 §0・§4 の金彩／indigo 記述と「Figma が唯一の正本」という宣言は**歴史的記録**として残すが、
> 実装・Figma の意匠を直す際の正には使わない。Figma 再構成の指針は [`figma-redesign-spec.md`](figma-redesign-spec.md)。

> 解像度を、画面で上げていく。
> 音声で対話しながら要件の「抜け漏れ・矛盾」をリアルタイムに検知する壁打ち産婆を、
> **準備 → 対話 → 確定 → 振り返り** まで一気通貫で支える体験へ拡張する画面・情報設計。

現状の `apps/web/app/page.tsx` は「参加フォーム＋音声ビジュアライザ」の最小実装。
本ドキュメントは、その先の機能拡張 UI/UX を **情報設計（IA）→ 画面設計 → デザインシステム** の順に定義する。

> ## ⭐ 正本（Single Source of Truth）【Superseded — 旧・Figma 正本宣言】
>
> **Superseded（ADR-0042）**: 下記の「Figma が唯一の正本」「Figma モバイル縦10画面が正本」という宣言は**過去のもの**。
> 現在の正本は **`apps/web` の実装**（ADR-0042。Figma は追従する follower）。
> 以下は 2026-06-24 の設計判断の歴史的記録として残すが、実装・Figma の意匠を直す際の正には使わない。
>
> **このプロダクトの UI/UX 正本は Figma「📱 iPhone 13 Pro 操作フロー・正本」（モバイル縦・全10画面の一本道フロー）。**
> 画面ごとの実装可能な要件票は **[`screens/`](screens/)**、リアルタイム伝送と状態復元の契約は
> **[`realtime-contract.md`](realtime-contract.md)** に分離した。
> 会話フェーズ（03〜08）の刷新案は **[`conversation-experience.md`](conversation-experience.md)**
> （会話を止めない 3 タブ・選択肢 3 モード ほか。navigation は [ADR-0018](../adr/0018-conversation-experience.md) で ADR-0017 を一部改訂）。
> 当初このドキュメントが定義した**デスクトップ3分割 + ダッシュボード起点 IA**（§2〜§3）は、
> 今回のスコープでは正本から外し **§2.9「次フェーズ（デスクトップ拡張）」** として保持する。
> アートディレクション（§0）・デザイントークン（§4）・ADR 接続（§5）は正本でも引き続き有効。
>
> | 決定（grill 2026-06-24） | 内容 |
> |---|---|
> | 正本 | Figma モバイル縦10画面が唯一の正本。デスクトップはロードマップへ退避 |
> | 成果物 | 画面別要件票（目的/UI要素/状態/連携/受け入れ基準）= [`screens/`](screens/) |
> | リアルタイム | LiveKit データチャネル + GET ハイドレーション = [`realtime-contract.md`](realtime-contract.md) |
> | 擬人化 | 緋/黄土/侍/産婆・古語ボイスは**デモ演出**。要件は機能名で記述 |
> | 範囲 | 今回はドキュメント・要件のみ（apps 実装は別PR/Issue） |

## 🖼 ビジュアル（まず見る）

UI/UX の**正本は `apps/web` の実装**（ADR-0042。Figma は follower）。画面ごとの実装可能な要件は
[`screens/`](screens/) を参照する。意匠（色・書体・様式）は ADR-0033 と `apps/web/app/globals.css` が正。

### Figma（ADR-0011 のデザインループ / 要 Figma ログイン）

| 種別 | 内容 | リンク |
|---|---|---|
| 🎨 Design（**follower**・旧正本。ADR-0042 で格下げ） | 「📱 iPhone 13 Pro 操作フロー」モバイル縦・全10画面の一本道（01ホーム→…→12完了）。**2026-07-06 に一次反映済み**（残ポリッシュ段階）。正本は `apps/web` の実装 | [figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=31-2](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=31-2) |
| 🎨 Design（follower・運用UI・~~黄金テーマ~~→現行デザインに追従中・プロトタイプ動線つき） | 上記 iPhone ページ（31-2）に運用 UI を追加。**ログイン／ログアウト（11→12→13→14）** と **管理（91→92→93→94）** の2ユースケースを画面遷移つきで作成。13→01ホーム/91、12は本人確認後に自動遷移、94→11。旧「産婆術アトリエ」黄金テーマは Superseded（ADR-0042） | [11 ログイン](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-3) ・ [12 確認中](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-4) ・ [13 導線](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-5) ・ [14 ログアウト](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-6) ・ [91 一覧](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-8) ・ [92 作成](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-9) ・ [93 レビュー](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-10) ・ [94 ゲート](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=73-11) |
| 🎨 Design（参考） | 「ライブ対話」の デスクトップ / スマホ / タブレット ＋ 完成イメージ ＋ マルチモーダル入力（→ §2.9 次フェーズ） | [figma.com/design/eI6QvvCEO021zpdMmxr8Iq](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq) |
| 🎨 Design（運用 UI・デスクトップ・**実装と同期**） | 「🛠 管理画面 / 🔐 ログイン / 🚦 アクセスゲート状態 / 🔀 管理ユーザーフロー」（ADR-0014 を `apps/web` の `/admin`・`/login` 実装と 1:1 で同期） | [🛠 /admin](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=53-2) ・ [🔐 /login](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=52-2) ・ [🚦 ゲート状態](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=56-2) ・ [🔀 フロー](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=58-2) |
| 🎨 Design（運用 UI・**iPhone**・プロトタイプ動線つき） | 上記デスクトップ運用 UI を iPhone 幅（390×844）へリフロー。同じ light shadcn トークンを踏襲。`ログイン(未)→ログイン(済)→管理画面 / インタビュー`、ゲート→ログインの動線を Figma プロトタイプで接続（起点=「運用UI（ログイン→管理）フロー」） | [🔐 ログイン(未)](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=64-3) ・ [🔐 ログイン(済)](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=64-4) ・ [🛠 管理画面](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=64-5) ・ [🚦 ゲート(401/403)](https://www.figma.com/design/eI6QvvCEO021zpdMmxr8Iq?node-id=64-6) |
| 🧩 FigJam | 情報設計 / ユーザーフロー図 | [figma.com/board/suTkSZdCrixD4DiONzMBPO](https://www.figma.com/board/suTkSZdCrixD4DiONzMBPO) |

> 運用 UI（管理画面・ログイン）は正本のモバイル10画面フローとは別系統（light shadcn テーマ）。
> デスクトップ版に加え、**iPhone 版（390×844）** を同じトークンで用意し、Figma プロトタイプで
> ログイン→管理／インタビューの動線を接続済み（node 64-3〜64-6）。
> `apps/web/app/admin/page.tsx` / `app/login/page.tsx` の実装が更新されたら、ADR-0011 の双方向ループで
> 上記 Figma ノード（デスクトップ・iPhone 双方）へ反映する（コードと画面設計・ユーザーフローを乖離させない）。

> Figma → コード（`apps/web` 実装）、コード → Figma（同期）の双方向ループは ADR-0011 の通り MCP で回す。

---

## 0. アートディレクション「産婆術アトリエ（Gilded Maieutics）」【Superseded — 旧・金彩】

> **Superseded（ADR-0033）**: 本節の金彩／漆黒×金アートディレクションは**過去のもの**。
> 現行は「白い紙の上の問答（明るい白地×原色×動く棒人間）」。以下は歴史的記録として残す。

> ソクラテス・産婆術・テンペラ・油彩・マツケンサンバ・松平健 ── 6つの主題を一つのアトリエに。

一見バラバラな6モチーフは、すべて **「対話で産み出し、層を重ね、黄金で祝う」** という SANBA の所作に重なる。
意匠は飾りではなく**プロダクトの核の比喩**：テンペラ下塗り→油彩グレーズの重ね塗り＝「解像度を上げる」所作そのもの。

| 主題 | 意匠への翻訳 |
|---|---|
| 🏛 ソクラテス / 産婆術 | 一問一答で**裡なる答えを取り上げる**＝音声インタビューの核。問答の「間」を主役に |
| 🥚 テンペラ（下塗り） | verdaccio 下塗り・黄土の土色＝要件の**下地**（粗い確信度から塗り起こす） |
| 🎨 油彩（グレーズ） | キアロスクーロ（暗がりに光）＝**解像度を重ねる**所作。暗背景に金の光が差す画面 |
| ✨ 金箔 | イコンの金地＝**神の光**。確定要件を金の銘板で照らし、出所を後光のように添える |
| 💃 マツケンサンバ | 絢爛たる黄金＋**四角スパンコール**（丸→四角に進化）＝要件が「産まれた」祝祭（完成の幕切れ） |
| 🗡 松平健 | 時代劇の**格調と所作**＝明朝体・金縁の額・雷文（メアンダー）で品位を通す |

**パレット**（古典絵具に状態色を対応）：金箔 `#D4AF37`（神の光・祝祭）／ oxblood 緋 `#D2564B`（矛盾・caput mortuum）／
黄土 `#E0A93B`（抜け・yellow ochre）／橄欖 `#A9BE6E`（発話中・verdaccio）。背景は油彩の闇（burnt umber `#140F08`）、文字は羊皮紙 `#EFE6C9`。
書体は明朝／Garamond 系の serif。装飾（金縁の額・雷文・四角スパンコール・月桂冠・羊皮紙）は**外部画像を使わず CSS／インライン SVG で再現**（自己完結・外部リクエストなしの方針を維持）。

**緩急で品位を保つ**：常用画面は油彩の落ち着き（認知負荷ミニマム）、要件が「産まれた」完成時だけ黄金が爆ぜる（オーレ！）。

> 意匠の典拠は Web 調査に基づく（下記ソース）。
> **既存の機能設計（IA・画面・コンポーネント・状態セマンティクス）は一切変えず、見た目だけを差し替える「スキン」**として位置づける。
> 色は意味と一対一で対応（紫→金、ティール→橄欖、琥珀→黄土、赤→緋）させたまま移し替えるため、Must/Should/Could・矛盾/抜け・エージェント種別などの**識別性は保持**される。実装時は §0（金彩 / Gilded Maieutics）を正とし、状態色は `lib/realtime/mapping.ts` と一致させる（ADR-0017 で §4 → §0 に単一化）。
>
> Sources: [Egg tempera & gold leaf (Artists Network)](https://www.artistsnetwork.com/art-mediums/mixed-media/using-egg-tempera-gold-leaf-to-achieve-renaissance-luminocity/) · [Byzantine icon palette / ochre (Betsy Porter)](https://www.betsyporter.com/color-recipes/) · [Rembrandt の色（Natural Pigments）](https://www.naturalpigments.com/artist-materials/rembrandt-van-rijn-color-palette) · [Umber / chiaroscuro (Wikipedia)](https://en.wikipedia.org/wiki/Umber) · [Greek key / meander (Shutterstock)](https://www.shutterstock.com/blog/greek-key-pattern) · [マツケンサンバ 金衣装・四角スパンコール（マイナビ）](https://news.mynavi.jp/article/20190706-855089/) · [松平健 サンバ衣装（NIKKEI MAGAZINE）](https://magazine.nikkei.com/article/DGXZQOLM1391W0T10C22A1000000)

---

## 1. 設計原則（認知負荷ミニマム）

音声ファースト。話すことに集中できるよう「見るべきもの」を絞り、**発見（矛盾・抜け）が起きた瞬間だけ**画面が静かに前に出る。

| | 原則 | 意味 |
|---|---|---|
| **P1** | 声に集中させる | 常時は穏やかなビジュアライザ＋字幕。テキストUIは分析層の補助に徹し会話を遮らない |
| **P2** | 発見を主役に | 矛盾＝赤 / 抜け＝琥珀。検知時だけカードが立ち上がり「あ、それ言ってなかった」を演出 |
| **P3** | 根拠を必ず添える | 確定要件に「誰の発話か（出所）・確信度・引用元」を常に併記し検証可能に |
| **P4** | 協調を見せる | Lead→専門Agent→再計画の連鎖をトレース可視化。薄いボットでない必然性を画面で示す |

## 2. 情報設計（IA）— 正本（モバイル一本道）

正本は **モバイル縦・一本道フロー**。「準備 → 会話開始 → 対話 → 資料/要件確認 → 判定 → 結果」を分断しない直線。
各画面の要件は [`screens/`](screens/)、会話フェーズの詳細は [`conversation-experience.md`](conversation-experience.md) を参照。

```
01 ホーム → 02 準備 →
  03 会話開始 → 04 会話履歴 ⇄ 05 参考資料 ⇄ 06 要件絵巻 → 07 判定 → 08 結果
                └ 04〜06 は「会話を止めない」3タブの同一シェル（素材は背景解析で随時合流）
```

> **会話フェーズ（03〜08）は 新設計へ改訂**（2026-06-25 / [ADR-0018](../adr/0018-conversation-experience.md)・ADR-0017 navigation を一部改訂）。
> 旧 03〜10 票は 現行票へ統合。

| 系 | 役割 | 優先度 | 要件票 |
|---|---|---|---|
| 01 ホーム | 入口・価値訴求 | P2 | [01](screens/01-home.md) |
| 02 準備 | ゴール/役割/資料(RAG)/同意 | P1 | [02](screens/02-prepare.md) |
| 03 会話開始 | 開始前/接続/録音許可/失敗 | P1 | [03](screens/03-conversation-start.md) |
| 04 会話履歴 | **核**：音声対話・選択肢3モード・矛盾/抜け検知 | **P0** | [04](screens/04-conversation.md) |
| 05 参考資料 | **核**：投入・背景解析・言葉×画の矛盾 | **P0** | [05](screens/05-materials.md) |
| 06 要件絵巻 | **核**：MoSCoW・確信度/出所（閲覧のみ） | **P0** | [06](screens/06-requirements-scroll.md) |
| 07 判定 | 確定ゲート（未解消0で確定） | P1 | [07](screens/07-judgment.md) |
| 08 結果 | 産婆結果＋出力（PDF/Drive/Issue） | P1 | [08](screens/08-result.md) |

> 以降の §2.9〜§3.6（ダッシュボード起点 IA・デスクトップ3分割・レスポンシブ・マルチモーダル詳細）は、
> **次フェーズ（デスクトップ拡張）の参考設計**。今回の正本スコープ外だが、拡張時の出発点として保持する。

## 2.9 次フェーズ（デスクトップ拡張）の IA【参考・正本外】

「会話 → 要件 → 検知 → 確定 → Issue」を分断しない直線フロー。準備と振り返りが対話を挟む。

```
① ダッシュボード ─► ② セッション準備 ─► ③ ★ライブ対話 ─► ④ 要件サマリ ─► ⑤ 振り返り/評価
     入口/実績         ゴール・資料(RAG)      核となる体験       MoSCoW/Issue化     検知率/品質
                                              │
                                              └─► ⑥ 多人数会議モード（Phase 2/3 拡張）
```

## 3. 画面カタログ【参考・正本外（デスクトップ拡張）】

| # | 画面 | 役割 | 主な要素 | 根拠 |
|---|---|---|---|---|
| 1 | **ダッシュボード** | 入口。最短2クリックで壁打ちへ | 検知数の実績、最近のセッション、解像度の推移 | ADR-0008 #6 |
| 2 | **セッション準備** | 既存フォームを「準備」に格上げ | ゴール、役割、参考資料ドロップ(RAG)、同意ゲート | ADR-0003 / 0007 |
| 3 | **★ ライブ対話** | **核**。声/検知/要件の三分割 | 音声ビジュアライザ＋字幕、矛盾・抜けアラート、言葉×モック矛盾、協調トレース、育つ要件ボード | ADR-0002 / 0004 / 0008 |
| 4 | **要件サマリ** | 対話の成果物 | MoSCoW構造化、出所・確信度・引用、GitHub Issue 書き戻し | Issue #39 / ADR-0007 |
| 5 | **振り返り/評価** | 運用と改善 | 検知率 Before/After、エージェント別貢献、LLM-judge 品質スコア | ADR-0005 |
| 6 | **多人数会議**（拡張） | 同画面を N:M へ拡張 | 話者レーン（識別）、司会キュー、全員分の出所メタ | roadmap Phase 2/3 |

### 核となる画面（③ ライブ対話）の構成

```
┌──────────────┬──────────────────┬──────────────┐
│  🎧 対話     │  ⚡ リアルタイム検知  │  📋 要件ボード  │
│              │                  │              │
│  音声オーブ   │  ⚠ 矛盾アラート(赤)  │  Must/Should │
│  ＋字幕      │  ◯ 抜けアラート(琥珀) │  /Could      │
│  (出所付き)   │  🖼 言葉×モック矛盾   │  確信度バー   │
│              │  ─────────────   │  出所メタ     │
│              │  🔗 協調トレース     │              │
│              │  Lead→矛盾検知→再計画 │              │
└──────────────┴──────────────────┴──────────────┘
   左=声          中央=検知・協調(核)      右=育つ要件
```

## 3.5 レスポンシブ（スマホ / タブレット）【参考・正本外】

移動中・会議前のハンズフリー利用を想定し、**音声ファースト＋ボトムシート**で再設計。
同じ情報構造（声 / 検知 / 要件）を画面幅に応じて「並べる / 切り替える / 重ねる」で出し分ける。

| ブレークポイント | レイアウト方針 |
|---|---|
| 🖥 Desktop ≥1200 | 声・検知・要件を**横3分割**で常時表示 |
| 📐 Tablet 768–1024 | 声を左固定、**検知⇄要件をセグメント切替**する右ペインの2分割 |
| 📱 Phone ≤430 | 声を**全面**、検知＝**ボトムシート**（peek→展開）、要件＝**タブ**で重ねる |

設計指針：

- **M1 声を全面に** — 常時はオーブ＋字幕。歩きながら・準備しながら使える。
- **M2 検知はせり上がる** — 矛盾・抜けの検知時だけボトムシートが peek→展開し、最小割り込みで核を伝える。
- **M3 親指で完結** — マイク・タブ・確定など主要操作は下部 thumb-zone（44px 以上のタップ領域）。
- **M4 1画面1ジョブ** — 準備→対話→要件→サマリを縦スクロールの単一フローに。

ビジュアルは Figma（参考リンク・§🖼）のデスクトップ/タブレット成果物を参照（次フェーズで正本へ追補）。

## 3.6 マルチモーダル I/O（提供 ⇄ 提示）【参考・正本外】

要件は言葉だけに宿らない。**入力（ユーザー → SANBA）と出力（SANBA → ユーザー）の双方向**を設計し、
ビジュアルを「問いの道具」にして言葉にならない差分まで引き出す（産婆術のループ）。

```
音声 ─┐
画像/動画/画面共有 ─┼─► 矛盾・抜け検知 ─► 確定要件 ─► 完成イメージ生成（仮説）
                          ▲                                    │
                          └──────── 「ここが違う」フィードバックを要件へ還流 ◄┘
```

### 入力 — ユーザーからの情報提供

- **形を問わない**：画像 / 動画 / ライブ画面共有 / カメラ撮影（ホワイトボード・スケッチ）。
- **ビジュアル→要件**：画面要素・画面内テキストを要件化し、出所を「どの素材の・どこ（領域/秒）か」まで保持。
- **言葉×ビジュアルの矛盾検知**：「検索したいと言ったが画面に検索バーが無い」を検知し核に接続（ADR-0004）。
  画像は領域ピン、動画はタイムラインマーカーで根拠を指し示す。

### 出力 — SANBA からの完成イメージ提示

確定要件から「こんな画面になりそうです」を生成して提示し、要件→画面イメージ→コードを地続きにする（ADR-0011）。

- **O1 生成物は「仮説」**：`✨ AI生成・推測` を必ず明示。事実・確定として提示しない。
- **O2 要素をたどれる**：各UI要素が「どの要件から来たか」を併記。未確定は**ゴースト**で可視化。
- **O3 問い返しの道具**：「ここが違う」を引き出し、修正コメントを新しい発話＝要件として**還流**させる。
- **O4 確定は人間**：採用判断・Figma/実装への受け渡しは人手のレビュー後（CLAUDE.md）。

> ⚠️ 「完成イメージ生成」はプロダクト/アーキの拡張であり、採用時は `docs/adr/NNNN-generative-preview.md` として
> 設計判断（生成経路・コスト観測・誠実な見せ方・薄い実装の禁止）を記録する想定。

実装メモ：入力の画面共有/カメラは既存 LiveKit 映像トラック（ADR-0004）、画像/動画は API → Cloud Storage → Gemini 解析。
生成は**非同期で会話を止めない**（二層構造を踏襲, ADR-0002）。所要時間/コストは Langfuse で観測する。
ビジュアルは Figma（参考リンク・§🖼）のマルチモーダル入力成果物を参照（次フェーズで正本へ追補）。

## 4. デザインシステム（トークン）【Superseded — 旧・indigo/金彩】

> **Superseded（ADR-0033）**: 下表の indigo/金彩トークンは**過去のもの**。現行トークンの実体は
> `apps/web/app/globals.css` `:root`（`--sanba-*`）＝紙 `#FCFBF7`・墨 `#221E1A`・朱 `#E0402A`・
> 瑠璃 `#2A5CDB`・山吹 `#F0A814`・萌黄 `#7FA83C`。状態色は `lib/realtime/mapping.ts` を正とする。

夜間の落ち着いた indigo をベースに、**状態を色で一貫**させる。

> **注（ADR-0017 / #147）**: 正本のアートディレクションは §0「産婆術アトリエ（金彩）」へ移行済み。本 §4 は旧 indigo スキンの記録で、**状態色（矛盾 / 抜け / 発話中）は §0 と `lib/realtime/mapping.ts` を正**とする（下表はそれに合わせて更新済み）。非状態トークン（brand / 背景 / タイポ）の金彩への完全同期は別途。

| トークン | 値 | 意味 |
|---|---|---|
| Brand / AI | `#6C5CE7 → #8E75B2 → #1FD5A3`（gradient） | AI・思考（Gemini violet） |
| Live / 発話中 | `#1FD5A3` | ライブ・アクティブ（LiveKit teal） |
| 抜け (Gap) | `#E0A93B` | 未充足の必須項目（黄土 / yellow ochre。`lib/realtime/mapping.ts` と一致） |
| 矛盾 (Contradiction) | `#D2564B` | 対立する発言（緋 / oxblood caput mortuum。`lib/realtime/mapping.ts` と一致） |
| 背景 / surface | `#0C0E1B` / `#161A30` | deep night indigo |
| タイポ | Inter + Noto Sans JP | 和欧混植で字幕の可読性確保 |
| 角丸 / グリッド | 18 / 12 px・8pxグリッド | 線で静かに分割（影は最小） |

MoSCoW チップ（Must=赤 / Should=琥珀 / Could=teal）、エージェントタグ（Lead / 非機能 / スコープ / 矛盾検知）も
色＝意味として全画面で固定する。詳細は HTML のコンポーネントギャラリー参照。

## 5. 既存プロダクト判断（ADR）との接続

本デザインは新規の思いつきではなく、確定済みの設計判断を「画面の言葉」に翻訳したもの。

- **ADR-0008（コンセプト）**: 主ペルソナ=社内PdM、核=リアルタイム矛盾・抜け検知 → 画面③の中央に常設
- **ADR-0002（二層分離）**: 音声(Gemini Live) / 推論(ADK) → 左=声、中央=協調トレース
- **ADR-0004（マルチモーダル）**: 言葉×モック矛盾 → 画面③のモック赤枠ハイライト
- **ADR-0003 / 0007（RAG・GitHub）**: 資料 grounding / Issue書き戻し → 画面②の資料投入、画面④の起票
- **ADR-0005（LLM-judge）**: 検知率の回帰評価 → 画面⑤の品質スコア
- **ADR-0011（Figma MCP）**: デザイン⇄コードのループ → 本デザインを Figma へ同期し実装へ

## 6. 次の一手

今回はドキュメント・要件の整備まで（apps の実装は別PR/Issue）。次の実装フェーズの順序:

1. **P0 から着手** — 08 解析結果 / 06 素材 / 05 検知 / 09 要件絵巻。先に
   [`realtime-contract.md`](realtime-contract.md) の追加 API（`GET /requirements`、`POST /export`）と
   データチャネル publish を入れる。
2. **apps/web 実装** — [`screens/`](screens/) の要件票を React 化し LiveKit Components / データチャネルと接続。
3. **計測の配線** — 検知数・確信度・要件数を OTel / Langfuse に通し評価（ADR-0005）へ供給。
4. **デスクトップ拡張** — §2.9〜§3.6 を次フェーズとして Figma 正本に追補（レスポンシブ両対応）。

> 成果物の品質に責任を持つのは人間（CLAUDE.md）。本デザインは下書きであり、
> 実装・採用の判断はレビューを経て人間が行う。
