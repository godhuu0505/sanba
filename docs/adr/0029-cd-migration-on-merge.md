# ADR-0029: main マージ→本番デプロイ時のマイグレーション実行設計

- ステータス: Proposed
- 日付: 2026-06-29
- 関連: #36（Cloud Run 実デプロイ）/ ADR-0016（CI/CD 戦略・public 化）/ ADR-0006（Cloud Run + LiveKit）/
  ADR-0003（Elasticsearch グラウンディング）/
  **ADR-0026（main マージで terraform 自動 apply — 本 ADR の前提）** /
  `docs/how-to/deploy-gcp.md` / `.github/workflows/deploy.yml`
- 下敷き: CLAUDE.md「本番志向（production-ready）」「観測できないものは運用できない」「設計判断とレビューは人間が行う」
- 調査: 2024–2026 の一次情報（Google Cloud / Elastic / GitHub Actions 公式）を多ソース検証し、初版の前提を見直して改訂（§7 参考文献・§8 検証ノート）。
- 改訂（2026-07-04）: ADR-0026（PR #284）により **Terraform 管理の宣言的設定（Firestore TTL /
  Cloud Run env・secret 等）は main マージ時に `deploy.yml` の `migrate` ジョブ（terraform apply）で
  自動反映される**ようになった。これに伴い本 ADR のスコープは **Elasticsearch 側のマイグレーション
  （versioned index + alias の冪等 ensure と KB 再シード）に限定**され、§5 のパイプライン順序を
  新フロー前提に更新した。

## コンテキスト

要望は2つ:

1. **main にマージされたら本番（Cloud Run）にデプロイされるようにしたい。**
2. **デプロイに合わせてマイグレーションも走るようにしたい。**

### 現状（コード/IaC 上の事実）

1 の **「main マージ→本番デプロイ」は既に実装済み**。`.github/workflows/deploy.yml` が
`on: push: branches:[main]` で、変更のあった app（agent/api/web）だけを Cloud Run にデプロイする
（WIF キーレス認証・Buildx GHA キャッシュ・**イメージ差し替えのみ**で env/secret は Terraform 管理、
ADR-0016）。ただし起動ガード `if: ${{ vars.GCP_PROJECT_ID != '' }}` があり、**GCP 未配線の間は
スキップされ何も起きない**。実 GCP の配線状態は `docs/how-to/deploy-gcp.md` §1–§6 と §1「GCP 状態の
確認手順」で点検する。

2 の **「マイグレーション」に相当する明示的な step は CD に存在しない**。SANBA に SQL DB / Alembic は
無く、永続層は **Firestore（Native mode）+ 外部 Elasticsearch** の2つ。マイグレーション対象を
正確に切り分けると次のとおり（初版はここの前提が粗く、調査と再点検で改訂した）:

#### Elasticsearch（マイグレーション対象の本体）

- インデックスは **単一の `sanba-grounding`**（`apps/agent/.../retrieval.py` と `apps/api/.../ingestion.py`
  が**同名・同マッピングを別ファイルで重複定義**）。マッピングは `text`(全文) + `keyword` +
  `dense_vector(dims=EMBED_DIM=3072, cosine, index=true)`。**全文(BM25)とベクトルのハイブリッド**で
  grounding する（ADR-0003）。埋め込みは `gemini-embedding-001` の **3072 次元**。
- 現状は**アプリ起動/初回書き込み時に遅延 auto-create**（`if indices.exists: return`）。固定名のため
  **マッピング進化（dims 変更・項目追加）が既存インデックスに反映されない**＝実バグ。
- ES に入るデータの種別（`kind`）と寿命:
  | kind | 中身 | 寿命 / ソースオブトゥルース |
  |---|---|---|
  | `knowledge` | 要件定義のベストプラクティス**知識ベース（KB）** | 永続だが**決定的な種データ**。`seed_knowledge_base()` は本番(非memory)では早期 return し「out-of-band で seed（`scripts/seed_kb`）」前提 |
  | `utterance` / `requirement` | セッション中の発話・要件 | **Firestore がソースオブトゥルース**。ES 側は検索用ミラーで短命でよい |
  | `context` | アップロード資料・GitHub 文脈（session_id 単位） | セッション一時 |
- **重要な前提修正**: 30日 TTL（`expireAt`）は **Firestore 専用**で、**ES には ILM/自動失効が無い**
  （`data_retention_days` は Firestore 側。ES は `delete_by_query` の手動パージのみ）。よって
  「揮発データだから捨ててよい」を ES にそのまま当てはめてはいけない。**正しい論拠**は「ES の KB は
  **再シードで復元でき**、session 系は **Firestore がソース**で短命」だから、マッピング変更時に
  **過去文書を救う reindex/backfill は不要**、というもの。
