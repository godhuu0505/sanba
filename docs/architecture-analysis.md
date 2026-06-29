# SANBA アーキテクチャ & インフラ徹底解析

> 本書はリポジトリ実装（`apps/` / `infra/terraform/` / `docker-compose*.yml` / `.github/workflows/`）を
> 静的に解析し、**どのコンポーネントが・どの Google Cloud / 外部サービスを・どのタイミングでどう使うか**を
> 複数の図で示す。既存の [`docs/architecture.md`](architecture.md) が「設計判断（なぜ）」を記すのに対し、
> 本書は「実態（何が・どこで・いつ）」の写像に徹する。

- 解析対象リビジョン: `apps/agent` / `apps/api` / `apps/web` / `packages/sanba_shared` / `infra/terraform` / 補助スタック
- 凡例:
  - 🟦 Google Cloud マネージドサービス
  - 🟩 外部 SaaS / OSS（非 GCP、またはセルフホスト）
  - ⬜ 自前アプリ（コンテナ）

---

## 0. 30 秒サマリ

- **実行基盤は Cloud Run 3 サービス**（`sanba-web` / `sanba-api` / `sanba-agent`）。GKE は不採用（ADR-0006）。
- **音声は LiveKit Cloud（WebRTC SFU）+ Gemini Live（speech-to-speech）** の二層。低遅延の対話層と、ADK マルチエージェントの分析層を分離。
- **状態は Firestore**（セッション/要件/発話/検知/質問。TTL で自動失効）、**素材は Cloud Storage**、**RAG 根拠付けは Elasticsearch**（BM25 + Gemini embedding の kNN ハイブリッド）。
- **AI は二経路切替**: 本番は **Vertex AI（キーレス・実行 SA の `aiplatform.user`）**、ローカルは **AI Studio（`GOOGLE_API_KEY`）**。
- **公開は Global 外部 Application Load Balancer + Serverless NEG + Google 管理 SSL + Cloud DNS**（`https://youken.sanba.net`）。
- **CI/CD は GitHub Actions + Workload Identity Federation（鍵レス）→ Artifact Registry → `gcloud run deploy`**。env/secret/scale は Terraform 管理。
- **可観測性は OpenTelemetry 一本化**。本番は OTLP→Cloud Trace/Logging/Monitoring、ローカルは Collector→Prometheus/Loki/Tempo/Grafana。**LLMOps は Langfuse**。
- **外部コネクタ（GitHub 起票）は既定 OFF**。デモ経路に影響しない。

---

## 1. システム全体構成（コンポーネント俯瞰）

参加者・運用者から、Cloud Run 上の 3 アプリ、外部リアルタイム/AI/検索サービス、永続化までの一枚絵。

```mermaid
flowchart LR
  subgraph users["👥 参加者 / 運用者"]
    PM["PM / Engineer / 顧客<br/>(ブラウザ・音声)"]
    ADM["🛠️ 管理者"]
  end

  subgraph edge["🟦 エッジ (Google Cloud)"]
    LB["Global External<br/>Application LB<br/>(Anycast IP + Managed SSL)"]
    DNS["🟦 Cloud DNS"]
  end

  subgraph run["🟦 Cloud Run (us-central1)"]
    WEB["⬜ sanba-web<br/>Next.js / App Router<br/>scale-to-zero"]
    API["⬜ sanba-api<br/>FastAPI<br/>scale-to-zero"]
    AGENT["⬜ sanba-agent<br/>LiveKit Agents worker<br/>min=1 常駐"]
  end

  subgraph realtime["🟩 リアルタイム (外部)"]
    LK["LiveKit Cloud<br/>WebRTC SFU"]
  end

  subgraph ai["AI / LLM"]
    VTX["🟦 Vertex AI (本番・キーレス)<br/>🟩 AI Studio Gemini API (ローカル)"]
  end

  subgraph data["🟦 状態 / 検索 / 素材"]
    FS["🟦 Firestore<br/>セッション/要件/発話/検知/質問"]
    GCS["🟦 Cloud Storage<br/>画像/動画アセット"]
    ES["🟩 Elasticsearch<br/>RAG 根拠付け(BM25+kNN)"]
  end

  subgraph ext["🟩 外部連携 (任意/運用)"]
    GIS["Google Identity Services<br/>OIDC ログイン"]
    GH["GitHub Issues<br/>(コネクタ・既定OFF)"]
    LF["Langfuse (LLMOps)"]
  end

  PM -->|HTTPS| LB
  ADM -->|HTTPS /admin| LB
  DNS -.->|A レコード| LB
  LB -->|host: web| WEB
  LB -->|host: api.*| API

  PM -. "GIS で id_token 取得" .-> GIS
  WEB -->|REST + Bearer id_token| API
  PM <-->|WebRTC 音声/映像| LK
  AGENT <-->|worker 接続 S2S| LK
  API -->|参加トークン発行| LK

  AGENT --> VTX
  API --> VTX
  AGENT --> FS
  API --> FS
  API --> GCS
  AGENT --> ES
  API --> ES
  API -. "確定要件起票" .-> GH
  AGENT -. "起票/根拠取得" .-> GH
  AGENT -. "セッション採点" .-> LF
  API -->|id_token 検証| GIS
```

