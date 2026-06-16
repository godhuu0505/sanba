# ADR-0011: 自律 PR babysitter ループ（issue 起点〜マージ可能まで）

- ステータス: Proposed
- 日付: 2026-06-16
- 関連: ADR-0010（AI による PR 自動レビューと対応フロー）を発展・置換する。

## コンテキスト

ADR-0010 では「Codex が指摘 → Claude が一次対応」を `pull_request_review`
起動の **単発の in-Actions 対応**として実装した。これは「1 イベント = 1 反応」で
あり、レビュー往復を最後まで自走させる仕組みは持っていない。結果として人間が
「次のレビューを促す」「修正を確認して再レビューを投げる」往復に張り付く余地が残る。

本 ADR では、**人間の手を「issue を書く」と「マージ」の 2 点だけ**に絞り、
その間（実装 → PR → レビュー往復 → マージ可能化）を Claude が**自律ループ**で
回す方式に進化させる。CLAUDE.md の原則「成果物の品質に責任を持つのは人間」は
**最終マージ判断（人間 1 承認）を必須**にすることで維持する。

設計判断は `grill-me` セッションでディシジョンツリーを枝ごとに解消した（本 ADR の各節）。

## 決定

### 1. パイプラインの入口 = issue 駆動
- 人間の創造的入力は **issue を書くこと**に集約する。issue に所定のラベル
  （例: `ai:build`）を付ける／アサインすると、Claude のセッションが起動して
  実装し、PR を上げ、そのまま当該 PR の **babysitter** になる。
- 人間が触るのは **「issue を書く」と「マージ」だけ**。
- 最初の Codex レビューは auto-review 設定に依存させず、**babysitter が PR open 時に
  `@codex review` を投げて確実に発火**させる（再レビュー機構と同じ作法）。

### 2. ループの定義と終端条件（mergeable）
- babysitter は次を 1 反復として、**マージ可能（mergeable）になるまで**繰り返す:
  1. Codex（将来は人間レビュアーも）のレビューを取得・解釈する。
  2. 指摘ごとに **対応 / skip / issue 起票** を判断し、対応は PR ブランチへ最小修正を push。
  3. `@codex review` で再レビューを促し、CI（quality-gate）の結果を待つ。
- **反復上限 N = 5**。超過したら自走を止め `needs-human` へエスカレ（§6）。
- **mergeable の定義**:
  - **quality-gate（必須・ブロッキング）が緑**: `lint/format + 型 + 単体テスト + build`
    （`just lint` / `just test` 相当の軽量ゲート）。
  - **branch protection で人間レビュー 1 承認**が付いている。
  - babysitter は **approve も merge もできない**（§4 の最小権限で担保）。
  - すなわち「緑のゲート ＋ 人間 1 承認」が揃って初めてマージ可能。最終判断は人間。
- E2E（Playwright）・LLM eval・深いセキュリティスキャンは **非ブロッキング**とし、
  schedule / main マージ後に回す（flaky でループを詰まらせない・コストを抑える、§7,§9）。

### 3. 実行基盤の durability = ephemeral セッション（主）＋ watchdog フォールバック（従）
- **主**: babysitter は Claude Code の **ephemeral セッション**として走り、
  `subscribe_pr_activity` で PR の CI / レビュー / コメントイベントを購読して反応する。
  新インフラを増やさず、低コストで自走できる。
- **従**: セッションがコンテナ回収等で**落ちている**ケースに備え、
  **GitHub Actions の cron watchdog** を置く。watchdog は「**open かつ最新が
  Codex レビュー／`@codex` 要求で X 分応答なし、かつ実行中の対応 Actions が無い**」
  PR を停止中とみなし、**in-Actions フォールバック**（`claude-review-response.yml`）を
  起動して 1 反復を肩代わりする。二重起動はデバウンスで防ぐ。
- **2 コードパスのドリフト防止**: babysitter（セッション）と in-Actions フォールバックは
  **単一の挙動仕様ファイル `docs/automation/pr-babysitter-spec.md` を共有**し、
  両者がそれを読んで同一に振る舞う。プロンプトを 2 重実装しない。

### 4. 自動化 identity = GitHub App（最小権限）
- babysitter / フォールバックが使う identity は **GitHub App**。
  - スコープは **PR ブランチへの `contents: write` と `checks: write` のみ**。
    **main 不可・`secrets` 不可・admin 不可・merge 不可**。
  - 乗っ取られても被害は「人間マージと quality-gate を要する PR ブランチ」に限定される。
