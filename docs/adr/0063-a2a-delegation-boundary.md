# ADR-0063: 音声エージェントから外部エージェントへの A2A 委譲境界

- ステータス: Proposed
- 日付: 2026-07-08
- 関連: [ADR-0002](0002-multi-agent-topology.md)（マルチエージェント・トポロジ／agent-as-a-tool と sub-agent の2境界）/ [ADR-0037](0037-background-prefetch-and-injection-policy.md)（背景処理と会話への注入ポリシー）/ [ADR-0040](0040-uploaded-video-async-analysis.md)（Cloud Tasks + 専用ワーカーの非同期パイプライン）/ [ADR-0046](0046-decouple-analysis-from-voice-worker.md)（音声 worker からの分析分離＝失敗ドメイン隔離）/ [ADR-0048](0048-inquiry-triage-and-support-knowledge.md)（sub-agent 追加を棄却しトポロジ不変を維持）/ [ADR-0051](0051-google-native-observability-and-llmops.md)（観測性・LLMOps・PII 規約）

## コンテキスト

要件インタビューの最中、司会役の Voice Agent には「今この場では答えを持っていない調査」を
誰かに任せたい場面が生まれる。例:

- **連携リポジトリの実装偵察**: 「その機能、既存コードではどう実装されている?」を、セッションに
  紐づいた GitHub リポジトリ（`SessionMeta.github_repo`）を横断的に読んで答える。
- **外部事実の調査**: 技術的実現可能性・競合・準拠すべき規約/法令など、会話履歴には無い一次情報の収集。
- **他プロダクト／他チームの専門エージェントへの指示**: 「この要件で設計レビューして」「見積もりを出して」を、
  SANBA の外にある別所有のエージェントに委任する。

これらは現状トポロジ（ADR-0002）の 2 境界では表現できない:

- **agent-as-a-tool**（Voice Agent → `analyze_requirements`, `apps/agent/src/sanba_agent/main.py:598`）は
  **同一プロセス内の関数呼び出し**。数秒〜数分かかる調査や、途中で人間の追加入力を要する対話を載せると、
  ADR-0046 で問題化した「音声ターンを最大 30 秒塞ぐランドマイン」を再現する。
- **sub-agent 協調**（`apps/agent/src/sanba_agent/agent_team.py:52-58`）は **同一 ADK チーム・同一コードベース・
  同一失敗ドメイン**。別デプロイ・別所有・長時間・（将来）社外のエージェントを内部 sub-agent に押し込むのは
  ADR-0046 の同居リスクの再発であり、ADR-0048 でも sub-agent 追加は明示的に棄却済みで方針が一貫している。