---

## 2. 利用している Google Cloud サービス一覧

`infra/terraform/main.tf` の `google_project_service`（有効化 API）と各リソース定義から抽出した**実利用サービス**。

| # | サービス | API | 役割（このプロジェクトでの使われ方） | 定義箇所 |
|---|---|---|---|---|
| 1 | **Cloud Run** | `run.googleapis.com` | `sanba-web`/`sanba-api`/`sanba-agent` の実行基盤。web/api は `min=0`+`cpu_idle=true`（scale-to-zero）、agent は `min=1`+`cpu_idle=false`（LiveKit 常駐ワーカー） | `cloud_run.tf` |
| 2 | **Firestore (Native)** | `firestore.googleapis.com` | セッション/要件/発話/検知/現在質問の永続化。`utterances`/`requirements`/`questions` に `expireAt` TTL を設定し保持期間後に自動削除 | `main.tf` |
| 3 | **Artifact Registry** | `artifactregistry.googleapis.com` | コンテナイメージ（`api`/`web`/`agent`）格納。cleanup policy で直近 N 個のみ保持しストレージ課金抑制 | `main.tf` |
| 4 | **Secret Manager** | `secretmanager.googleapis.com` | `session-signing-secret`/`livekit-*`/`elasticsearch-api-key`/`google-api-key` を Cloud Run に注入。terraform は「箱と参照」のみ管理し**値は管理外**（`gcloud secrets versions add` で投入） | `secrets.tf` |
| 5 | **Vertex AI** | `aiplatform.googleapis.com` | 本番の Gemini 実行経路（**キーレス**＝実行 SA の `roles/aiplatform.user`）。Live/推論/Vision/Embedding | `main.tf` / `variables.tf` |
| 6 | **Cloud Trace** | `cloudtrace.googleapis.com` | OpenTelemetry のトレース送信先（本番）。SA に `roles/cloudtrace.agent` | `main.tf` |
| 7 | **Cloud Monitoring** | `monitoring.googleapis.com` | メトリクス。SA に `roles/monitoring.metricWriter` | `main.tf` |
| 8 | **Cloud Logging** | `logging.googleapis.com` | 構造化ログ（structlog）+ LB アクセスログ。SA に `roles/logging.logWriter` | `main.tf` / `domain.tf` |
| 9 | **Cloud Storage** | `storage.googleapis.com` | (a) マルチモーダル素材バケット（`GCS_BUCKET`、`sessions/{id}/assets/...`）、(b) Terraform リモート state（GCS backend） | `storage.py` / `main.tf` |
| 10 | **Cloud Load Balancing (Compute)** | `compute.googleapis.com` | Global 外部 Application LB（`EXTERNAL_MANAGED`）+ Serverless NEG + Global Anycast IP + URL map + Google 管理 SSL 証明書。`domain != ""` のときだけ作成 | `domain.tf` |
| 11 | **Cloud DNS** | `dns.googleapis.com` | マネージドゾーン + A レコード（LB IP）。`manage_dns=true` のとき。DNSSEC 対応 | `domain.tf` |
| 12 | **Cloud Billing Budgets** | `billingbudgets.googleapis.com` | 月次予算アラート（50/90/100%）。コストガードレール | `main.tf` |
| 13 | **IAM / Resource Manager** | `iam`/`cloudresourcemanager.googleapis.com` | 最小権限の実行 SA `sanba-runtime` と project IAM バインディング | `main.tf` |
| 14 | **IAM Credentials / STS** | `iamcredentials`/`sts.googleapis.com` | **Workload Identity Federation**（GitHub Actions の鍵レス認証） | `main.tf` / `deploy.yml` |