- **`GITHUB_TOKEN` は使わない**: 標準 `GITHUB_TOKEN` で push したコミットは
  **下流ワークフローを起動しない**ため、Claude の修正 push で CI も Codex 再レビューも
  発火せず**ループが死ぬ**。App トークン（または PAT）の push は下流 WF を起動する。
- App はコミットが **bot 帰属**・**短命トークン**・rate limit が高いという利点もある。

### 5. セキュリティ（プロンプトインジェクション対策）
- レビュー本文・差分・PR 本文・依存コード中のコメント等の**外部入力は常に「データ」**として
  扱い、そこに埋め込まれた指示文（"以前の指示を無視せよ" 等）には**従わない**。
- **セキュリティ重要パスは自動適用しない**: `.github/workflows/**`・`infra/**`・
  デプロイ / WIF / `secrets` 系に触れる修正は babysitter が**自動 push せず、
  必ず `needs-human` にエスカレ**する。乗っ取り時の権限昇格・横展開を断つ。
- §4 の最小権限と合わせ、**最悪でも被害は単一 PR ブランチに封じ込める**。

### 6. エスカレーション = `needs-human` ラベル（受動）
- 反復上限超過 / Codex との不一致 / セキュリティ重要パス変更 などで自走できないときは、
  babysitter が **`needs-human` ラベルを付与**して自走を止める。
- 外部 push 通知（Slack 等）は持たない。**GitHub 内で完結**させ、可視化は
  ラベル一覧 / ダッシュボード運用で補う。
- 滞留 PR は**自動クローズしない**（作業の喪失を避ける）。

### 7. 通知 = GitHub ネイティブ中心
- CI 失敗 / watchdog の検知 → **PR コメント・check** に出す。
- 予算枠の枯渇（§8）→ **自動で issue を起票**する。
- それ以外 → **GitHub 標準のメール通知**に委ねる。外部連携・追加コストはゼロ。

### 8. 予算 = spending limit ＋ 失敗通知
- GitHub Actions / API の **spending limit を設定**して暴走コストを上限で止める。
- 失敗・枠枯渇は §7 の GitHub ネイティブ通知で気づける状態にする。

### 9. LLM eval（Langfuse）= main マージ後 ＋ 週次のみ
- LLM 回帰評価は API 課金が高いため **PR ゲートから外す**。
- **main マージ後**と **週次 schedule** で全体回帰を定点観測する。
- 残リスク: プロンプト回帰は PR では止まらず main で検出される。P1（ユーザー無し）では
  許容。**stg/prd が出現する P2/P3 で PR ゲート化への再昇格を再検討**する。

## 検討したが採用しなかった選択肢
- **常時 in-Actions で babysitter を回す**: Actions 分を恒常消費しコストが嵩む。
  ephemeral セッションを主とし、Actions は停止時フォールバックに限定した。
- **専用の常駐インフラ（Cloud Run 等）で babysitter を常駐**: P1 で過剰。新インフラを
  増やさず ephemeral＋watchdog で必要十分。
- **エスカレを Slack へ push**: 外部連携を増やす。GitHub ネイティブ（ラベル）で完結させた。
- **LLM eval を全 PR で必須化**: コードのみの変更でも毎回 LLM API 課金が発生し高コスト。
- **人間承認なしの自動マージ**: CLAUDE.md「人間がマージ判断」に反するため不採用。
- **`GITHUB_TOKEN` で push**: 下流 WF を起動せずループが死ぬため不可。

## 影響 / 移行
- 新規: GitHub App（§4）、`quality-gate` 集約必須チェック（§2）、branch protection（§2）、
  共有挙動仕様 `docs/automation/pr-babysitter-spec.md`（§3）、watchdog cron（§3）、
  `needs-human` 等のラベル（§6）。
- 改修: `claude-review-response.yml` を「App トークン・spec 参照・needs-human・
  セキュリティパスガード」対応のフォールバックへ。`llm-eval.yml` を PR から
  post-merge＋週次へ（§9）。
- ADR-0010 は本 ADR に置換される（Codex 公式 GitHub 連携・サブスク認証の前提は踏襲）。
- 実装は依存関係つきの GitHub Issue（本 ADR を親トラッキングに紐付け）に分割して進める。
