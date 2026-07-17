# ADR-0073: 操作マニュアルを GitHub Pages で公開する

- ステータス: Accepted
- 日付: 2026-07-13
- 関連: [ADR-0050](0050-documentation-placement-and-lifecycle.md)（ドキュメント配置とライフサイクル —
  本 ADR は `docs/`（開発者向け Diátaxis）とは別軸の「エンドユーザー向け公開物」を定義する）/
  [ADR-0033](0033-ui-redesign-v2-sticker-paper.md)（ビジュアルデザイン言語 — サイトの配色・意匠を踏襲）/
  [ADR-0068](0068-no-comments-policy-yaml-terraform.md)（コメント禁止の適用範囲 — 追加 YAML もプラグマ以外は無注記）

## コンテキスト

`docs/` は ADR-0050 に基づく Diátaxis 構成で、読者は開発者・AI エージェントである。一方、SANBA を
実際に操作する人（企画者・利用者・招待メンバー）向けに、ログインから問答・成果確認・Issue 起票・
アプリ管理までを画面付きで通しで追える導線が無かった。

この導線は次の点で `docs/` の参照ドキュメントと性質が異なる。

1. **読者が違う** — 開発者ではなく操作者。用語も画面基準で、内部設計には触れない。
2. **形式が違う** — テキスト中心の Markdown ではなく、PC/スマホの画面キャプチャを主役にした閲覧用サイト。
3. **公開面が違う** — リポジトリ内で grep する対象ではなく、URL で共有できる公開ページ。

## 決定

操作マニュアルを、リポジトリ直下 `site/` の自己完結な静的サイトとして持ち、GitHub Pages で公開する。

1. **配置** — 公開サイトのソースは `site/`（`index.html` / `styles.css` / `assets/`）に置く。
   `docs/`（開発者向け Diátaxis）とは分離し、ADR-0050 の物理配置原則を破らない。意匠は ADR-0033 の
   トークン（紙 `#fcfbf7`・山吹 `#f0a814`・朱 `#e0402a`・墨線 `#221e1a`）を CSS 変数として写す。
2. **画面キャプチャ** — `apps/web` の画面を Playwright で PC（1440×900）・スマホ（390×844）両方で撮影する
   再現可能なハーネス（`apps/web/e2e/screenshots*.ts`）を持ち、生成物 `apps/web/screenshots/` は
   gitignore する。マニュアルが使う版だけを `site/assets/img/{pc,mobile}/` にコミットする。音声会話
   （問答）画面は LiveKit 実接続なしに会話フィクスチャ（`contractEventFixture`）を実 UI コンポーネント
   `ConversationSessionView` に流し込む dev 専用プレビュー `/design/conversation` で撮影する（本番は
   `notFound`）。
3. **配信** — `.github/workflows/pages.yml` が GitHub Actions で `site/` をデプロイする。トップレベル
   `permissions` は既定 `contents: read` とし、当該ジョブだけ `pages: write` / `id-token: write` に昇格
   する。Action は full SHA でピンし、バージョンはコメントで併記する（ADR-0068 の許可プラグマ）。
   トリガは `site/**` とワークフロー自身の変更に絞り、`workflow_dispatch` で手動再発行も可能とする。

## 検討したが採用しなかった選択肢

- **`docs/` に混在させ Pages を `/docs` 配信にする**: 却下。開発者向け Diátaxis に読者・形式の違う公開物が
  混ざり、ADR-0050 原則 4（区分とライフサイクルの物理分離）が担保できない。Actions 配信なら配置は自由で、
  分離を保てる。
- **MkDocs / Jekyll などの静的サイトジェネレータ導入**: 却下。単一ページの画面案内にビルド依存とテーマ
  設定を持ち込むのは過剰。ブランドに合わせた手書きの HTML/CSS の方が意匠の一致と保守が容易。
- **画面キャプチャをリポジトリに置かず CI で毎回生成**: 却下。マニュアルの見た目を PR で差分確認できる
  ことを優先し、使う版だけをコミットする。全生成物 `apps/web/screenshots/` は gitignore で追跡しない。

## 影響

- リポジトリ設定で GitHub Pages のソースを「GitHub Actions」に切り替える必要がある（初回のみ・オーナー操作）。
  切替後、`main` への `site/**` 変更で `https://godhuu0505.github.io/sanba/` が更新される。
- 画面を変えたら Playwright ハーネスで撮り直し、`site/assets/img/` の該当版を差し替える運用とする。
- 公開物のため、キャプチャには本番データを載せず開発ビルドのデモデータのみを用いる（ADR-0050 原則 8）。