> 補足: README の技術スタック表は CI/CD に「Cloud Build」も挙げるが、**実際の `deploy.yml` は docker buildx + GHA キャッシュでビルドし `gcloud run deploy` する**（Cloud Build は使っていない）。AI は **Vertex AI（本番）/ AI Studio Gemini API（ローカル）** の二経路。

### GCP サービスの利用マップ（誰が叩くか）

```mermaid
flowchart TB
  subgraph apps["⬜ アプリ (Cloud Run)"]
    WEB["sanba-web"]
    API["sanba-api"]
    AGENT["sanba-agent"]
  end

  WEB --> RUN["🟦 Cloud Run"]
  API --> RUN
  AGENT --> RUN

  API --> FS["🟦 Firestore"]
  AGENT --> FS
  API --> GCS["🟦 Cloud Storage"]
  API --> VTX["🟦 Vertex AI"]
  AGENT --> VTX
  API --> SM["🟦 Secret Manager"]
  AGENT --> SM

  API --> OTEL["🟦 Cloud Trace/Logging/Monitoring"]
  AGENT --> OTEL

  subgraph platform["🟦 配信 / 基盤 (Terraform)"]
    LB["Cloud Load Balancing"]
    DNS["Cloud DNS"]
    AR["Artifact Registry"]
    BUD["Billing Budgets"]
    IAM["IAM / WIF (STS)"]
  end
  LB --> RUN
  DNS --> LB
  AR --> RUN
```

---

## 3. 音声対話の二層構造（リクエストフロー / sequence）

「低遅延の対話層（Gemini Live）」と「多段推論の分析層（ADK）」を分けるのが SANBA の核（ADR-0002 / 0006）。

```mermaid
sequenceDiagram
    autonumber
    participant U as 参加者(ブラウザ)
    participant GIS as 🟩 Google Identity
    participant API as ⬜ sanba-api (FastAPI)
    participant LK as 🟩 LiveKit Cloud (SFU)
    participant VA as ⬜ sanba-agent (Gemini Live)
    participant VTX as AI (Vertex / AI Studio)
    participant ADK as ADK Agent Team
    participant FS as 🟦 Firestore

    U->>GIS: Google ログイン
    GIS-->>U: id_token (OIDC)
    U->>API: POST /api/sessions/join (Bearer id_token + invite)
    API->>GIS: id_token 検証 (aud/iss/exp)
    API->>LK: AccessToken 発行 (room scoped, TTL)
    API-->>U: LiveKit token + session_token

    U->>LK: WebRTC 参加 (音声/映像)
    VA->>LK: worker 接続 (同一 room)
    loop 会話ターン
        U->>LK: 発話 (audio)
        LK->>VA: audio track
        VA->>VTX: Gemini Live S2S (即応)
        VTX-->>VA: 応答 audio + function 呼び出し
        VA-->>LK: 応答 (低遅延 audio)
        LK-->>U: 音声
        Note over VA,ADK: 区切りで function tool 起動
        VA->>ADK: analyze_requirements(transcript)
        ADK->>VTX: 推論 (gemini-2.5-flash)
        ADK-->>VA: 次の問い / 抜け / 矛盾
        VA->>FS: 確定要件・発話・検知を upsert
        VA-->>LK: data channel で web へ差分 publish
    end
    Note over VA,FS: room close 時に LLM-as-a-judge で採点 → Langfuse
```

**ポイント**: API は「トークン発行と認可の門番」。実際の音声ストリームは**ブラウザ ↔ LiveKit ↔ agent** で直接流れ、API は経由しない（低遅延の要）。

---

## 4. ADK マルチエージェント・トポロジ

`apps/agent/src/sanba_agent/tools/analysis.py` → `agent_team.py`。Voice Agent から `agent-as-a-tool` で呼ばれ、内部は `sub_agent` 協調。