- **隠れた本番バグ（調査で発覚）**: `scripts/seed_kb` は `main.py` のコメントから参照されるが
  **リポジトリに存在しない**（`scripts/` は `verify-local.sh` のみ）。現状、本番(非memory)では KB が
  inline seed されず、**本番 ES の知識ベースが空のまま**になりうる。再シード方式を採るなら**この
  seed スクリプトの実装が必須前提**であり、同時にこの latent バグも解消する。

#### Firestore（IaC で宣言、CD のアプリ migrate には含めない）

- TTL（`google_firestore_field`）は Terraform 宣言済み（`main.tf`）。複合インデックスは現状クエリが
  単純（`.stream()` / 単一 doc `.get()`、`order_by`+`where` 併用なし）で**不要**。必要になったら
  `google_firestore_index` をコードに足し `terraform.yml` の plan/apply で反映する（**インデックス
  ビルドは非同期**で、apply 完了 ≠ クエリ即利用可。`READY` を待つ運用が要る — 参考 [j]）。

### §1 GCP 状態の確認手順（実 GCP は CI/エージェントから見られないため人手で点検）

`PROJECT_ID` を環境に合わせて置換して実行する:

```bash
export PROJECT_ID=sanba-prd REGION=us-central1
gcloud config set project "$PROJECT_ID"
gcloud run services list --region="$REGION"            # sanba-api/web/agent が Ready か（空＝未配線）
gcloud firestore databases list                         # Firestore の有無/モード
gcloud firestore indexes composite list                 # 既存複合インデックス
gcloud artifacts repositories list --location="$REGION" # デプロイ先イメージ repo
gcloud run jobs list --region="$REGION"                 # マイグレーション/seed 実行基盤の有無
# GitHub → Settings → Variables: GCP_PROJECT_ID / WIF_PROVIDER / DEPLOY_SA / TF_STATE_BUCKET
```

`gcloud run services list` が空なら 1（自動デプロイ）はまだ動いていない（コードはあるがガードでスキップ）。

## 決定

調査の結論として、初版の「versioned index + alias + **reindex** を **Cloud Run Job** で毎デプロイ実行」は
**この構成には過剰（over-engineered）**であり、以下の**軽量版**を採用する。

### 1. デプロイ（要望1）は現状維持。配線の有無だけ点検する

`deploy.yml`（main push → 変更 app を Cloud Run へ）を CD の正とする。新規実装はしない。未配線なら
runbook の手順で GitHub Variables（`GCP_PROJECT_ID` ほか）と WIF を入れるだけで有効化される。
**rollback は Cloud Run 組込み**（各デプロイが不変リビジョンを生み、`update-traffic --to-revisions` で
数秒・無償で戻せる [g][h]）。本番に承認ゲートが要るなら **GitHub Environments の required reviewers** を
既存 GHA 内で足すだけでよく、Cloud Deploy への移行は不要（§理由）。

### 2. ES マイグレーション = versioned index + alias + 冪等 ensure（reindex はしない）

- マッピング定義（INDEX 名・`EMBED_DIM`・mappings）を `packages/sanba_shared` に**集約**し、agent/api の
  重複を解消する（single source of truth）。
- インデックスを **versioned 名 `sanba-grounding-vN` + read/write alias `sanba-grounding`** にする。
  アプリは alias 経由で読み書きする。
- **冪等 ensure**: 「現行マッピングに対応する `vN` が無ければ作成し alias を張替、有れば何もしない」。
  `if exists: return`（進化不可）を廃し、**新マッピング = 新 N** で必ず反映される（Elastic 公式の
  「新データだけに新マッピングを効かせたいなら reindex 不要、alias 張替で足りる」[a][b] に合致）。
- **reindex / backfill は実装しない**。session 系（utterance/requirement/context）は Firestore が
  ソースで短命のため作り直しで可。旧 `vN-1` は手動 delete か ILM（任意）で片付ける。
  マッピング変更は稀イベント（dims 変更等）であり、その瞬間に session 検索が一時的に新インデックスから
  始まることは許容する。

### 3. KB 再シードを実体化する（`scripts/seed_kb`）＝マイグレーションの中核

- `scripts/seed_kb`（または `python -m sanba_agent.seed_kb`）を実装し、KB（`kind="knowledge"`）を
  **現行 alias 先のインデックスへ冪等に投入**する（document id を内容ハッシュ等で固定し、再実行で
  重複しないこと）。これが「新 `vN` を作った後に KB を満たす」一連の最後のピースであり、同時に
  **「本番 KB が空」latent バグ**を解消する。
- 起動時 ensure に KB シードを混ぜない（毎起動の重複・cold-start 増を避ける）。**KB 再シードは
  「一回限り」実行**にする。

