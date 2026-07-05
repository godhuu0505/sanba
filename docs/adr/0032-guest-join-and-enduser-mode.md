# ADR-0032: ゲスト入場と利用者モード（interview_mode）

- ステータス: **Accepted（受理）**
- 日付: 2026-07-05（提案・受理）
- 関連: [ADR-0031](0031-product-entity-and-invite-links.md)（product・深掘りリンク — 本 ADR はその
  `scope=end_user` を解禁する）/ [ADR-0012](0012-google-login.md)（Google ログイン — 本 ADR が例外を定義）/
  [ADR-0024](0024-grill-me-interview-persona.md)（grill-me ペルソナ — developer モードとして位置づけ）/
  [ADR-0003](0003-elasticsearch-grounding.md)・[ADR-0028](0028-github-repo-linking.md)（grounding / repo 索引）/
  [ADR-0005](0005-llm-judge-eval-loop.md)（評価ループ）
- 背景文書: [personas-and-use-cases.md](../design/personas-and-use-cases.md) /
  [要件定義](../design/product-enduser-requirements.md) FR-2.x

## コンテキスト

利用者ペルソナは「アプリ名しか知らない・技術用語を知らない・URL を開くだけ」が前提
（personas-and-use-cases.md §1）。Google ログイン（ADR-0012）とアカウント作成を要求した瞬間に
この価値は壊れる。一方で匿名入口は abuse・PII・情報漏洩のリスクを持ち込むため、
例外の範囲と防御を設計として固定する必要がある。

また、既存のインタビューは grill-me ペルソナ（ADR-0024）＝開発者語彙で、
利用者にはそのまま使えない（MoSCoW・非機能などの語が露出する）。

## 決定

### ゲスト入場 — ログイン原則の限定的例外

1. **`scope=end_user` の深掘りリンクに限り、Google ログインなしで join できる**。
   例外はこの 1 経路のみで、他の API の認可（ADR-0012 / 0014）は変えない。
   ゲストの LiveKit トークン・session token も `POST /api/products/join` が**直接**返す
   （既存 `POST /api/sessions/join` へは委譲しない）: sessions/join の役割 invite は
   `scope` を持たず、通常セッションにも `customer` 役 invite が存在するため、そこに
   匿名分岐を足すと全ログインフローが通る共有エンドポイントへ例外面が広がる。
   発行ロジック自体は両エンドポイントで共通のヘルパーに保ち、二重化しない。
2. ゲストには **`guest:{random}` の participant identity を発番**し、発話・確定要件の
   出所メタ（ADR-0008）に残す。**利用者をユーザー化しない**（`users/{sub}` を作らない）。
3. ゲストセッションの **`owner_sub` は product owner** とする（管理画面・集約閲覧の権限元。
   「連携主体はセッション owner」という ADR-0028 の前提とも整合し、ゲストが GitHub 連携等の
   owner 権限を持つことはない）。
4. ゲスト join token の権限は当該セッションの読取（ハイドレーション）と既存 write 系
   （`user.selection` 等）のみ。**同意ゲート（`consent_acknowledged`）は省略しない**。
   同意文言は利用者向け（技術用語なし）とし、保持期間（既存 30 日 TTL）を明示する。
5. **abuse 対策**: リンク単位・IP 単位のセッション作成レート制限（超過 429）、
   `max_uses` のトランザクション消費（ADR-0031）、設定フラグ `guest_join_enabled`
   （既定 off）による段階リリース。

### interview_mode — プロンプト・語彙・出力の分岐

6. **`SessionMeta.interview_mode: "developer" | "end_user"`（既定 developer）** を追加し、
   リンクの `scope` から決める。ADR-0024 の grill-me ペルソナは developer モードの実装と
   位置づける（一問一答＋推奨回答例の原則は両モード共通）。
7. end_user モードのプロンプトは「いつ・どの画面で・何をしようとして・何に困ったか」を
   具体化する軸に切り替え、**product の glossary（利用者向け語彙）をシード**する
   （ADR-0028 の repo 要約シードと同じ、LLM 追加呼び出しなしの機械的組み立て）。
   MoSCoW・非機能などの開発語彙は内部分類に留め、発話・UI に露出しない。
8. **grounding の出力制御**: end_user モードでは repo 由来（ADR-0028 の索引）の passage を
   「次に聞くことの判断材料」としてのみ使い、**応答・引用イベントには出さない**
   （private repo の未公開機能・コード片の漏洩を遮断）。利用者の発話・過去セッション由来の
   passage は従来どおり引用できる。
9. **品質の回帰**: end_user モードの Langfuse 評価データセット（技術用語を使わない・
   一問一答維持・画面語彙の使用）を追加し、ADR-0005 の CI 回帰に載せる。

## 却下した代替案

- **ゲストにも軽量アカウント（magic link / メールアドレス）を要求**: 摩擦で離脱を生み、
  PII（メールアドレス）を増やす。出所メタは participant identity で足りる。
- **匿名の Web フォーム（非対話）で声を集める**: 深掘り（産婆術）ができず、
  既存アンケートと差が無い。音声一問一答が核。
- **end_user モードで grounding を完全遮断**: 質問の的が外れて品質が落ちる。
  「背景としての利用は許可・出力への露出は遮断」の非対称にする。
- **モードをプロンプトだけで分岐（モデル・契約に持たない）**: 管理画面・web の表示切替や
  回帰テストがモードを参照するため、`SessionMeta` に正として持たせる。

## 影響 / フォローアップ

- `apps/api`: `POST /api/products/join` のゲスト分岐・レート制限・`guest_join_enabled`
  （`config.py`）。ゲスト token の権限最小性はテストで固定する。
- `apps/agent`: `prompts/interview.py` のモード分岐、`main.py` の glossary シード、
  `retrieval.py` の出力制御。
- `apps/web`: `/join/[token]` のゲスト経路・利用者向け同意文言、`/sessions/[id]` の
  モード別文言切替。
- 観測性: `session_created` に `interview_mode` を含める。ゲスト join の 429・abuse 兆候を
  ログで追える形にする。LLM 入出力は従来どおり Langfuse へ。
- セキュリティ: PR 単位の `/security-review` に加え、匿名入口（join）と漏洩遮断
  （grounding 出力制御）は結合テストで機械的に検証する（要件定義 NFR-1/2）。
- 未決のまま残すもの: 利用者向け成果物の形式（ユースケース記述・生成プレビュー採否）は
  後続 ADR として Stage 3 着手前に決める（番号は起票時に採番）。
