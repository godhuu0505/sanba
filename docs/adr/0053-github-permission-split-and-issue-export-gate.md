# ADR-0053: GitHub 連携の権限分離 — 読みは App 索引・書きは操作者権限ゲート付き Issues:write

- ステータス: Proposed
- 日付: 2026-07-08
- 関連: [ADR-0007](0007-external-connectors.md)（外部コネクタ・共有トークン — 本 ADR が書き経路を置き換える）/
  [ADR-0027](0027-per-session-github-repo.md)（セッション単位 repo 選択 — 本 ADR が準備画面からの選択を撤去する）/
  [ADR-0028](0028-github-repo-linking.md)（GitHub App・ES 索引 — 読み経路をそのまま踏襲）/
  [ADR-0031](0031-product-entity-and-invite-links.md)（product エンティティ・repo 解決の持ち上げ）/
  [ADR-0032](0032-guest-join-and-enduser-mode.md)（ゲスト入場 — 起票不可の原則を維持）/
  [ADR-0036](0036-product-members-and-invitations.md)（product メンバー — 実行者ペルソナの器）/
  [ADR-0042](0042-result-output-formats-and-check-items.md)（要件結果の出力）/
  [ADR-0044](0044-home-app-selection-gate.md)（アプリ選択をホームへ移動 — 本 ADR が repo 欄撤去まで完遂する）
- 背景文書: [personas-and-use-cases.md](../explanation/personas-and-use-cases.md)

## コンテキスト

GitHub の repo・branch を設定する人と、要件サンバのセッションを実行する人は、別ペルソナで
権限が異なる（personas-and-use-cases.md §1）。設定する人は GitHub を保有する開発者 / PdM
（product owner, ADR-0031）で、実行する人はアプリ名しか知らない利用者・メンバー
（ADR-0036）やゲスト（ADR-0032）＝**GitHub アカウントを持たない**。この分離は product /
membership / guest のドメインモデルとして既に実装されているが、GitHub 連携まわりに 2 つの
矛盾が残っている。

### 矛盾1: 準備画面の repo 選択が「操作者本人の GitHub 権限」に依存している

`GET /api/github/repos` / `GET /api/github/branches`（`routers/github_link.py`）と
セッション単位索引 `POST /api/sessions/{id}/github` は、**いまログイン中のユーザー本人**の
GitHub App 連携（`get_github_link(user.sub)`）を引く。GitHub 未連携の準備者（＝ owner でない
実行ペルソナ）には候補が出ず、branch 取得は 409、セッション単位索引は owner 限定で失敗する。
一方で product 側は既に owner の installation で repo を束ね（`POST /api/products/{id}/github`）、
セッション作成時に repo を product から継承する（`routers/sessions.py`）。**repo 束縛が
「セッション高さ」と「product 高さ」の二重管理**になっており、セッション高さの UI・API が
実行者の個人アイデンティティに依存していることが矛盾の根である。

### 矛盾2: 準備画面に repo/branch 欄があること自体がナンセンス

想定する実行ペルソナは GitHub を持たない。ADR-0044 は準備画面から product セレクトを外して
表示のみにしたが、**repo/branch 欄は撤去し損ねている**。product が既に束ねているので、
セッション高さの欄は冗長かつ有害。

### 未解決の穴: 読みと書きでトークンの出所が違う

読み（grounding/索引, ADR-0028）は product owner の GitHub App installation で行われ、
最小権限・短命・org 横断にスケールする。しかし書き（Issue 起票 `/export`,
`routers/sessions.py`）は **デプロイ単位の共有 PAT**（`settings.github_token`,
`github_connector_enabled` ゲート）に落ちている。App は read-only（ADR-0028）で Issue を
書けないための暫定である。共有 PAT は被害面が全 repo・読み書き全部、複数 org にまたがる
product 群を 1 本で賄えず、発行者が抜けると失効する。「対象アプリの repo に Issue」を
本気でやるなら、書きも product 単位のアイデンティティに寄せる必要がある。

## 決定

### 1. repo 束縛を product 正典に一本化し、準備画面から GitHub を撤去する（矛盾1・2）