### 4. 実行手段は「薄く・観測可能に」。KB 再シードのみ独立実行

- **index ensure**（数百ms・冪等）はアプリ側（alias 経由の起動時 ensure）で足り、専用 Job は不要。
- **KB 再シード**だけは一回限り実行が要るため、これを CD に組み込む。手段は次の優先順:
  1. **Cloud Run Job `sanba-seed-kb`**（agent/api イメージ再利用・runtime SA・ES secret 共有）。
     観測性（実行履歴/ログ）と手動再実行性が得られ、Google 公式の「移行/バッチは Job」指針に合致 [c][d]。
  2. （簡素にするなら）deploy.yml のインライン step。Job ほどの観測性は無い。
- **mechanism の要注意点（調査で確定）**: `google-github-actions/deploy-cloudrun` は **Job の定義を
  deploy/更新するが execute はしない**。実行は **別途 `gcloud run jobs execute <job> --wait`** が必要で、
  `--wait` の終了コードでジョブ失敗を pipeline 失敗に伝播させる [deploy-cloudrun README 反証検証]。
- 認証は既存どおり **WIF（キーレス）**。deploy 用 SA に **`run.jobs` 実行権限**（最小ロール）を追加する。

### 5. パイプライン順序（expand-contract）

```
migrate（terraform apply — infra 変更があるマージのみ・ADR-0026 で自動化済み）
  → build/push（変更 app の image）
  → ensure index vN + alias 張替（アプリ起動時 ensure で自動、または seed ジョブ冒頭で実施）
  → KB 再シード（sanba-seed-kb を execute --wait、失敗で停止）
  → 各 service の revision デプロイ（既存 deploy.yml）
```

- 先頭の migrate（Terraform 宣言の反映）は ADR-0026 で実装済み。本 ADR が足すのは
  ES ensure / KB 再シードの 2 段で、`deploy.yml` の `migrate` 成功（または skip）後・
  service 切替前に挟む。
- 後方互換（additive）の index/alias を先に用意してからサービスを切り替えるため無停止。
- KB 再シードは**マッピングに変更があった時だけ**実行に絞ってよい（毎デプロイ実行は任意・冪等なので
  害は無いがパイプラインを重くする。コスト最適化として paths/diff で絞るのは将来検討）。

### 6. Firestore は Terraform 宣言のまま（層を分離）

- TTL（`google_firestore_field`）は既存どおり。複合インデックスが要れば `google_firestore_index` を
  足せば **main マージで自動 apply される（ADR-0026）**。**非同期ビルドの `READY` 待ち**を
  runbook に明記する [j]。
- アプリのデータ系（ES）は §2–§5、インフラ宣言（Firestore index/TTL）は Terraform、と層を分け混在させない。

## 理由 / 検討した代替案

- **reindex を作らない（採用）**: ES の保全要件が無い（KB=再シード可・session=Firestore ソース）。
  Elastic 公式も「新データのみに新マッピングを効かせるなら reindex 不要・alias 張替で足りる」と明記 [a][b]。
  初版の reindex/expand-contract 機構は SANBA の実データに対して過剰だった。
- **ES を Firestore Vector / Vertex / pgvector に置換しない（採用＝維持）**:
  - grounding は**ハイブリッド(BM25+ベクトル)**が要件（ADR-0003）。Firestore Native に**ネイティブ全文は
    無く**、2026 Next の全文検索は **Enterprise edition + Preview** で「無料〜低コスト」「GA=本番」の両制約に
    反する。
  - **`dense_vector` 3072 次元 > Firestore Vector の上限 2048 次元**。置換すると埋め込みの切り詰め＋
    再正規化が必須で検索品質を落とす（コードも「truncation requires manual L2 normalize」と明記）。
  - Vertex AI Vector Search / Cloud SQL pgvector は**常駐課金**寄りで scale-to-zero / 低コスト方針に反する。
  - → 置換は **No**。ただし将来「grounding はベクトル類似のみで足り、全文/引用元厳密性は不要」と人間が
    判断するなら、Firestore Vector 化で migrate 概念ごと消せる（その時は本 ADR を改訂）。
- **Cloud Run Job（KB 再シードに限り採用）**: 「実行して終了するタスク（移行/バッチ）」は Job の適所 [c][d]。
  index ensure までは軽量すぎて Job は過剰だが、**一回限りの KB 再シード**は観測性・再実行性の便益が立つ。