```mermaid
flowchart TD
    VA["⬜ Voice Agent (Gemini Live)<br/>function tool: analyze_requirements"]
    VA -->|agent-as-a-tool| ROOT["Interview Lead Agent<br/>質問計画・統合"]
    ROOT -->|sub_agent| NFR["非機能要件 Agent<br/>性能/可用性/ｾｷｭﾘﾃｨ/ｺｽﾄ"]
    ROOT -->|sub_agent| SCOPE["スコープ&優先度 Agent<br/>MoSCoW"]
    ROOT -->|sub_agent| CONTRA["矛盾&抜け検知 Agent"]
    ROOT -->|search_grounding| ES["🟩 Elasticsearch<br/>RAG + 過去ｾｯｼｮﾝ"]
    ROOT -->|tool| WRITER["要件ライター<br/>Firestore / GitHub Issue"]

    subgraph fallback["ADK 不在時のフォールバック (creds 無し / テスト)"]
        H1["heuristic_open_topics<br/>(NFR 抜けの定型検知)"]
        H2["heuristic_ambiguous_topics<br/>(曖昧表現の検知)"]
    end
    VA -.-> fallback
```

> 実装の堅牢性: `analyze_transcript()` は ADK ランタイム/creds が無ければ**ヒューリスティック結果に必ずフォールバック**し、ローカル・CI が鍵なしで動く。

---

## 5. リアルタイム配信とハイドレーション（WebRTC data channel + REST スナップショット）

会話の差分は **LiveKit data channel**（低遅延 push）で web に流し、リロード/途中参加は **REST GET でスナップショット復元**する二重化（ADR-0021）。

```mermaid
sequenceDiagram
    autonumber
    participant U as 参加者(web)
    participant LK as 🟩 LiveKit data channel
    participant VA as ⬜ agent (EventPublisher)
    participant API as ⬜ api (ReadRepository)
    participant FS as 🟦 Firestore

    Note over VA: 会話中のライブ差分 (単調増加 seq)
    VA->>FS: 要件/検知/現在質問を保存 (+ last_seq)
    VA->>LK: requirement.upserted / detection.gap / question.asked
    LK-->>U: live イベント (seq つき)

    Note over U,API: リロード / 途中参加 (欠番検知)
    U->>API: GET /requirements,/detections,/questions/current (Bearer session_token)
    API->>FS: 読み取り
    API-->>U: スナップショット + seq
    U->>U: live 差分と (type,id) 冪等 upsert で合流

    Note over U,VA: web → agent の操作
    U->>LK: user.selection / user.text / user.answered
    LK->>VA: data_received
    VA->>FS: 検知解消 / 回答記録 (CAS で current 質問クリア)
```

API 側にも `apps/api/src/sanba_api/realtime.py` の `AnalysisPublisher` があり、**素材アップロードの解析進捗を LiveKit に publish**する（次節）。

---

## 6. マルチモーダル素材アップロード（画像/動画解析フロー）

`POST /api/sessions/{id}/context/file`（`apps/api/.../main.py` + `vision.py` + `storage.py`）。**3 つの外部サービスがこの 1 リクエスト内で順に使われる**。

```mermaid
sequenceDiagram
    autonumber
    participant U as 参加者(web)
    participant API as ⬜ sanba-api
    participant GCS as 🟦 Cloud Storage
    participant LK as 🟩 LiveKit (進捗 publish)
    participant GEM as AI (Gemini Vision)
    participant ES as 🟩 Elasticsearch (grounding)
    participant FS as 🟦 Firestore

    U->>API: 画像/動画 multipart (Bearer session_token)
    API->>API: 種別判定 / サイズ・MIME ガード (415/413)
    API->>GCS: store() → gs://bucket/sessions/{id}/assets/{hash}
    API->>LK: analysis.progress(received)
    alt 画像 (同期解析)
        API->>LK: analysis.progress(analyzing)
        API->>GEM: analyze_image() 観察抽出 (最大8件)
        API->>ES: 観察を grounding 索引へ (PII マスク後)
        API->>FS: material(status=done) 保存
        API->>LK: analysis.visual(抽出結果)
    else 動画 (未実装)
        API->>FS: material(status=analyzing) 保存
        API-->>U: analysis_pending=true (web は「準備中」)
    end
    API-->>U: ContextResponse(asset_id, kind)
```

> 削除 `DELETE .../context/file/{asset_id}` は **GCS バイナリ + Firestore メタ + ES 索引チャンク**を一括取り消し（#245 真の破棄）。GCS/ES 未接続時は in-memory フォールバックで安全動作。

