# ADR-0027: セッション単位の GitHub リポジトリ選択

- ステータス: **Accepted（受理・2026-07-04 確定）**
- 日付: 2026-07-04
- 関連: [ADR-0007](0007-external-connectors.md)（GitHub コネクタ・**本 ADR が repo 解決を拡張**）/
  ADR-0014（セッションメタ文書）/ ADR-0017（一本道・02 準備）

## コンテキスト

GitHub コネクタ（ADR-0007）は「読み取り grounding（Issue/README →問いの文脈）」と
「確定要件 → Issue 起票」を担うが、対象リポジトリは環境変数 `GITHUB_REPO`（`owner/name`）の
**デプロイ単位の固定値**だった。実際の利用では壁打ちのテーマごとに対象リポジトリが変わる
（プロダクト A の要件は A のリポジトリへ）ため、**セッション実施前（02 準備）に
リポジトリを選択**できる必要がある。

## 決定

1. **選択の場所は 02 準備**（一本道は不変）。「連携リポジトリ（任意）」を役割・ゴールに続く
   任意フィールドとして追加する。コネクタ無効（`github_connector_enabled=false`）の環境では
   フィールド自体を出さない（デモ・クリティカルパスへの不干渉を維持 / ADR-0007）。
2. **持ち回りはセッション文書**。`SessionMeta.github_repo: str | None` を追加し、
   `POST /api/sessions` が `owner/name` 形式を検証（`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`、
   不正は 400）して保存する。API（`/export`）と agent（grounding seed・
   `export_requirements_to_github` ツール）は **セッション値 → 環境変数の順で解決**する
   （未選択セッションは従来挙動のまま）。
3. **候補一覧は API が供給**。`GET /api/github/repos`（要ログイン）が、設定済みトークンで
   `GET /user/repos` を呼び full_name の一覧を返す。コネクタ無効時は
   `{enabled: false, repos: []}` を返し UI は非表示。一覧取得に失敗しても
   `{enabled: true, repos: []}` とし、UI は手入力（`owner/name`）へフォールバックする
   （選択機能の不調で開始を止めない）。
4. **トークンは共有のまま**。ユーザー個別の GitHub OAuth は本 ADR の範囲外
   （ADR-0007 の保留を維持）。選択できるのは設定済みトークンが読めるリポジトリに限られる。

## 影響

- `packages/sanba_shared`（SessionMeta）/ `apps/api`（作成・一覧・起票）/
  `apps/agent`（seed・起票ツール）/ `apps/web`（02 準備の選択 UI・prepFormStorage）。
- 旧セッション文書は `github_repo` を持たない → `None` フォールバックで互換。
- 観測: 既存の `session_created` / `requirements_exported` ログに repo（選択有無）を含める。

## 却下した代替案

- **ルームメタデータで agent へ渡す**: LiveKit room metadata でも渡せるが、セッション文書は
  API/agent/管理画面が既に共有する正であり、二重の運搬路を作らない。
- **自由入力のみ（一覧なし）**: `owner/name` の打ち間違いが起票失敗になって現れ、
  失敗の発見が遅い。一覧を第一、入力をフォールバックにする。
- **ユーザー個別 OAuth**: スコープ管理・レート制限・デモ破綻リスクが大きい（ADR-0007）。
  共有トークンの範囲で始め、需要が立ってから別 ADR で扱う。
