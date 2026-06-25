# ユビキタス言語 — SANBA

> プロダクト・設計・コード・UI で**同じ言葉を同じ意味で使う**ための用語集（DDD のユビキタス言語）。
> ここに無い概念を新しく実装するときは、まずこの表に語を足してから書く。語が割れていたら**この表を正**とし、
> コード/ドキュメント/Figma を寄せる。

## 0. 表記の方針（最重要）

1. **正本は機能名**。会話 UI・データ契約・コードの識別子は **機能名（functional name）**で書く
   （例: 矛盾検知 = `contradiction_detector`）。
2. **擬人化・古語・色はデモ演出**。Figma 正本に出てくる「産婆」「緋／黄土」「規矩」「奉る」「オーレ！」等は
   アートディレクション「産婆術アトリエ（Gilded Maieutics）」の**演出**であり、要件・契約・コピーの語ではない。
   対応は [§13 デモ演出語 ↔ 機能名](#13-デモ演出語--機能名-対応表) を参照。
3. **色は意味の写像**。緋＝矛盾／黄土＝抜け などの色は web 側デザイントークンへの**マッピング**であり、
   データ契約のペイロードには載せない（[realtime-contract.md §3](design/realtime-contract.md) の注記）。色のみに依存せずラベル＋アイコンを併記する。
4. **出典を持つ**。各語に「コード識別子」と「出典」を併記する。出典は ADR / Figma 正本ノード / 実装ファイル。

正本（UI/UX）: Figma「📱 iPhone 13 Pro 操作フロー・正本」（fileKey `eI6QvvCEO021zpdMmxr8Iq` / node `31:2`、全12フレーム）。
正本（ドメインモデル）: [`packages/sanba_shared/src/sanba_shared/models.py`](../packages/sanba_shared/src/sanba_shared/models.py)。
正本（リアルタイム契約）: [`docs/design/realtime-contract.md`](design/realtime-contract.md)。

---

## 1. プロダクト・体験の中核語

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| SANBA | `sanba` | 音声（speech-to-speech）で対話し、要件を解像度高く生み出すマルチエージェント。 | [README](../README.md) |
| 産婆術 | Socratic maieutics | 相手の中にある答えを問いで引き出す技法。プロダクト名と所作の由来。 | [README](../README.md) |
| 壁打ち | sparring | PdM が会議に持ち込む*前*に SANBA と 1:1 で要件を詰める利用文脈。MVP の中心ユースケース。 | [ADR-0008](adr/0008-product-concept.md) |
| 核の一撃 | core value | **リアルタイム矛盾・抜け検知**。grill-me／産婆術の本質で、エージェントの必然性の根拠。 | [ADR-0008](adr/0008-product-concept.md) #2 |
| 解像度を上げる | raise resolution | 所作（聞く・話す・描く・見る）を重ねて要件を曖昧から明確へ近づけること。 | [README](../README.md) |
| 一問一答 | one-question-at-a-time | 一度に問うのは1つだけ・推奨回答例を必ず添える、という grill-me 流の対話原則。 | [prompts/interview.py](../apps/agent/src/sanba_agent/prompts/interview.py) |
| 二層構造 | two-layer architecture | 低レイテンシ音声（Gemini Live）と多段推論（ADK）を層として分ける設計。 | [architecture.md §3](architecture.md) / [ADR-0002](adr/0002-multi-agent-topology.md) |

---

## 2. セッションと参加者（Session / Participant）

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| セッション | session / `SessionMeta` / `sessions/{id}` | 1回の要件インタビューの単位。状態・発話・要件・成果物を束ねる。 | [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| セッション準備 | session prepare | ゴール・役割・参考資料・同意を整える入口画面（Figma 02–04）。 | [screens/02-prepare.md](design/screens/02-prepare.md) |
| ゴール | goal / title | そのセッションで固めたいテーマ（例「検索機能のリニューアル要件を固めたい」）。`SessionMeta.title`。 | Figma `40:131` / [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| 参加者 | participant | ルームに参加する人。MVP は PdM 1 名 ＋ 音声エージェント。 | [architecture.md §5](architecture.md) |
| 役割 | role / `roles` | 参加者の立場。UI 選択肢は **企画(PdM) / エンジニア / 顧客**。 | Figma `40:35` / [api.ts](../apps/web/lib/api.ts) |
| 所有者 | owner / `owner_sub` / `owner_email` | セッションを作成した認証ユーザー。管理画面が所有者で引く。 | [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| 出所メタ | provenance / source / participant identity | 「誰の発話か」をたどる識別子。発話と確定要件の両方に残す（1:1 でも N:M 設計を示すため）。 | [ADR-0008](adr/0008-product-concept.md) / [architecture.md §5](architecture.md) |
| 招待 | invite | セッション参加のための署名付きトークン入口。`POST /api/sessions/join` で引き換える。 | [api.ts](../apps/web/lib/api.ts) |
| 参加トークン | join token / `session_token` | join 済みを証明するトークン。ハイドレーション/起票 API の Bearer に使う（Google idToken とは別物）。 | [realtime-contract.md §4](design/realtime-contract.md) / [api.ts](../apps/web/lib/api.ts) |
| 同意 | consent / `consent_acknowledged` | 録音と AI 処理への同意（30日保持・PII マスク）。準備画面のゲート。 | Figma `40:146` / [api.ts](../apps/web/lib/api.ts) |

---

## 3. 発話・会話（Utterance / Transcript）

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| 発話 | utterance / `Utterance` | 参加者の一発言。`speaker` / `text` / `ts` を持つ。 | [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| 発話 ID | `utterance_id` | 発話の識別子（例 `"u3"`）。要件の `citations` と検知の `refs` が**同じ ID 空間**で参照する。リアルタイム契約上の一時 ID であり `Utterance` モデルには永続化しない。 | [realtime-contract.md §3](design/realtime-contract.md) |
| 書き起こし（暫定） | `transcript.partial` | 確定前の認識中テキスト。高頻度・使い捨てで lossy 配信可。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 書き起こし（確定） | `transcript.final` | 確定した発話テキスト。確定 `utterance_id` を払い出す（reliable 配信）。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 話者 | `speaker` | 発話の主の識別名。出所メタの一部。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 問答 | （UI 見出し）会話 | 会話画面のヘッダ。古語演出ではなく「会話／インタビュー」の機能名で扱う。 | Figma `40:162` |
| 認識中 | recognizing | ユーザー発話を音声認識している状態。`SessionPhase` の一つ。 | [types.ts](../apps/web/lib/realtime/types.ts) |

---

## 4. エージェント（Agents / ADK チーム）

機能名は ADK の `Agent.name` を正とする（[agent_team.py](../apps/agent/src/sanba_agent/agent_team.py)）。

| 用語 | 識別子（`name`） | 役割 | 出典 |
|---|---|---|---|
| 音声エージェント | Voice Agent | LiveKit ルームに参加し Gemini Live で対話する「会話の主」。マルチモーダル映像も受け取る。 | [architecture.md §2](architecture.md) / [ADR-0004](adr/0004-multimodal-input.md) |
| インタビュー統括 | `interview_lead` | 会話履歴と確定要件から「次に聞くべき1問」を計画・統合する root エージェント。 | [agent_team.py](../apps/agent/src/sanba_agent/agent_team.py) |
| 非機能要件エージェント | `nfr_specialist` | 性能・可用性・セキュリティ・コスト・運用性の**抜け**を指摘する sub-agent。 | [agent_team.py](../apps/agent/src/sanba_agent/agent_team.py) |
| スコープ&優先度エージェント | `scope_specialist` | 要件を MoSCoW で分類し、過大スコープに MVP を提案する sub-agent。 | [agent_team.py](../apps/agent/src/sanba_agent/agent_team.py) |
| 矛盾&抜け検知エージェント | `contradiction_detector` | 過去の発話・確定要件との**矛盾**を検出する sub-agent。 | [agent_team.py](../apps/agent/src/sanba_agent/agent_team.py) |
| 要件ライター | Writer tool | 確定要件を Firestore / GitHub Issue へ書き出す道具（agent ツール）。 | [architecture.md §4](architecture.md) |
| sub-agent | sub-agent | ADK チーム内部の協調的な切替（中井悦司氏）。Lead が専門 agent に委譲する関係。 | [ADR-0002](adr/0002-multi-agent-topology.md) |
| agent-as-a-tool | agent-as-a-tool | 道具としての呼び出し（佐藤一憲氏）。Voice Agent が ADK チームをツールとして起動する関係。 | [ADR-0002](adr/0002-multi-agent-topology.md) |
| 協調トレース | collaboration trace | 検知 → Lead 再計画の連鎖を可視化し、「薄いボットでない」必然性を見せる演出。 | [ADR-0008](adr/0008-product-concept.md) #5 |

> **注**: 検知イベントの `detector`（[§5](#5-検知矛盾抜け)）は、抜けの種類に応じて `scope_specialist` / `nfr_specialist`、
> 矛盾は `contradiction_detector` を送る。エージェント名＝検知器名で揃える。
> **（暫定）** 現行の `analyze_requirements` は抜けの種別に関わらず一律 `nfr_specialist` で送っており、スコープ gap の分類は未実装（[main.py L160–163](../apps/agent/src/sanba_agent/main.py)）。

---

## 5. 検知（矛盾・抜け）

「核」のドメイン。検知＝Detection、種別は矛盾（contradiction）と抜け（gap）の2つ。

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| 検知 | detection / `Detection` | 会話・要件から見つけた問題提起。web 内部で `(type,id)` 冪等・`seq` 順に正規化する。 | [types.ts](../apps/web/lib/realtime/types.ts) |
| 矛盾 | contradiction / `detection.contradiction` | 過去の発言・確定要件と食い違う回答。色＝**緋**。選択肢を添えて人に裁定を返せる。 | [events.py](../apps/agent/src/sanba_agent/events.py) / [screens/04-conversation.md](design/screens/04-conversation.md) |
| 抜け | gap / `detection.gap` | まだ聞けていない／曖昧な必須論点。色＝**黄土**。`category` を持つ。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 検知器 | `detector` | 検知を出したエージェントの機能名。`contradiction_detector` / `scope_specialist` / `nfr_specialist`。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 根拠参照 | `refs` | 検知の根拠となった `utterance_id` の配列。発話までたどれる導線を UI に置く。 | [realtime-contract.md §3](design/realtime-contract.md) |
| 選択肢 | options / `DetectionOption` | 矛盾カードのボタン（`label` / `value`）。タップで `user.selection` を返す。 | [types.ts](../apps/web/lib/realtime/types.ts) |
| 解消 | resolution / `detection.resolved` | 検知が片付いた状態遷移。`user_selected`（ユーザー選択）／`agent_resolved`（自動解消）。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 検知ボトムシート | detection sheet | 検知時だけ peek→展開でせり上がる最小割り込み UI（`hidden→peek→expanded→dismissed/resolved`）。 | [screens/04-conversation.md](design/screens/04-conversation.md) / [DetectionSheet.tsx](../apps/web/components/DetectionSheet.tsx) |
| 検知率 | detection rate | 抜け漏れ／矛盾を捉えた割合。製品価値＝主指標（言葉×言葉に限定、Before/After + Langfuse 回帰）。 | [ADR-0008](adr/0008-product-concept.md) #6 / [ADR-0005](adr/0005-llm-judge-eval-loop.md) |

---

## 6. 要件（Requirement）

正本は `Requirement`（[models.py](../packages/sanba_shared/src/sanba_shared/models.py)）。リアルタイム契約は `requirement.upserted` で運ぶ。

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| 要件 | requirement / `Requirement` | 確定（または候補）の要求事項1件。出所メタ（`id`/`created_at`/`source_speaker`/`confidence`）は人手で書き換えない。 | [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| 要件文 | `statement` | 要件の本文。`make_requirement_id` で本文から決定的 ID を作り冪等 upsert する。 | [tools/analysis.py](../apps/agent/src/sanba_agent/tools/analysis.py) |
| カテゴリ | `category` / `RequirementCategory` | 要件の種別。正準値は [`RequirementCategory`](../packages/sanba_shared/src/sanba_shared/models.py) を参照。 | [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| 優先度 | `priority` / `Priority` / MoSCoW | Must / Should / Could / Won't の優先度分類。 | [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| 確信度 | `confidence` | 0–1 の確からしさ（既定 0.7）。下地（黄土）から塗り起こす度合い。 | [models.py](../packages/sanba_shared/src/sanba_shared/models.py) |
| 引用 | citation / `citations` | 要件の根拠発話。モデルは `utterance_id` の配列、契約は `[{kind, ref}]` に整形して送る。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 要件ボード／要件絵巻 | requirement board / scroll | MoSCoW で構造化した成果物ビュー。Figma 演出名「要件絵巻」＝機能名「要件ボード」。 | [screens/06-requirements-scroll.md](design/screens/06-requirements-scroll.md) / [RequirementScroll.tsx](../apps/web/components/RequirementScroll.tsx) |

> ⚠️ **状態語の二系統に注意**（要対応の不一致）:
> - **リアルタイム契約 / web 型**: `status` = `draft` | `confirmed`（会話中の確定状態）。
> - **ドメインモデル / 管理画面（ADR-0014）**: `RequirementStatus` = `draft` | `approved` | `rejected`（人手レビュー状態）。
>
> `events.py` の `requirement_upserted` は既定で `confirmed` を送るが、永続モデルに `confirmed` は無い。
> 「会話中に確定（confirmed）」と「人がレビューで承認（approved）」は別の軸として扱い、新規実装時はどちらの軸かを明示する。
> 統一が必要なら ADR で決めてからコードを寄せる。

---

## 7. 素材・マルチモーダル（Asset / Multimodal）

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| 素材を渡す | provide material | 画像・動画・画面共有・カメラ撮影で情報を渡す入口（v2 = 05-2 手段選択シート）。 | Figma `148:95` / [screens/05-materials.md](design/screens/05-materials.md) |
| アセット | asset / `asset_id` / `asset_kind` | アップロードされた素材。安定 `asset_id` で解析イベントを行に対応付ける。種別は `image` / `video`。 | [api.ts](../apps/web/lib/api.ts) |
| 資料（コンテキスト） | context / `kind="context"` | インタビュー前に登録する既存資料（PRD 草案・議事録）。同じ ES インデックスに入れ、既出論点は質問せず確認に切り替える。 | [ingestion.py](../apps/api/src/sanba_api/ingestion.py) |
| 解析進捗 | `analysis.progress` | 素材解析の進捗（`pct` と人間可読 `stage`：領域検出／OCR／突合）。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 視覚解析 | `analysis.visual` | 素材から抽出した要素（`extracted`）と矛盾（`conflicts`）。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 言葉 × 画の矛盾 | word-vs-mock contradiction | 「検索したいと言ったが画面に検索バーが無い」型の矛盾。核（検知）に接続するが**主指標には混ぜない**（定性デモ）。 | [ADR-0004](adr/0004-multimodal-input.md) / [ADR-0008](adr/0008-product-concept.md) #7 |
| 完成イメージ生成 | generative preview | 確定要件から画面イメージを生成して問い返す出力（拡張・未採用。採用時は ADR を起こす）。 | [design/README.md §3.6](design/README.md) |

---

## 8. 根拠付け・検索（Grounding / RAG）

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| 根拠付け | grounding / `GroundingStore` | 問いをベストプラクティスやドメイン知識で裏付け、引用元つきで返すこと。 | [retrieval.py](../apps/agent/src/sanba_agent/retrieval.py) / [ADR-0003](adr/0003-elasticsearch-grounding.md) |
| パッセージ | passage / `Passage` | 検索の最小単位。`kind` は `knowledge` / `requirement` / `utterance` / `context`。 | [retrieval.py](../apps/agent/src/sanba_agent/retrieval.py) |
| ハイブリッド検索 | hybrid search | BM25（全文）+ kNN（Gemini embeddings）。ES が無い環境は語重なりの in-memory フォールバック。 | [retrieval.py](../apps/agent/src/sanba_agent/retrieval.py) |
| `search_grounding` | tool | 音声エージェントが問いの根拠・過去の類似議論を引くツール。 | [prompts/interview.py](../apps/agent/src/sanba_agent/prompts/interview.py) |
| 過去セッション呼び戻し | recall | 類似する過去のインタビュー・確定要件を能動的に「以前似た議論がありました」と呼び戻す。 | [architecture.md §4](architecture.md) / [ADR-0003](adr/0003-elasticsearch-grounding.md) |

---

## 9. 成果物・完了（Artifact / Export / Complete）

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| 成果物 | artifact / `artifacts/{sessionId}` | 生成された要件ドキュメント（Cloud Storage 参照）。 | [architecture.md §6](architecture.md) |
| Issue 化 | export / `export_requirements_to_github` | 確定要件を GitHub Issue に書き戻す（`POST /api/sessions/{id}/export`）。Figma 演出「奉る」＝機能名「Issue 化」。 | [realtime-contract.md §4](design/realtime-contract.md) / [api.ts](../apps/web/lib/api.ts) |
| 完了 | `session.completed` | セッション締め。サマリ（`contradictions_resolved` / `gaps_found` / `issues_created`）と `artifacts` を運ぶ。 | [events.py](../apps/agent/src/sanba_agent/events.py) |

---

## 10. リアルタイム伝送（Realtime contract）

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| データチャネル | data channel | LiveKit ルームの音声と同一接続で JSON イベントを publish する経路。 | [realtime-contract.md §1](design/realtime-contract.md) |
| トピック | topic | `sanba.events`（agent→web）と `sanba.events.web`（web→agent）でトラフィックを分ける。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| エンベロープ | envelope | 全イベント共通の枠 `v` / `type` / `seq` / `ts` / `session_id`。 | [realtime-contract.md §2](design/realtime-contract.md) |
| シーケンス | `seq` | セッション内の単調増加連番。整列・重複排除・欠番検知の基準。 | [events.py](../apps/agent/src/sanba_agent/events.py) |
| 冪等適用 | idempotent upsert | 同じ `(type, id)` は upsert、`seq` で順序を担保する web 側の適用規則。 | [realtime-contract.md §2](design/realtime-contract.md) |
| ハイドレーション | hydration | リロード・途中参加時に GET でスナップショットを取得し、データチャネルのライブ差分と合流させる手順。 | [realtime-contract.md §4](design/realtime-contract.md) |
| ユーザー選択 | `user.selection` | web→agent の唯一の書き込み系。検知カードの選択肢タップを `detection_id` / `selected_value` で返す。 | [realtime-contract.md §4.5](design/realtime-contract.md) |
| セッションフェーズ | `SessionPhase` | 会話の状態。`idle` / `listening` / `recognizing` / `deliberating`。 | [types.ts](../apps/web/lib/realtime/types.ts) |
| 検討中の体数 | `agents_active` | `status` イベントが運ぶ「いま検討中のエージェント数」。協調を見せる指標。 | [events.py](../apps/agent/src/sanba_agent/events.py) |

---

## 11. 運用・横断（Ops / Cross-cutting）

| 用語 | 英語 / 識別子 | 定義 | 出典 |
|---|---|---|---|
| 管理画面 | admin | 所有者外の運用者が要件を確認・承認する UI（`/admin`）。認可の源泉は常に API（`ADMIN_EMAILS` 照合）。 | [ADR-0014](adr/0014-admin-and-login-screens.md) / [api.ts](../apps/web/lib/api.ts) |
| アクセスゲート状態 | access gate | ログイン／認可の許可状態（許可・要再認証・アクセス不可）。 | [ADR-0014](adr/0014-admin-and-login-screens.md) / [design/README.md](design/README.md) |
| PII マスク | `mask_pii` | 永続化・索引化の前に個人情報を伏せる処理。`mask_pii_before_index` で制御。 | [pii.py](../packages/sanba_shared/src/sanba_shared/pii.py) / [security.md](security.md) |
| 保持期間 | retention / TTL | 下書き要件は 30 日 TTL、`approved` は TTL 解除で保全（ADR-0014 §10/§11）。 | [ADR-0014](adr/0014-admin-and-login-screens.md) |
| 観測性 | observability | OTel で全処理を計測し、LLM 入出力は Langfuse にトレース（CLAUDE.md 原則3）。 | [architecture.md §1](architecture.md) / [events.py](../apps/agent/src/sanba_agent/events.py) |
| LLM-as-a-judge | LLM-judge | セッションを LLM で採点（オンライン）＋ CI 回帰評価。検知率の回帰に使う。 | [ADR-0005](adr/0005-llm-judge-eval-loop.md) |

---

## 12. デザイン演出語（アートディレクション）

すべて**デモ演出**であり、要件・契約・コードの語ではない。色は意味への写像。

| 演出語 | 意味（色トークン） | 機能名 |
|---|---|---|
| 緋（oxblood） | `#D2564B` | 矛盾（contradiction）|
| 黄土（yellow ochre） | `#E0A93B` / `#F5A524` | 抜け（gap）|
| 橄欖（verdaccio） | `#A9BE6E` / `#1FD5A3` | 発話中・ライブ（listening / live）|
| 金箔（gold leaf） | `#D4AF37` | 確定要件の祝祭・神の光（出所/完成の強調）|

---

## 13. デモ演出語 ↔ 機能名 対応表

Figma 正本・README のアートディレクションに出る古語・擬人化を、要件/契約で使う**機能名**へ翻訳する。
**新規実装・コピーは右列（機能名）で書く。** 既存の `問答` / `要件絵巻` 表示は移行予定（このドキュメント追加時点では残存）。

| デモ演出語（Figma/古語） | 機能名（正） | 出典ノード |
|---|---|---|
| 産婆 / 「産婆、聴いております…」 | インタビュー統括（`interview_lead`）／「◉ 聴いています…」 | Figma `40:169` |
| 問答 | 会話 / インタビュー | Figma `40:162` |
| 集音中 / ● REC | 録音中 | Figma `48:10` / `40:158` |
| 規矩とする / 規矩 | 基準にする | Figma `40:255` |
| 「両説あり。いずれを規矩とすべきか」 | 「2つの説がある。どちらを基準にするか」 | Figma `40:256` |
| 緋 — 矛盾を検知 | 矛盾を検知（`detection.contradiction`） | Figma `40:255` |
| 緋 — 言葉 × 画の矛盾 | 言葉×画の矛盾（`analysis.visual` conflict） | Figma `40:353` |
| 要件絵巻 / 巻 | 要件ボード（MoSCoW 成果物） | Figma `40:370` |
| GitHub Issue を奉る | GitHub Issue 化（export） | Figma `40:408` |
| 要件、産まれました / オーレ！ | セッション完了（`session.completed`） | Figma `40:416`–`40:417` |
| 矛盾を裁定 / 抜けを取り上げ | 矛盾を解消 / 抜けを検知（`contradictions_resolved` / `gaps_found`） | Figma `40:418` |

---

> この用語集は「コードを読まずに同じ言葉で会話できる」状態を目標にする。語の追加・変更は PR で行い、
> 設計の判断を伴う変更（状態語の統一など）は ADR に残してからこの表とコードを揃える。
