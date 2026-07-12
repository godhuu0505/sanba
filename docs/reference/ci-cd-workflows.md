# CI/CD ワークフロー設計リファレンス

`.github/workflows/` と `.github/dependabot.yml`・`.github/labels.yml` の**設計判断の正**。
「何をするか」は各 YAML 自体が表現し、「なぜそうなっているか」はここに書く
（コメント禁止規約の対象を YAML / Terraform に拡張した経緯は ADR-0068）。
セキュリティ観点の一次情報は [security.md](security.md)、CI/CD の全体像は
[devops.md](../how-to/devops.md)、ラベル運用は [labels.md](../how-to/labels.md)。

## ci.yml — CI

- `concurrency` は同一 ref の古い実行をキャンセルする（Actions 分のコスト最適化）。
  デプロイ系と違い途中キャンセルしても状態を残さないため `cancel-in-progress: true`。
- top-level `permissions: contents: read`。CI はチェックアウトと読み取りのみで足りる
  （public 化に伴う最小権限の明示。security.md §8）。
- 各言語ジョブの `mypy src` は「型チェックを quality-gate に実在させる」ためのステップ（#58）。
- `docker` ジョブの build context: agent/api/worker は共有パッケージ
  `packages/sanba_shared` を同梱するためリポジトリ直下、web は共有パッケージ不要なので
  `apps/web`（ADR-0014 §9）。Buildx キャッシュの `scope` は app 単位で分け、
  deploy.yml のビルドとキャッシュを共有する。
- `quality-gate` はループ終端条件「mergeable」を 1 つの必須チェックに集約するジョブ
  （#58 / ADR-0011 §2）。branch protection はこのジョブだけを必須にすればよく、構成が単純になる。
  `docker` は重いため集約対象外（web は `npm run build` で build 自体は担保済み）。
  判定は失敗・キャンセル・**スキップ**のいずれかがあれば赤にする。skipped を失敗扱いに
  するのは、path フィルタ等で必須ジョブが走らずに緑へ化けるのを防ぐ保険。
- `no-comments` ジョブは説明的コメントの混入を検出する（CLAUDE.md 規約 / ADR-0068）。
  Python 版（stdlib のみ）が Python / YAML / Terraform を、Node 版が web の TS/TSX を検査する。

## deploy.yml — CD（Cloud Run）

main へのマージで「マイグレーション（terraform apply）→ ビルド → Cloud Run デプロイ」を
自動で回すパイプライン（ADR-0026）。認証は Workload Identity Federation（鍵レス）。

- **順序保証**: `infra/terraform` に変更があれば `migrate`（terraform.yml を workflow_call）を
  先に走らせ、成功後に deploy する。新コードが依存する env/secret/インデックス等の設定変更
  （= このプロダクトのマイグレーション。永続層 Firestore はスキーマレスで TTL フィールド等も
  Terraform 管理）をイメージ差し替えより先に反映するため。migrate 失敗時は「新コードが依存する
  設定が未反映」の恐れがあるため deploy も止める。migrate がスキップ（infra 変更なし）なら進む。
- **コスト最適化**: 変更のあった app だけビルド & デプロイ（paths-filter）。Buildx の GHA
  キャッシュでビルド時間短縮。env/secret/スケールは Terraform が一度だけ設定し、CD は
  画像の差し替えのみ（`gcloud run deploy --image` は既存の env/secret 設定を保持する）。
- **concurrency**: terraform apply / gcloud run deploy の途中キャンセルは中途半端な状態を
  残すためキャンセルしない（直列化）。pending は最新 1 件だけ残るので、連続マージでも
  最終的に最新 SHA がデプロイされる。migrate は `terraform-<ref>` グループで terraform.yml の
  手動 apply と直列化し、state の競合を避ける。
- **workflow_dispatch**: GitHub Mobile からも実行できる手動トリガー。差分が無く paths-filter が
  空を返すため、入力 `apps` で対象を決める（`all` = 全 app 再デプロイ。ロールバック/強制再デプロイ
  用途）。choice はサーバ側で強制されないため、JSON 生成前に許可リスト照合で必ず検証する。
  実行者・対象・理由は監査用に Summary タブへ恒久的に残す。手動デプロイはイメージ差し替えのみで、
  terraform の手動 apply は terraform.yml の dispatch（action=apply）を使う。
- **infra 出力の分離**: `infra` は Cloud Run app ではないのでデプロイ matrix から除外し、
  専用の boolean 出力として migrate ジョブへ渡す。