必要なのは、**プロセス／デプロイ／所有の境界をまたいで対等に通信する、標準化されたエージェント間プロトコル**である。
ここで [A2A（Agent2Agent、Linux Foundation）](https://a2a-protocol.org/) を採用する動機は、SANBA の既存資産と対応が取れる点にある:

- **Agent Card による能力発見**（`/.well-known/agent-card.json`）— 将来の多対多（README ロードマップ Phase3）に接続。
- **Task ライフサイクル**（`submitted / working / input-required / completed / failed / canceled`）— 長時間処理と
  「人間の追加入力待ち」を第一級で表現でき、産婆術（問いで引き出す）と親和的。
- **streaming（SSE）/ push notification** — 進捗を web に live 配信する既存の `EventPublisher`
  （`apps/agent/src/sanba_agent/events.py`）と対応。
- **JSON-RPC over HTTPS + 認証（OIDC/OAuth）** — ADR-0040 の「Cloud Run + IAM OIDC invoker 限定」と同じ運用に載る。

## 決定（提案）

ADR-0002 の 2 境界は**変えない**まま、第 3 の境界として **「A2A 委譲境界（cross-boundary delegation）」** を追加する。
Voice Agent は A2A の **クライアント**として、許可済みの**リモートエージェント**へ Task を委譲する。

### 1. 会話を塞がない委譲（注入ポリシーは ADR-0037/0046 を継承）

委譲は agent-as-a-tool の新 function tool から**非同期に発火**する。ツールは Task を submit したら即座に
「〜を調べています」と短く返し、音声ターンをブロックしない。リモートの結果は Task の streaming/push で
戻り、`ContextIndexer`（`packages/sanba_shared/src/sanba_shared/grounding.py`）で grounding に index された後、
**会話に割り込まず** 検知カード／次の問いとして反映される（ADR-0037 決定1 の「会話への非同期割り込みをしない」を継承）。

```
delegate_to_agent(remote, instruction)  # allowlist されたリモートのみ
  └─ A2A: message/send → Task(submitted)   [即座に発話「調べています」]
        … working …                         [web に live 進捗]
        └─ input-required → Voice Agent が会話でユーザに聞き返す（産婆術）
        └─ completed(artifact) → grounding へ index → 次の問い/検知カード
```

### 2. Task ↔ SANBA モデルの対応

| A2A | SANBA |
|---|---|
| Task（`task_id`, state, history, artifacts） | Firestore `sessions/{id}/delegations/{task_id}`（新規サブコレクション、TTL は既存 `data_retention_days` に従う） |
| state 遷移 | `delegation.status` を更新し `EventPublisher` で web に live 配信 |
| `input-required` | Voice Agent が会話でユーザに追加情報を確認（人間介在） |
| artifact（調査結果ドキュメント/構造化データ） | `ContextIndexer.index_context` で grounding 投入、`Requirement.citations` に根拠として反映 |
| W3C `traceparent` | クライアント→リモートへ伝播し、Cloud Trace で分散トレースを 1 本に |

### 3. コンポーネント配置

- **`packages/sanba_shared/a2a/`（新規）**: A2A の型（`AgentCard` / `Task` / `Message` / `Part` / `Artifact` / `TaskState`）と、
  client/server の薄いラッパ、認証・`traceparent` 伝播ヘルパ。agent・api・（リモート）worker で共有（ADR-0014 の共有方針に沿う）。
- **`apps/agent`（クライアント）**: `a2a_client.py` と function tool `delegate_to_agent`。委譲状態を Firestore に永続化し、
  streaming 更新を `EventPublisher` で live 配信。呼べるのは **Agent Card レジストリの allowlist に登録されたリモートのみ**。
- **リモートエージェントの受け口**:
  - **社内**: ADR-0040 と同じ「Cloud Run + IAM OIDC invoker 限定」で A2A サーバを立てる。初弾は連携リポジトリ調査の
    **`repo-scout`**（複数ステップの探索・ツール使用・自己検証を持つ実体のあるエージェント。CLAUDE.md「薄いエージェント禁止」に沿い、
    単発 Gemini 呼び出しの見せかけにしない）。
  - **将来/社外**: Agent Card discovery で対等発見。当面は allowlist 固定で運用する。
- **`apps/api`**: 委譲の可視化・管理用エンドポイント（`GET /api/sessions/{id}/delegations`）と、
  どのリモートを許可するかの **Agent Card レジストリ**（SSRF・勝手な外部呼び出しの防止）。

## 検討したが採用しなかった選択肢

- **A. リモートを ADK の sub-agent として足す** — 却下。ADR-0002 のトポロジ改変になり、別失敗ドメイン・別所有・
  長時間タスクを内部 sub-agent に押し込むと ADR-0046 の同居リスクを再発させる。ADR-0048 で sub-agent 追加を
  棄却した判断とも一貫させる。
- **B. agent-as-a-tool のまま同期 HTTP 直呼び** — 却下。長時間タスク・`input-required`・streaming・能力発見を
  表現できず、音声ターンをブロックする（ADR-0046 のランドマインの再現）。
- **C. 独自 RPC/スキーマを内製** — 却下。相互運用性がゼロで、将来の社外エージェント連携で作り直しになる。
  A2A は公開標準でエコシステムに乗れる。
- **D. MCP で代替** — MCP は「ツール/リソースを 1 つの LLM に供給する」境界であり、対等なエージェント間の
  長時間協調・Task ライフサイクル・人間介在は A2A の守備範囲。両立可能（リモート内部の実装で MCP を使ってよい）だが、
  **境界プロトコルは A2A** とする。

## 影響

- **観測性（ADR-0051）**: 新スパン `a2a.delegate`（クライアント発火）/ `a2a.task`（状態遷移）を追加。`traceparent` を
  リモートへ伝播して分散トレースを Cloud Trace で 1 本に束ねる。**PII 規約を継承**し、Task の生テキスト（発話・調査指示の本文・
  artifact 本文）はスパン属性に載せない（識別子・状態・件数・リモート名など非 PII のみ）。委譲の成功率／レイテンシ／
  結果採用率を構造化ログ → Cloud Monitoring で可視化する。
- **セキュリティ**: リモート呼び出しは OIDC 認証（`worker_invoker_sa` 相当）。**Agent Card レジストリの allowlist** で
  呼び先を制限し SSRF を防ぐ。外部へ渡す情報は `pii.py` でマスキングし、`search_grounding` と同じ出力制御 allowlist の
  思想を委譲結果の取り込みにも適用する。シークレットは Secret Manager、コンテナは非 root・最小ベース、PR で `/security-review` を回す。
- **IaC**: リモート A2A サーバ用の Cloud Run + IAM（invoker 限定）+ トリガ（Cloud Tasks もしくは内部 HTTPS）を Terraform に追加。
  変更はレビュー必須。
- **テスト**: 単体（A2A 型のシリアライズ、`TaskState` 遷移、allowlist 判定、`traceparent` 伝播）／結合
  （Voice Agent → in-memory A2A サーバ、`input-required` 往復）／E2E（会話中に委譲 → 結果が grounding に入り次の問いに反映）。
  LLM 評価データセット（ADR-0005）に「委譲が要る代表シナリオ」を追加して回帰させる。
- **段階的移行（README ロードマップに整合）**:
  - **Phase A（MVP）**: 社内 `repo-scout` 1 体を A2A サーバ化。`delegate_to_agent` は allowlist 固定・fire-and-forget、
    結果を grounding／検知へ。`input-required` は未対応（`completed` / `failed` のみ）。
  - **Phase B**: `input-required`（人間介在）を会話ループへ接続、streaming(SSE) でライブ進捗を web に、委譲の管理画面を追加。
  - **Phase C**: Agent Card discovery による動的発見・複数リモート・社外エージェント（多対多の Phase3 と整合）。
- **用語**: ADR-0002 の「agent-as-a-tool」「sub-agent 協調」に次ぐ第 3 境界として「A2A 委譲」を
  `docs/reference/ubiquitous-language.md` に追記する（フォローアップ）。

設計判断は人間レビューを前提とし、断定しすぎない。特に Phase A の適用範囲（最初のリモートを `repo-scout` に絞るか、
外部事実調査エージェントも含めるか）と、`input-required` を会話へ戻す UX は要検討。