---

## 7. 外部サービス連携マップ（**いつ・どこで・どう使うか**）

ユーザの問い「外部サービスはどのタイミングでどのような配置でどう使っているか」への中核回答。

### 7-1. タイミング × 配置 × 用途の一覧

| 外部サービス | 種別 | 呼ぶ主体（配置） | 呼ぶタイミング | 認証 / 経路 | 未設定時の挙動 |
|---|---|---|---|---|---|
| **LiveKit Cloud** | 🟩 WebRTC SFU | ブラウザ ↔ SFU ↔ agent worker。api はトークン発行のみ | join 時（token）/会話中（音声・映像・data channel 常時） | api key/secret（Secret Manager）。token は room scoped・TTL 付き | ローカルは `livekit-server --dev`（devkey）にフォールバック |
| **Gemini Live** | AI(S2S) | agent worker | 会話の全音声ターン（常時・低遅延） | Vertex(キーレス) / AI Studio(`GOOGLE_API_KEY`) | 鍵なしでは会話不可（要設定） |
| **Gemini 推論** | AI | agent（ADK内）/ evaluation | 区切りでの `analyze_requirements`、セッション採点 | 同上 | ADK/採点ともヒューリスティックにフォールバック |
| **Gemini Vision** | AI | api | 画像アップロード時（同期） | 同上 | 観察抽出は空配列（落とさない） |
| **Gemini Embedding** | AI | agent/api（retrieval） | grounding への index/search 時 | 同上 | embedding=None → BM25/語重なりのみ |
| **Elasticsearch** | 🟩 検索 | agent / api | 発話・要件・観察の index、`search_grounding` | URL + API key | in-memory 語重なりフォールバック |
| **Firestore** | 🟦 状態 | agent / api | セッション/要件/発話/検知/質問の読み書き（常時） | ADC / 実行 SA `datastore.user` | エミュレータ or in-memory |
| **Cloud Storage** | 🟦 素材 | api | 画像/動画アップロード・削除時 | ADC / 実行 SA | in-memory dict フォールバック |
| **Google Identity** | 🟩 認証 | api（検証）/ web（取得） | セッション作成・join・/admin・/mine の各 API 入口 | OIDC id_token をサーバ検証 | `AUTH_DEV_BYPASS=true` で固定 dev identity |
| **GitHub Issues** | 🟩 連携 | api(`/export`) / agent(grounding) | 確定要件の起票、README/Issue の根拠取り込み | PAT（`GITHUB_TOKEN`） | **既定 OFF**（デモ経路に無影響） |
| **Langfuse** | 🟩 LLMOps | agent(evaluation) | room close 時のスコア記録 / プロンプト管理 | host + public/secret key | `get_langfuse()=None` でスキップ |
| **OTel Collector → Cloud Ops** | 🟦/🟩 可観測 | agent / api | 全処理の span/metric/log（常時、設定時） | OTLP endpoint | endpoint 空なら送信スキップ |

### 7-2. 「会話 1 セッション」の時系列での外部サービス発火

```mermaid
sequenceDiagram
    autonumber
    participant Setup as ① 入室前
    participant Conv as ② 会話中
    participant Asset as ③ 素材投入
    participant Fin as ④ 締め

    Note over Setup: Google Identity(id_token検証) → LiveKit(token発行) → Firestore(session作成)
    Note over Conv: LiveKit(音声/映像/data) ⇄ Gemini Live(S2S) ⇄ ADK+Gemini推論<br/>Firestore(要件/発話/検知 upsert) / Elasticsearch(grounding) / Gemini Embedding
    Note over Asset: Cloud Storage(保存) → Gemini Vision(解析) → Elasticsearch(索引) → LiveKit(進捗)
    Note over Fin: GitHub Issues(起票・任意) / Langfuse(採点記録) / OTel(全 span 送信)
```

**読み筋**: 外部サービスは「入口で認証（Google）」「会話中は常時リアルタイム（LiveKit + Gemini Live + Firestore + ES）」「素材投入時に同期解析（GCS + Vision + ES）」「締めで非同期連携（GitHub + Langfuse）」という**4 つのタイミング帯**に明確に分かれる。すべての外部依存は**未設定時フォールバックを持ち**、最小構成（`just up`）が鍵なしで起動する設計。

---