- **migrate に `secrets: inherit` を付けない**: terraform.yml は `vars.*` と `github.token`
  しか使わない。信頼境界を明示するため secrets は渡さない。
- **web ビルド設定の fail fast**: `NEXT_PUBLIC_*` はビルド時にバンドルへ焼き込まれるため、
  設定漏れに気づける最後のタイミングはビルド前しかない。未設定だと本番を黙って壊す —
  `NEXT_PUBLIC_API_URL` は「空」で焼かれてブラウザが web 自身のオリジンへ /api を投げて壊れ、
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID` は dev モードで焼かれて Bearer を送らず API が 401/503 になる。
  どちらも Variables 設定漏れで発生するため、ビルド前にまとめて検証して落とす。
  値は `run` へ直接展開せず env 経由で渡す（インジェクション安全なイディオム）。
- **Picker API キー**: `NEXT_PUBLIC_GOOGLE_API_KEY` は GitHub Variables ではなく
  Secret Manager を唯一の置き場にする（ADR-0049）。web ビルドは WIF 認証済みなので、そこで
  読み出して build-arg に渡す。未作成・未権限なら空のままで Drive 導線は「利用不可」に退化する
  だけ（fail-safe。ローカルアップロードは無影響）。値はログでマスクする。
- **build-args の条件生成**: 空文字を渡すと Dockerfile の既定を上書きしてしまうため、
  変数が設定されている行だけを生成する（未設定なら Dockerfile 既定が生きる）。
- **worker のデプロイスキップ**: worker は `enable_video_analysis=false` の間 Cloud Run
  サービスが未プロビジョニング（ADR-0040・media.tf の count）。その状態で deploy すると
  「サービス不在」で必ず失敗し CD が赤くなるため、サービスの存在を確認してから deploy する。
  イメージの build & push・attestation は常に実行するので、フラグを立てて terraform apply した
  ときに参照するイメージは既に AR にある（ブートストラップ制約の解消）。
- **attestation はデプロイ後**: SLSA build provenance と SBOM の署名記録は本番反映を
  止めないよう deploy の後に実行する。

## terraform.yml — IaC の plan/apply

本番インフラ（Cloud Run / LB / DNS / Secret Manager 等）の IaC を CI で回す。入口は 3 つ:

1. main 向け PR で `infra/terraform` を触ったら `terraform plan` を実行し、結果を PR に貼る
   （人間が plan を確認してからマージ → 本番反映、というフローの担保）。
2. main へのマージは deploy.yml の migrate ジョブが workflow_call で呼び出して自動 apply
   （マイグレーション工程。ADR-0026）。
3. GitHub Mobile の Actions → Run workflow で `apply` を選ぶと手動でも本番反映できる
   （ロールバック・初回構築用）。その場で plan を出し、保存した plan を適用する。

- **認証**: deploy.yml と同じ WIF（キーレス）。ただし apply は LB/DNS/Secret/IAM を作るため、
  deploy 用 SA より広い権限を持つ Terraform 用 SA（`vars.TF_DEPLOY_SA`）を使う。未設定なら
  deploy 用 SA にフォールバック。WIF パス・SA email は公開識別子なので Variables 管理
  （[deploy-gcp.md §3](../how-to/deploy-gcp.md)）。
- **起動ガード**（多層防御の一次防御）: GCP 未配線（project 未設定）のうちは skip して
  赤くしない（deploy.yml と同じ方針）。fork PR ではジョブごと起動しない — 理由と WIF の
  attribute-condition では fork を判別できない事情は [security.md §8](security.md) が正。
  workflow_dispatch / workflow_call では `pull_request` 文脈が無く `head.repo.fork` が null に
  なるため、pull_request イベントのときだけ fork を判定する。
- **承認ゲート**: apply のときだけ `production` 環境を要求する（dispatch / workflow_call 共通。
  pull_request では inputs が空なので plan のみ）。リポジトリ設定で production に
  required reviewers を付ければ「実行 → 承認 → 反映」の承認ゲートになる。
- **concurrency**: apply の取りこぼし/重複適用を避ける。apply は途中キャンセルしない。
- **Terraform の導入**: 第三者アクションの SHA を固定できない環境のため、バージョン固定 +
  公式 SHA256SUMS 照合で入れる（改ざん検知込みで再現性を担保。security.md §8）。
- **state**: GCS リモートバックエンド（bucket は `vars.TF_STATE_BUCKET`）。
- **fmt は警告どまり**: フォーマット差は `continue-on-error` で警告に留め、
  validate / plan を本ゲートにする。
- **plan の PR コメント**: plan は失敗してもコメントを残してから落とす。生ログ（state refresh
  の進捗等）はジョブログ用に残し、PR コメントには保存した plan を `terraform show` で描画した
  「何が変わるか」だけを貼る。init/validate/plan が失敗して tfplan が無いときはエラーログ末尾を
  見せる。同じ PR へのコメントは増やさず、marker（`<!-- terraform-plan-comment -->`）で特定して
  1 つを更新し続ける。秘匿リソース属性が伏せられる理由は security.md §8。
- **apply**: 保存した plan をそのまま適用（=「plan で問題なければ apply」）。dispatch と
  workflow_call の両方で有効。

### TF_VAR（GitHub Variables → terraform 変数）の設計メモ

いずれも非機微の設定。**アプリ秘匿値（livekit / elasticsearch 等）は TF_VAR で渡さない** —
Secret Manager が唯一の置き場で、terraform は箱と参照だけを管理する（値を state / GitHub に
残さない。[deploy-gcp.md §6.7](../how-to/deploy-gcp.md)）。session-signing-secret も terraform が
自動生成するため GitHub には置かない。

| Variable | 意味・注意 |
|---|---|
| `ENABLE_BILLING_EXPORT` | BigQuery への Detailed usage cost export 用 dataset を作るか（ADR-0061）。dataset 作成後、請求先アカウント側のエクスポート設定はコンソールで一度だけ行う（[pre-launch-cost-controls.md §3](../how-to/pre-launch-cost-controls.md)） |
| `PROD_WEB_SUBDOMAIN` | web をサブドメインで配信する場合のみ設定（例: `youken` → `youken.<PROD_DOMAIN>`）。空なら apex 配信。OSS なのでドメインはコードに焼かず Variable で各自設定 |
| `PROD_DNS_ZONE_NAME` | Cloud DNS マネージドゾーンの resource 名。Cloud Domains が自動作成したゾーン（例 `sanba-net`）を import して使う場合はその名前を指定。未設定なら既定 `sanba` |
| `PROD_DNS_DNSSEC_STATE` | 管理ゾーンの DNSSEC 状態。Cloud Domains 由来の DNSSEC 有効ゾーンを import した場合は必ず `on` を設定する。未設定なら空文字を渡し（#106）、variables.tf / domain.tf の dynamic block が DNSSEC 設定ブロック自体を送らない（= 既存状態を変更しないフェイルセーフ）。以前は `\|\| 'off'` で常に off を渡していたため、有効ゾーンへ誤って DNSSEC 無効化を試みる恐れがあった |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google ログインの OAuth Web クライアント ID。web（NEXT_PUBLIC）と API（aud 検証）で同値を使う。未設定だと API は認証経路を 503 でフェイルクローズする |
| `DEPLOY_SA` | web ビルド SA。Picker 用 API キーの Secret を build 時に読む accessor を付与する（ADR-0049）。空なら付与しない（Drive 導線は無効） |
| `ACTIVE_APP_SECRET_IDS` | 値が投入済みで Cloud Run に注入する app secret の id（JSON 配列）。値そのものは Secret Manager に gcloud で直接投入する（secrets.tf / [deploy-gcp.md §6.7](../how-to/deploy-gcp.md)） |
| `GH_APP_*` | GitHub App 連携（ADR-0028）。id/slug/client_id は公開識別子なので Variables 管理、秘匿値（private key / client secret）は Secret Manager へ投入して `ACTIVE_APP_SECRET_IDS` に足す。変数名を `GH_APP_*` にするのは GitHub が `GITHUB_` 接頭辞の変数名を予約していて作成できないため |

## agent-standby.yml — Standby (warm/sleep)

プレスリリース前のコスト最小化運用。現況と切り替え手順は
[pre-launch-cost-controls.md §2](../how-to/pre-launch-cost-controls.md) が正 —
**warm/sleep の Variable 同期運用は現在停止中**（`GITHUB_TOKEN` では Variables API が 403。
`terraform.yml` の `AGENT_MIN_INSTANCES` 配線は撤去済みで、Terraform 変数
`agent_min_instances` の既定 `1` で運用）。ワークフロー固有の設計メモ:

- warm では agent に加えて api / web にもウォームアップリクエストを送り、コールドスタート済みの
  状態にしてから疎通を確認する（api / web の min-instances は 0 のまま。terraform とのドリフトを
  作らず、リクエスト課金だけで温める）。この部分は現在も単体で有効。
- sanba-worker は Cloud Tasks push 専用で worker SA 以外は invoke できないため外から温められないが、
  タスク投入時に自動起動されるので対象外。
- agent の反映が「Variable 更新 → gcloud 即時反映」の 2 段構えなのは、以後の terraform apply に
  巻き戻されないようにしつつ apply を待たず反映するため。Variable 更新が失敗したら gcloud には
  進まない（drift を作らない fail fast）。再開する場合は Variables write 権限のある fine-grained
  PAT が必要（runbook 参照）。
- `concurrency` は terraform apply（`terraform-<ref>`）とは別系統だが、standby の連打は直列化する。
  `actions: write` は Variable の更新（`gh variable set`）に必要。

## security.yml / codeql.yml / scorecard.yml / dependency-review.yml

スキャンのゲート方針（pip-audit / gitleaks / Trivy / CodeQL / Scorecard / dependency-review の
それぞれが何をブロックするか）は [security.md §7](security.md) が正。ワークフロー固有のメモ:

- `python-audit` の matrix に `packages/sanba_shared` を含めるのは、共有ドメイン層も独自依存
  （google-cloud-firestore 等）を持つため。
- gitleaks は v2 action がライセンスを要求するためバイナリを直接実行する。導入はバージョン固定 +
  公式 checksums.txt 照合（terraform.yml と同方針・改ざん検知）。
- `image-scan` の docker build context の分岐は ci.yml の `docker` ジョブと同じ理由（ADR-0014 §9）。

## claude-review-response.yml — レビュー自動対応

レビューが付いたら Claude Code が内容を読み取り、「対応 / skip / needs-human エスカレーション」を
実行する（ADR-0010 / ADR-0015）。ラベルの状態機械は [labels.md](../how-to/labels.md) が正。

- **トリガー**: レビューの出し手は Codex GitHub 連携（`chatgpt-codex-connector[bot]`）と
  人間レビュアーの 2 系統。二重起動を避けるため `pull_request_review(submitted)` に集約する。
  Codex は指摘をインラインコメントで出すため、レビュー本文（body）はテンプレートのみのことがあり、
  実際の指摘は prompt 内で `gh api .../pulls/<n>/comments` から取得する。
- **権限**: 外部由来テキスト（レビュー本文・差分・Codex 出力）を投入する LLM ジョブなので、
  プロンプトインジェクションの被害範囲を絞るため書込権限を最小化する（SEC-045）。
  `contents: write` は修正コミットの push、`pull-requests: write` はラベル・コメント・返信・
  スレッド resolve、`id-token: write` はビルトイン Claude GitHub App 認証（OIDC）に必須。
  `issues: write` は付与しない（新規 issue 起票はせず、範囲外の指摘は needs-human ラベルで
  人間へエスカレーションする）。
- **起動ガード（対象限定とループ防止）**: 起動するのは Codex の review か、信頼済みの人間
  （author_association ∈ OWNER/MEMBER/COLLABORATOR）の review のみ。fork PR ではジョブごと
  起動しない（一次防御の理由は security.md §8）。Claude 自身（claude[bot]）や他 Bot の投稿では
  起動せず、対応コメント・修正コミットによる自己再起動を根本から防ぐ。claude[bot] は
  `review.user.type` が `Bot` として渡らずガードをすり抜け、action 本体の allowed_bots 検証で
  ハードエラー（赤）になる事例があったため、`review.user` / `github.actor` の両面で claude を
  明示除外し、自己再起動は「失敗」ではなく skip（成功扱い）で止める。内容の無い approve も
  スキップ。secrets はジョブ `if` で参照できないため、OAuth トークンの有無はステップで確認して
  未設定環境では CI を止めずにスキップする。
- **やり取り上限**: `MAX_AI_ROUNDS`（既定 5）は Codex のレビュー回数で数える。カウントは
  「今トリガーした review」を含む累計で、上限**まで**は自動対応させ、上限を**超過**した次の
  review で打ち切るため `-gt` で判定する（`-ge` だと 5 回目で即停止してしまい「5 回まで自動対応」
  というドキュメントと食い違う）。超過時は進行中ラベルを外し needs-human を付けて通知する。
- **GH_REPO を job env に置く理由**: rounds 計数・escalate・responding 付与の gh コマンドは
  actions/checkout より前に走るためローカル .git が無く、`GH_REPO` が無いと `gh pr edit/comment` が
  リポジトリを特定できず失敗する（`|| true` で握り潰されラベルが付かない）。job env なら
  全ステップに継承される。
- **checkout の ref**: `pull_request_review` の既定 ref は base ブランチのため、明示的に PR の
  head ブランチをチェックアウトする。これがないと Claude は head を持たず、別ブランチを切って
  別 PR を作ってしまう。fork は起動ガードで除外済みなので head.ref は必ず同一リポジトリの
  ブランチ＝安全に push できる。
- **実行**: Claude Pro/Max サブスク枠（OAuth トークン）で実行し API 従量課金を避ける。トークンは
  ローカルで `claude setup-token` を生成して Secret に登録する。`allowed_bots` で Codex の
  Bot review を起点にできるよう明示許可。Bash はデフォルト無効のため、gh/git とテスト・lint
  コマンドに加えて読み取り系シェル（jq/cat/ls/grep）も明示許可し、permission 拒否の多発で
  ターンを浪費するのを防ぐ。
- **対応後の状態遷移**: 対応前後の HEAD を比較し、動いた（= 修正を push した）なら次の Codex
  レビュー待ち（ai:review-wait）、動かないなら修正なし（LGTM / 全 skip）＝収束で人間が確認可能
  （ai:review-done）。`GITHUB_TOKEN` による push は workflow を再起動しないため、ここで明示的に
  次状態のラベルを付ける（review-status.yml の synchronize 再付与に依存しない）。失敗時は
  needs-human を付けて人間に確認を促し、後始末として失敗・中断でも「対応中」ラベルは必ず外す。
- **ラベル操作のイディオム**: `gh` の add-label は冪等（既存なら無害）、remove-label は不在で
  失敗するため `|| true` を付ける。

## review-status.yml — レビュー進行ラベル

状態遷移は [labels.md](../how-to/labels.md) の状態機械が正。ワークフロー固有のメモ:

- fork PR は自動化対象外（ADR-0015 §10）。draft はレビュー待ちにしない。
- このジョブは checkout を実行しないため `GH_REPO` が必須（無いと `gh pr edit/view` が対象
  リポジトリを特定できず、`|| true` で握り潰されてラベルが実際には付かない）。
- PR 更新時は review-done を外して review-wait を付け直すが、needs-human（人間にエスカレ済み）が
  付いていれば待ちに戻さない。ラベル未作成/drift でも赤にしないよう `|| true`。
- review 投稿時のガードは claude-review-response.yml と同じ author_association 制限を掛ける。
  これが無いと外部の第三者レビューでも待ちラベルが外れる一方、Claude 側は信頼済みのみ起動する
  ため、PR が「進行ラベルなし」で取り残される。

## labels.yml（workflow）/ labeler.yml — ラベル同期・自動付与

単一の真実 = `.github/labels.yml` の運用（同期・削除・rename・軸設計・rename 禁止ラベル）は
[labels.md](../how-to/labels.md) が正。labeler は同一リポジトリのブランチ PR を対象とし、
`pull_request_target` は使わない（fork の未信頼コードに書込トークンを晒さない）。
`sync-labels: true` は該当しなくなった `area:*` を外して area 軸を path と一致させる。
labels.yml workflow の `contents: read` は actions/checkout に必要（permissions を 1 つでも
書くと他は none になるため明示している）。

## llm-eval.yml — LLM 回帰評価

プロンプトやエージェント定義の変更時に要件インタビューの品質を回帰評価し、劣化したら fail
（ADR-0051、[devops.md §4](../how-to/devops.md)）。`GOOGLE_API_KEY` がある環境では実 LLM judge、
無い環境（fork PR には secrets が渡らない GitHub 仕様）では決定的な heuristic 採点に自動
フォールバックしてゲート自体は維持する（security.md §8）。

## dependabot.yml — 依存更新

- npm の `typescript` は major 更新を ignore する: typescript 7（Go ネイティブ実装）は
  typescript-eslint（peer: <6.1.0）と Next.js 16 の build worker が未対応で CI が落ちるため、
  対応が揃うまで見送る（PR #485 の失敗要因）。揃ったら ignore を外す。
- docker ecosystem は Dockerfile の `FROM` のみ更新する。docker-compose.yml /
  docker-compose.tools.yml の `image:` は対象外なので、それらは固定バージョンタグ
  （＋可能ならダイジェスト）で手動ピンして供給網リスクを抑える（SEC-047）。