準備画面（`EntryFlow` step=prepare）から「連携リポジトリ（任意）」欄と「ブランチ」欄を
**撤去**する（ADR-0044 の意図を完遂）。準備画面は役割・ゴール・同意のみとし、対象アプリ名は
表示のみを維持する。repo/branch は **product 高さでのみ**束ね（`ProductRepoCard` /
`POST /api/products/{id}/github`, owner-only, owner の installation）、セッションは作成時に
product から継承する（既存挙動）。repo 解決の優先順（セッション明示 > product > 環境変数,
ADR-0031）は保持するが、**セッション明示は準備画面の標準フローからは発生させない**。
セッション単位の repo 選択 API（`POST /api/sessions/{id}/github`）は標準 UI からは呼ばず、
既存の開発者 1:1 レガシー経路の後方互換としてのみ残す（新規導線を作らない）。

### 2. 読み — GitHub App installation token を維持（ADR-0028 踏襲）

grounding/索引の読みは GitHub App の短命 installation token（Contents / Metadata / Issues:
read）を維持する。最小権限・生トークン非保存・repo 選択可・監査良好という性質を変えない。
当面は**本人インストール**のまま（決定 6 参照）。

### 3. 書き — App に Issues:write を追加し、操作者本人の installation token で起票する

GitHub App の要求権限に **Issues: write** を追加する（既存インストールは再同意が必要）。
`/export` は共有 PAT（`settings.github_token`）ではなく、**起票を操作しているユーザー本人の
installation token** で Issue を作成する。共有 PAT による書き経路（ADR-0007 の env
コネクタ書き込み）は**退役**する（env コネクタは読み用途・レガシー既定として残置しうるが、
product/セッションの起票フローは App 経路に一本化する）。

起票トークンを「操作者本人の installation」にする理由は、決定 4 の権限判定（本人の
installation が対象 repo を列挙できるか）と書きトークンが**同一事実**になり、最小権限・
監査が最もきれいになるため。org install へ移行する際は「org installation ＋ 操作者は org
メンバー」に自然に置き換わる。

### 4. 起票の権限ゲート — GitHub 連携 ∧ 対象 repo 権限のときだけ有効にする

Issue 起票（API・UI ボタン）は次の両方を満たすときのみ有効にする:

- **(a) 操作者が GitHub 連携済み**（`users/{sub}` に installation がある）。
- **(b) 操作者の GitHub 権限が product の紐づけ repo を含む**（本人 installation の
  `list_repos` に `product.github_repo` が含まれる）。

いずれかを欠く場合、API は 403、web は**ボタンを disable し理由を表示**する（「GitHub と
連携してください」/「この repo への権限がありません」）。判定は既存の repo 許可判定・
product 認可（`deps._require_product_access` / `_github_repo_allowed`）と同じく、API の
ヘルパーに集約し、web 側は表示制御のみとする（認可の正はサーバ）。

### 5. 起票は開発者の結果閲覧フローに置く（ゲストは不可を維持）

ゲスト（end_user）セッションからの起票は従来どおり不可（ADR-0032 決定 4）。想定フローは
「GitHub を持たない利用者・メンバーが要件を作成 → 後から GitHub 連携済みの開発者が結果画面
（`/results/[id]` 等）で要件を確認して Issue 登録」とする。Issue の**作成者表示は
`SANBA[bot]`**（installation token のため）とし、誰が起票したかは Issue 本文に
「SANBA セッション {id} / export by {github_login}」の形で記録する（案 B のまま。実在の
開発者名義にする user-to-server OAuth 起票は複雑さが増すため採らない — 却下案参照）。

### 6. org install への移行は段階化する

owner 離脱耐性・org/テナント化のため、将来 GitHub App を **org インストール**へ寄せる。
ただし本 ADR では**本人インストールのまま出す**。移行を局所化するため、read/write いずれの
installation 解決も **API の単一ヘルパー経由**にする（現状 `get_github_link(sub)` で分散して
いる参照を集約）。`product ↔ installation` の接続モデル新設と org install 実装は別 ADR /
別 PR で扱う（ADR-0031 決定 5 の「org は需要が立ってから」の維持）。

## 影響

- `packages/sanba_shared`: 変更は小（起票時の監査メタを Issue 本文へ渡すための引数程度）。
  `Product` / `GitHubLink` のスキーマ変更は無し。
- `apps/api`:
  - `routers/github_link.py`: `GET /api/github/repos` / `/branches` を準備画面用途から外し、
    アプリ管理（owner 文脈）用途に限定。installation 解決ヘルパーへの集約（決定 6）。
  - `routers/sessions.py`（`/export`）: 共有 PAT を操作者本人の installation token に置換、
    Issues:write で起票。権限ゲート（決定 4）を追加。共有 PAT 書き経路の退役。
  - 起票可否を返す軽い API（web のボタン活性判定用）または既存 product/session レスポンスへ
    `can_export` 相当のフラグを追加。
