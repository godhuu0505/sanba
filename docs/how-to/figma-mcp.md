# Figma MCP — UI/UX デザインループ

機能実装時に Figma 上で UI/UX を検討・実装・修正するための MCP 連携手順。
設計判断の背景は [ADR-0011](../adr/0011-figma-mcp-design-loop.md) を参照。

> **正本の向きに注意（[ADR-0047](../adr/0047-app-is-canonical-figma-follows.md)）**: 現在は
> **`apps/web` の実装が UI/UX の唯一の正本**で、Figma は追従する follower。したがって主用途は
> 「**コード → デザイン**（実装を Figma に反映）」であり、Figma を正として実装へ写す旧運用は行わない。
> 意匠の定義は ADR-0033、トークンの実体は `apps/web/app/globals.css`。

## 何ができるか

AI コーディングエージェント（Claude Code 等）から、インターネット越しに Figma を双方向操作できる。

- **コード → デザイン（主用途）**: 実装やコンポーネントを Figma に書き戻し／同期する（正本＝実装）。
- **デザイン → コード（参考）**: Figma のフレーム/コンポーネントを読み取り、検討の下敷きにする。
- ダイアグラム・FigJam の生成、デザインシステム/トークンの参照。

## 採用構成

リポジトリ直下の `.mcp.json` で**リモート（ホスト型）MCP サーバ**を共有設定している。

```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    }
  }
}
```

- 認証は **OAuth**。トークンはコミットしない（CLAUDE.md のシークレット規約）。
- ローカルのデスクトップ版（`http://127.0.0.1:3845`）はクラウド/web セッションでは動かないため既定にしない。

## セットアップ

1. Claude Code でこのリポジトリを開く（`.mcp.json` が自動で読み込まれ、初回はサーバ承認を求められる）。
2. `/mcp` を実行し、`figma` を選んで OAuth 認証する（ブラウザで Figma にサインイン）。
3. 認証後、`figma` の各ツール（`get_design_context` / `get_screenshot` / `use_figma` など）が使える。

CLI から個別追加する場合:

```bash
claude mcp add --transport http figma https://mcp.figma.com/mcp
```

> 補足: 公式の Figma プラグイン（`/figma-use` などの SKILL を同梱）を入れると、`use_figma` 実行前の
> 手順ガイドが使える。プラグイン未導入時は MCP リソースが配る skill がフォールバックとして使われる。

## 使い方の例

- コード → デザイン（主用途）: 既存実装を指して「この画面を Figma に起こして／実装に合わせて Figma を直して」
  と依頼する（`use_figma` 系）。正本は `apps/web` の実装（ADR-0047）。
- デザイン → コード（参考）: 対象フレームの URL を渡し、意匠検討の下敷きにする
  （`get_design_context` / `get_screenshot`）。旧 Figma 正本を実装へ写す運用はしない。

## 注意

- 機密 Figma ファイルを AI に渡す範囲は人間が判断する（成果物責任は人間 — CLAUDE.md 原則 1）。
- デザイン取得は外部 I/O で、CI 単体テストの対象外。コード化した UI は `apps/web` の
  lint / `tsc --noEmit` / Playwright E2E で担保する。
- ネットワークポリシーで `mcp.figma.com` への到達が必要。クラウド実行環境では環境のネットワーク設定を確認する。
