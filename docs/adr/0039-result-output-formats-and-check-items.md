# ADR-0039: 要件結果の対象者別出力フォーマットとセッション確認項目

- ステータス: Accepted
- 日付: 2026-07-06

## コンテキスト
要件サンバの結果（確定要件）は、これまで要件絵巻（web の一覧表示）と GitHub Issue 起票
（`POST /export`）でしか出力できず、体裁も固定だった。しかし結果の読み手は一様ではない:

- **利用者**には、開発語彙（MoSCoW・functional 等）を出さない「お聞きした内容のまとめ」。
- **企画者**には、優先度と次のアクションが見える「要件サマリー」。
- **開発者**には、分類タグ付きの「要件定義書」。

また、アプリ提供者には「このセッションでは必ずこれを確認してほしい」という定番の論点
（ログイン方式・課金の有無など）があるが、これを事前に登録して agent の問いに反映する
手段がなかった。

## 決定
1. **出力フォーマットは audience（利用者/企画者/開発者）ごとに 1 つ、product に持つ**。
   `Product.output_formats: dict[Audience, str]`（`Audience` は `end_user/planner/developer`
   の 3 値）。`InviteScope`（インタビュー相手の 2 値）とは軸が別: 1 セッションの結果を
   3 通りの体裁で閲覧できる。登録はアプリ管理画面（`/products/{id}`）の管理操作
   （owner / admin のみ、`PATCH /api/products/{id}`）。
2. **未登録は既定テンプレートへフォールバックする**。既定は
   `sanba_shared.output_formats.DEFAULT_OUTPUT_FORMATS`（audience ごとに 1 つ）が正で、
   web には `ProductResponse.output_format_defaults` として渡す（定数を複製させない）。
   空文字で保存すると「既定へ戻す」（キー削除）。
3. **テンプレートは `{{placeholder}}` 置換の Markdown**。整形は api 層の
   `result_document.render_result_document` が LLM 追加呼び出しなしで機械的に行う
   （repo 要約シード・Issue 本文整形と同じ方針）。置換はテンプレートへの単一パスで、
   発話由来の値に含まれる `{{...}}` は再走査しない（プレースホルダ偽装対策）。
   閲覧は `GET /api/sessions/mine/{id}/result-document?audience=`（本人限定・存在秘匿 404）で、
   要件の選択は要件絵巻と同じ（確定済みは finalize 時の凍結スナップショット / #213）。
4. **確認項目は product ごとに最大 10 個**（`Product.check_items` /
   `MAX_CHECK_ITEMS = 10`）。セッション開始時に agent が glossary と同型の非信頼フェンス
   （`<check-items>`）で初期 instructions にシードし、会話の流れの中で一つずつ確認させる。
   end_user モードでは利用者の言葉への言い換えを指示する（ADR-0032 の語彙方針）。
   結果ドキュメントにも `{{check_items}}` として一覧が載る。
5. **サイドメニューを新設**し、トップ・セッション準備・セッション結果（会話中の 08 結果と
   `/sessions/{id}` の要件絵巻）からアプリ管理へ横断遷移できるようにする。end_user
   モードの結果画面には出さない（開発者向け導線を利用者に見せない）。

## 検討した代替案
- **フォーマットをセッション単位に持つ**: 毎回の準備が煩雑で「アプリの定番の体裁」という
  性質に合わない。product 単位（glossary と同居）にした。
- **LLM でドキュメントを生成する**: 出力が安定せず、フォーマット登録の意味（体裁の統制）が
  薄れる。プレースホルダ置換の機械的整形にした。
- **`InviteScope` を 3 値に拡張して兼用する**: インタビュー相手の軸（誰と話すか）と
  成果物の読み手の軸（誰が読むか）は独立で、1 セッションから 3 通りの出力を選べる必要が
  あるため、別 enum `Audience` を新設した。

## 影響
- Firestore `products/{id}` に `output_formats` / `check_items` が増える（旧文書は空で
  フォールバック）。`update_product` は map キー削除を永続化するため `set(merge=True)` から
  フィールド単位置換の `update()` に変更（編集対象フィールドのみ patch は不変）。
- 観測性: `sanba_result_document_rendered_total`（audience / format=custom|default）を追加。
  既定ばかりが使われるならアプリ管理画面の登録導線に課題がある合図。
- agent の初期 instructions に確認項目のシードが増える（`agent_instructions_built` ログの
  `check_items_count` で観測）。developer モードでも product を 1 回読むようになる。