## 8. ネットワーク / 公開構成（Load Balancer ルーティング）

`infra/terraform/domain.tf`。`domain != ""` のときだけ LB 一式を作る。host ベースで web/api/redirect を 1 証明書・1 Anycast IP に集約。

```mermaid
flowchart TB
  USER["ブラウザ"]
  USER -->|"HTTP :80"| HTTP["🟦 HTTP forwarding rule"]
  HTTP -->|"301 → HTTPS"| HTTPS
  USER -->|"HTTPS :443"| HTTPS["🟦 HTTPS proxy + Managed SSL 証明書"]

  HTTPS --> URLMAP{"🟦 URL map<br/>host ルーティング"}
  URLMAP -->|"youken.sanba.net"| WNEG["🟦 web Serverless NEG"]
  URLMAP -->|"api.youken.sanba.net"| ANEG["🟦 api Serverless NEG"]
  URLMAP -->|"sanba.net / www"| REDIR["301 → youken.sanba.net"]

  WNEG --> WEBBE["web backend service<br/>(LB ログ有効)"]
  ANEG --> APIBE["api backend service<br/>(LB ログ有効)"]
  WEBBE --> WEB["⬜ Cloud Run sanba-web"]
  APIBE --> API["⬜ Cloud Run sanba-api"]

  DNS["🟦 Cloud DNS<br/>A レコード → Anycast IP"] -.-> HTTPS
```

- **agent はプライベート**（`allUsers` invoker を付けない）。public は web/api のみ。
- 証明書は A レコードが LB IP を指してから Google が自動発行。`apex モード`と`subdomain モード`を変数で切替可能。
- `EXTERNAL_MANAGED`（Global 外部 ALB）を選ぶ理由は **Cloud Armor(WAF)/Cloud CDN への拡張余地**（production-ready）。

---

## 9. CI/CD パイプライン（`.github/workflows/`）

```mermaid
flowchart LR
  DEV["push / PR"] --> CI["ci.yml<br/>ruff / mypy / pytest / tsc / build"]
  DEV --> SEC["security.yml<br/>pip-audit / npm audit<br/>gitleaks / Trivy"]
  DEV --> CQL["codeql.yml"]
  DEV --> TF["terraform.yml<br/>fmt / validate / plan"]
  DEV --> EVAL["llm-eval.yml<br/>ADK 回帰評価 (Langfuse データセット)"]

  MAIN["main へ merge"] --> DEPLOY["deploy.yml"]
  subgraph deploy["deploy.yml (鍵レス)"]
    CHG["paths-filter<br/>変更 app のみ"] --> WIF["🟦 WIF 認証<br/>(STS / id-token)"]
    WIF --> BUILD["docker buildx + GHA cache"]
    BUILD --> PUSH["🟦 Artifact Registry へ push<br/>tag=GITHUB_SHA"]
    PUSH --> RUN["gcloud run deploy<br/>(image 差し替えのみ)"]
  end
  DEPLOY --> deploy

  FK["four-keys collector<br/>DORA 自己計測"] -.->|GitHub API| MAIN
```

- **認証は Workload Identity Federation（鍵レス）**。SA キー JSON を GitHub Secrets に置かない（`iamcredentials`/`sts`）。
- **env / secret / scale は Terraform が唯一管理**。`deploy.yml` は `--image` 差し替えのみ（既存設定を保持）。
- 変更のあった app だけビルド（`paths-filter`）＝ Actions 分 / AR ストレージ節約。
- サプライチェーン: GitHub 製以外の Action は **commit full SHA でピン**（CLAUDE.md 規約 / `deploy.yml` で実施）。

---

## 10. 可観測性スタック（OpenTelemetry 一本化）

新規処理は必ずトレース/ログ/メトリクスを通す（CLAUDE.md 原則3）。**送信は OTLP に統一**し、出力先だけ環境で替える。