- **Cloud Deploy へ移行しない（不採用）**: 「Google は CI=GitHub Actions / CD=Cloud Deploy の分業を推奨」
  という主張は**多ソース検証で反証**された（公式の必須推奨ではない）。Cloud Deploy の便益（promotion /
  canary / 承認ゲート）は多環境 promotion を運用する組織で効く。SANBA は単一本番・OSS/ハッカソン由来で、
  月額（pipeline $0.20/日 + target $0.02/日 [i]）と運用学習の ROI が立たない。rollback は Cloud Run 組込みで
  既に満たせる [g][h]。承認は GitHub Environments で足りる。
- **起動時 ensure だけで Job も省く（部分採用）**: index ensure は起動時で十分。だが KB 再シードを
  起動時に混ぜると重複/cold-start 増のリスクがあるため、そこだけ独立実行にする。

## 影響 / フォローアップ

- **観測性**: `sanba-seed-kb` の実行は Cloud Run Jobs の履歴/ログに残り、失敗は deploy pipeline を赤にする。
  Four Keys（変更失敗率/MTTR）とも整合。
- **権限/IAM**: deploy 用 SA に Cloud Run Jobs 実行権限を追加（runbook §3 のロール一覧に追記）。runtime SA は
  既存（`datastore.user` / `secretmanager.secretAccessor`）を流用（ES は外部・secret 経由）。
- **セキュリティ**: ES マッピング/KB に PII は乗らない（`mask_pii_before_index`・ADR-0003/#10）。migrate/seed は
  構造と決定的種データのみ扱う。`/security-review` 対象は IAM 追加と seed 経路に限定。
- **実装範囲（本 ADR 受理後）**:
  1. マッピング定義（INDEX 名 `sanba-grounding` / `EMBED_DIM=3072` / mappings）を `sanba_shared` へ集約し、
     retrieval.py / ingestion.py を参照差し替え。
  2. インデックスを **versioned + alias** 化し、`if exists: return` を冪等 ensure に置換。**reindex は作らない**。
  3. **`scripts/seed_kb`（KB 冪等再シード）を実装**（本番 KB 空バグの解消を兼ねる）。
  4. Terraform `google_cloud_run_v2_job.seed_kb` + deploy 用 SA への jobs 実行権限。
  5. `deploy.yml` に「seed ジョブ deploy → `gcloud run jobs execute --wait`（失敗で停止）」を追加。
  6. （任意）`terraform.yml`/runbook に Firestore 複合インデックスの `READY` 待ちと、GitHub Environments による
     本番承認ゲートを明記。
- 本 ADR は提案中。実 GCP 状態（§1）の点検結果と、唯一の人間判断ポイント（**grounding に全文(BM25)/引用元
  厳密性が要るか** = ES 維持か Firestore Vector 置換か）を踏まえ、人間レビューを経て Accepted とする。

## 参考文献

- [a] Five easy steps to reindex in place with zero downtime（alias・新データのみなら reindex 省略）
- [b] Elastic — Changing Mapping with Zero Downtime（公式 alias 運用）
- [c] Google Cloud — Running database migrations with Cloud Run Jobs
- [d] Google Cloud — What is Cloud Run / Jobs vs Services
- [e] Google Cloud — Deploy to Cloud Run with GitHub Actions
- [f] Google Cloud — WIF with deployment pipelines / Keyless auth from GitHub Actions
- [g] Cloud Run — Rollbacks, gradual rollouts, and traffic migration（組込み rollback）
- [h] Cloud Run now supports gradual rollouts and rollbacks
- [i] Google Cloud Deploy 料金（pipeline $0.20/日 + target $0.02/日）
- [j] Firestore — composite index は非同期ビルド（apply 完了 ≠ 即利用可、`READY` 待ち）
- 反証（多ソース検証で棄却 0-3）: 「Google は CI=GHA / CD=Cloud Deploy 分業を推奨」/「deploy-cloudrun
  アクションが Job を execute する（実際は定義 deploy のみ。実行は `gcloud run jobs execute --wait` が別途必要）」

## 検証ノート（一次情報と推定の区別）

- **一次情報で確定**: Cloud Run 組込み rollback（無償・即時）、Cloud Run Job が移行/バッチの適所、
  Elastic の alias による zero-downtime・新データのみなら reindex 省略可、Cloud Deploy 料金、
  deploy-cloudrun アクションは Job を execute しない。
- **コード再点検で確定（SANBA 固有）**: INDEX=`sanba-grounding`（agent/api 重複定義）、`EMBED_DIM=3072`、
  ES に ILM 無し（TTL は Firestore 専用）、`scripts/seed_kb` 未実装＝本番 KB 空の latent バグ、
  grounding はハイブリッド（ADR-0003）。
- **推定（要再確認）**: Firestore Vector Search の GA 状況は 2026 時点で Preview 表記の継続から推定
  （最新リリースノートの直読を推奨）。Vertex/Cloud SQL の常駐課金は一般知識ベース（公式料金の直接確認は未）。
</content>
