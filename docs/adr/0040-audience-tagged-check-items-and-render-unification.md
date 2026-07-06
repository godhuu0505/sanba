# ADR-0040: 確認項目の対象者タグと要件整形の一本化・api ルーター分割

- ステータス: Accepted
- 日付: 2026-07-06
- 関連: ADR-0039（出力フォーマットと確認項目の導入）

## コンテキスト
ADR-0039 で導入した確認項目は product ごとのフラットな 1 リストだった。しかし確認したい
内容は相手によって明らかに違う（「認証方式」は開発者に聞く話で、利用者には「検索で困った
場面」を聞く）。全員共通リストのままだと、利用者セッションに開発者向け項目が混ざり、
agent が言い換えで無理に吸収する形になる。

また、確定要件の Markdown 整形が 3 か所に重複していた: ADR-0039 のレンダラ
（api/result_document）、api の Issue 起票（github_export.requirements_to_issue_body）、
agent の Issue 起票（connectors/github の同名関数）。加えて「同じ 3 人の登場人物」を指す
語彙が 3 系統（準備画面の役割 customer/pm/engineer・InviteScope・Audience）に分裂し、
プロンプトの非信頼フェンス組み立ても 4 実装目に達していた。api の main.py は約 2,900 行の
単一モジュールで、全ルート・シングルトン・ヘルパが同居していた。

## 決定
1. **確認項目に対象ペルソナタグを付ける**。`CheckItem = {text, target: Audience | None}`
   （None = 全員）。新しい enum は作らず ADR-0039 の `Audience` を確認項目の対象にも使う
   （ペルソナ語彙の一本化。役割チップのラベルも web の `AUDIENCE_LABELS` に統一し、
   customer=end_user / pm=planner / engineer=developer の対応をコードに明記する）。
   旧文書（`list[str]`）は Product の validator が全員タグに平す（ADR-0014 §10 と同じ
   互換方針）。
2. **絞り込みはドメイン層の 2 関数に一元化する**。
   - シード（`check_items_for_scope`）: end_user セッション = 全員 + 利用者向け。
     developer セッション = 全員 + 企画者向け + 開発者向け。**企画者向けの独立した
     インタビューモード（3 値 InviteScope とペルソナプロンプト）は本 ADR では導入しない**。
     必要になった時点で別 ADR とし、この関数の分岐だけを差し替える。
   - 文書掲載（`check_items_for_audience`）: 全員 + 読み手一致のみ。
3. **要件整形を `sanba_shared.result_document` に一本化する**。api の閲覧エンドポイント・
   api の `/export`・agent の `export_requirements_to_github` がすべて「開発者向け出力
   フォーマット解決 + 共有レンダラ」で本文を作る（旧 `requirements_to_issue_body` 2 実装は
   削除）。副産物として、アプリ管理画面で開発者向けフォーマットを登録すると **GitHub Issue
   の体裁も変わる**（体裁の統制点が 1 つになる）。標題は `issue_title` で共通化。
4. **プロンプトの非信頼データフェンスを `build_untrusted_fence` に共通化する**。
   glossary / 準備情報 / repo 要約 / 確認項目の 4 シードが「開閉タグ除去 + 命令に従うな
   前書き」を共有する。repo 要約にも閉じタグ偽装の除去が効くようになる（従来は未対応）。
5. **api の main.py を APIRouter でドメイン別に分割する**。共有シングルトンは deps 層へ、
   main は組み立てファサード（app 生成・CORS・observability・include_router・テスト向け
   再エクスポート）に薄くする。挙動・パス・認可・観測は不変。
6. 確認項目の登録上限（`MAX_CHECK_ITEMS`）は API 応答（`check_items_limit`）で web へ渡し、
   フロントに定数を複製しない。

## 検討した代替案
- **対象ごとに独立した確認項目リスト（common/end_user/planner/developer の 4 リスト）**:
  Firestore スキーマと API が非対称になり、上限の意味（合計 10 か各 10 か）も曖昧になる。
  1 リスト + タグの方が UI・検証・互換が単純。
- **企画者向けインタビューモードの即時導入（InviteScope 3 値化）**: ペルソナプロンプト・
  ゲスト入場ポリシー・web の招待 UI まで波及する大きな設計判断で、確認項目タグとは
  独立に決められる。企画者タグが「当面 developer モードに合流」でも UI 上の意味
  （誰向けの論点か）と文書掲載の絞り込みは成立するため、分離した。
- **Issue 起票の体裁を従来固定のまま残す**: 整形の重複は残り、「フォーマットを登録したのに
  Issue は昔の形」という不一致が利用者に見える。一本化を選んだ。

## 影響
- Firestore `products/{id}.check_items` の要素が str から `{text, target}` の map になる
  （旧形式は読み込み時に平す。書き戻しで新形式へ移行）。
- Issue 本文の体裁が変わる（MoSCoW 見出しに日本語注記・確認項目セクション等）。本文を
  パースしている外部自動化は存在しない（gitleaks 等はワークフロー側）ため許容。
- agent の起票時に SessionMeta / Product を各 1 回読む（体裁メタの解決に必要）。
- api のテストは、移動した関数への monkeypatch 先変更のみ（意図・アサーション不変）。