```mermaid
flowchart LR
  subgraph app["⬜ アプリ (agent / api)"]
    OT["OpenTelemetry SDK<br/>+ structlog + metrics"]
  end

  OT -->|OTLP gRPC| ROUTE{"OTEL_EXPORTER_OTLP_ENDPOINT"}

  subgraph local["ローカル (docker-compose.tools.yml)"]
    COL["OTel Collector"] --> PROM["🟩 Prometheus"]
    COL --> LOKI["🟩 Loki"]
    COL --> TEMPO["🟩 Tempo"]
    PROM --> GRAF["🟩 Grafana :3001"]
    LOKI --> GRAF
    TEMPO --> GRAF
  end

  subgraph prod["本番 (Cloud Run)"]
    CT["🟦 Cloud Trace"]
    CL["🟦 Cloud Logging"]
    CM["🟦 Cloud Monitoring"]
  end

  ROUTE -->|"ローカル"| COL
  ROUTE -->|"本番"| CT

  subgraph llmops["LLMOps"]
    LF["🟩 Langfuse :3030<br/>(+ Postgres)"]
  end
  app -. "LLM 採点/プロンプト" .-> LF

  subgraph dora["DORA (まわす)"]
    FK["four-keys collector :9301"] --> GRAF
  end
```

| シグナル | ローカル | 本番 |
|---|---|---|
| トレース | OTel Collector → Tempo → Grafana | Cloud Trace |
| メトリクス | Collector → Prometheus → Grafana | Cloud Monitoring |
| ログ | Collector → Loki → Grafana | Cloud Logging（structlog JSON）+ LB アクセスログ |
| LLM 品質 | Langfuse（self-host v2 + Postgres） | Langfuse |
| DORA | four-keys collector → Grafana | four-keys（GitHub API 読み） |

---

## 11. データモデルと保持（Firestore + TTL）

```mermaid
flowchart TB
  subgraph fs["🟦 Firestore (Native)"]
    S["sessions/{sessionId}<br/>title, status, owner_sub/email, roles,<br/>last_seq, finalized_count, finalized_requirement_ids"]
    U["utterances/{id} ⏳TTL<br/>speaker, text, expireAt"]
    R["requirements/{id} ⏳TTL<br/>statement, category, priority, source, citations, status"]
    D["detections/{id}<br/>kind(gap/ambiguous/contradiction), resolved"]
    Q["questions/current ⏳TTL<br/>prompt, options, asked_seq (CAS tombstone)"]
    M["materials/{assetId}<br/>name, kind, status, extracted"]
    S --> U
    S --> R
    S --> D
    S --> Q
    S --> M
  end
  GCS["🟦 Cloud Storage<br/>sessions/{id}/assets/{hash}"]
  M -. "asset_id で対応" .-> GCS
```

- **TTL**: `utterances`/`requirements`/`questions` は `expireAt`（`DATA_RETENTION_DAYS`、既定30日）で自動失効。PII を含みうる未回答質問が発話 TTL を迂回して残らないよう `questions` にも TTL（ADR-0020）。
- **承認した要件は TTL 解除**して成果物として保全（管理画面 / ADR-0014）。
- **PII マスク**: `MASK_PII_BEFORE_INDEX=true` で grounding/永続化の前にマスク（issue #10）。

---

## 12. セキュリティ / IAM / シークレット

```mermaid
flowchart TB
  subgraph iam["🟦 IAM (最小権限)"]
    RT["SA: sanba-runtime<br/>(Cloud Run 実行)"]
    RT --> R1["datastore.user"]
    RT --> R2["aiplatform.user (Gemini キーレス)"]
    RT --> R3["secretmanager.secretAccessor"]
    RT --> R4["cloudtrace.agent"]
    RT --> R5["logging.logWriter"]
    RT --> R6["monitoring.metricWriter"]
    DEP["SA: deploy (CI)"] -->|WIF| WIFp["🟦 Workload Identity<br/>Pool/Provider (STS)"]
  end

  subgraph sm["🟦 Secret Manager"]
    SS["session-signing-secret<br/>(自動生成・version 管理)"]
    AK["livekit-* / elasticsearch-api-key / google-api-key<br/>(箱のみ・値は gcloud 投入)"]
  end
  RT -->|secretAccessor| sm
  sm --> RUN["⬜ Cloud Run (env value_source)"]

  subgraph auth["認証/認可レイヤ (api)"]
    A1["Google id_token サーバ検証 (aud/iss/exp/email_verified)"]
    A2["invite 署名 + session_token (HMAC)"]
    A3["join レートリミット (middleware, 429)"]
    A4["/admin は ADMIN_EMAILS 許可リスト"]
    A5["CORS は web オリジン限定"]
  end
```