- `apps/web`:
  - `EntryFlow.tsx`: 準備画面の repo/branch 欄と関連 state（`repoChoices` / `githubRepo` /
    `githubBranch` / `branchChoices`）を撤去。`prepFormStorage` の `githubRepo` も除去。
  - 結果画面: Issue 登録ボタンの活性/非活性と理由表示（決定 4）。
- `apps/agent`: 起票ツール（`export_requirements_to_github`）は読み経路に影響なし。書き経路の
  トークン供給元が変わるため、agent 側から起票する経路がある場合は api の権限ゲートに従わせる。
- インフラ / セキュリティ: GitHub App の権限に **Issues: write** を追加 →
  既存インストールの**再同意**が必要（リリースノート・案内が要る）。`GITHUB_TOKEN`（共有 PAT）
  の書き用途を退役（env コネクタの扱いは移行時に確認）。read-only 原則の緩和は本 ADR の
  明示的なトレードオフ。
- 観測性: `requirements_exported` に `installation_source`（acting-user）・`can_export` 判定
  結果・repo を含める。起票拒否（403）・ボタン非活性の理由をログで追える形にする
  （CLAUDE.md 原則 3）。

## 却下した代替案

- **書きを共有 PAT のまま維持**: 被害面が全 repo・読み書き全部、複数 org 非対応、発行者依存。
  最小権限・スケール・人依存すべてに反する。退役する。
- **書きを product owner / org の installation で行う（操作者はゲートのみ）**: 起票
  アイデンティティが product 単位で一定になるが、「誰の権限で書いたか」が操作者と一致せず、
  権限判定と書きトークンが別事実になる。操作者本人の installation を使う決定 3 のほうが
  最小権限・監査がきれい。org install 移行時は決定 6 で自然に置き換わる。
- **user-to-server OAuth で実在の開発者名義に起票**: Issue 作成者が実在の人になり監査は
  最良だが、短命 OAuth トークンの保持/リフレッシュが要り設計が一段増える。bot 名義＋本文
  記録で説明責任は足りるため、需要が立ってから別 ADR で扱う。
- **org install を今回まとめて実装（案 C）**: owner 離脱耐性・org 化に最短だが
  `product ↔ installation` 接続モデル新設で変更が最大。本人 install で先に価値を出し、
  移行を局所化（決定 6）してから別 ADR にする。
- **準備画面にセッション単位 repo 選択を残す**: 二重管理と個人権限依存（矛盾 1・2）の温存。
  product 正典に一本化する。

## リスクと緩和

- **App 権限昇格（Issues:write）と再同意**: 全 installer に再同意を求める運用コスト →
  リリース案内 + 段階リリース。read-only から write への拡大は最小限（Issues のみ、Contents
  等は read のまま）に留める。
- **操作者の installation が対象 repo を含まない**: 起票不可を明示（ボタン disable ＋理由）。
  黙って失敗させない。owner がアプリに紐づけた repo と、開発者本人が App に許可した repo が
  食い違う場合に起きうる → 案内文で「対象 repo を App に許可」を促す。
- **owner 離脱で読み（索引）が止まる**（穴 B）: 本 ADR では未解決のまま。org install 移行
  （決定 6・別 ADR）で解消する。移行を局所化するため installation 解決を単一ヘルパーに集約。
- **bot 名義起票の説明責任**: Issue 本文に export 者・セッション ID を記録し追跡可能にする。
- **共有 PAT 退役に伴う既存フローの断絶**: env コネクタ書き込みに依存する運用があれば移行
  期間を設ける。読み用途の env コネクタ（ADR-0007）は必要なら残置。

## 実装方針（段階導入）

各段が単独で lint / test / build を通し、デプロイ可能な状態を保つ（CLAUDE.md）。

- **段1（UI 整合・矛盾の直接解消）**: 準備画面から repo/branch 欄と関連 state を撤去
  （矛盾 1・2 の直接原因を除去）。API 変更なしで先行リリース可能。
- **段2（書きの App 化）**: GitHub App に Issues:write を追加、`/export` を操作者本人の
  installation token ＋権限ゲート（決定 3・4）に置換、共有 PAT 書き経路を退役。結果画面の
  ボタン活性/理由表示。
- **段3（org install・別 ADR）**: installation 解決の単一ヘルパー化を土台に、`product ↔
  installation` 接続と org install へ移行（owner 離脱耐性・org 化）。本 ADR のスコープ外。