- **キーレス Gemini**: 本番は `use_vertexai=true` ＝ `google-api-key` を Secret に置かず実行 SA の `aiplatform.user` で認証。
- **シークレットの単一置き場**: 値は Secret Manager のみ。terraform state にも GitHub Secrets にも残さない（`session-signing-secret` のみ例外的に自動生成）。
- **public は web/api のみ**、agent は非公開。CI は WIF で鍵レス。コンテナは非 root・最小ベース（CLAUDE.md）。

---

## 13. 環境差分（ローカル compose ↔ 本番 Cloud Run）

同じコンテナが環境変数だけで「フォールバック ↔ マネージド」を切り替える（PoC で止めず production-ready / ADR-0009）。

```mermaid
flowchart LR
  subgraph dev["💻 ローカル (docker-compose)"]
    DW["web :3000"] --> DA["api :8080"]
    DA --> DLK["livekit --dev :7880"]
    DAG["agent worker"] --> DLK
    DA --> DFS["firestore emulator :8200"]
    DAG --> DFS
    DA --> DES["elasticsearch :9200"]
    DAG --> DES
    DA -. "GOOGLE_API_KEY (AI Studio)" .-> GEML["Gemini API"]
    DTOOLS["overlay: otel/prom/loki/tempo/grafana<br/>langfuse/four-keys"]
  end

  subgraph prod["☁️ 本番 (Cloud Run + Terraform)"]
    PW["sanba-web"] --> PLB["Global ALB"]
    PA["sanba-api"]
    PAG["sanba-agent (min=1)"]
    PLK["🟩 LiveKit Cloud (wss)"]
    PFS["🟦 Firestore Native"]
    PGCS["🟦 Cloud Storage"]
    PES["🟩 Managed Elasticsearch"]
    PVTX["🟦 Vertex AI (キーレス)"]
    PA --> PFS
    PAG --> PFS
    PA --> PGCS
    PAG --> PES
    PA --> PVTX
    PAG --> PVTX
    PAG --> PLK
    PA --> PLK
  end
```

| 観点 | ローカル | 本番 |
|---|---|---|
| LiveKit | `livekit-server --dev`（devkey） | LiveKit Cloud（`wss://`、Secret Manager 鍵） |
| AI 経路 | AI Studio（`GOOGLE_API_KEY`） | Vertex AI（キーレス・ADC） |
| 状態 | Firestore エミュレータ / in-memory | Firestore Native + TTL |
| 素材 | in-memory dict | Cloud Storage |
| 検索 | ES コンテナ / 語重なり in-memory | Managed Elasticsearch |
| 認証 | `AUTH_DEV_BYPASS=true`（素通し） | Google id_token サーバ検証 |
| 可観測性 | OTel→Grafana スタック（overlay） | OTel→Cloud Trace/Logging/Monitoring |
| 公開 | localhost | Global ALB + Managed SSL + Cloud DNS |

---

## 付録: 主要ファイル索引

| 関心事 | ファイル |
|---|---|
| 音声 worker / function tools | `apps/agent/src/sanba_agent/main.py` |
| ADK チーム呼び出し / ヒューリスティック | `apps/agent/src/sanba_agent/tools/analysis.py`, `agent_team.py` |
| RAG grounding（ES + embedding） | `apps/agent/src/sanba_agent/retrieval.py` |
| LLM 採点（Langfuse） | `apps/agent/src/sanba_agent/evaluation.py` |
| API 全エンドポイント | `apps/api/src/sanba_api/main.py` |
| 画像解析（Gemini Vision） | `apps/api/src/sanba_api/vision.py` |
| 素材保存（Cloud Storage） | `apps/api/src/sanba_api/storage.py` |
| Google ログイン検証 | `apps/api/src/sanba_api/auth_google.py` |
| リアルタイム publish | `apps/api/src/sanba_api/realtime.py` |
| Cloud Run / Firestore / SA / 予算 | `infra/terraform/main.tf` |
| Cloud Run サービス定義 | `infra/terraform/cloud_run.tf` |
| Secret Manager | `infra/terraform/secrets.tf` |
| LB / NEG / SSL / DNS | `infra/terraform/domain.tf` |
| デプロイ（WIF→AR→Cloud Run） | `.github/workflows/deploy.yml` |
| 可観測性設定 | `infra/observability/` |
| ローカル最小/全部入り | `docker-compose.yml` / `docker-compose.tools.yml` |
</content>
