# ADR-0064: 参考資料の解析結果を voice agent の初期前提としてシードする

- ステータス: Proposed
- 日付: 2026-07-09
- 関連: [ADR-0035](0035-prep-context-seeding.md)（同型の proactive シード・本 ADR はその資料への適用）
- 関連: [ADR-0028](0028-github-repo-linking.md)（「retrieval 任せにしない」原則の出典）
- 関連: [ADR-0040](0040-uploaded-video-async-analysis.md)（解析結果の grounding 投入と能動注入 §4）
- 関連: [ADR-0032](0032-guest-join-and-enduser-mode.md)（end_user モードの出力遮断・シード可否の整合）
- 関連: [ADR-0023](0023-staged-upload-analysis-progress.md)（実体に正直な進捗表示の規律）

## コンテキスト
準備画面・会話中にアップロードされた参考資料（doc/画像/動画）の解析結果は
Elasticsearch grounding（kind=context）と素材メタ（`materials.extracted_texts`）へ
正しく投入されるが、voice agent 側の消費経路に穴があり「資料に書いたことを
会話で再度聞かれる」症状が起きる。

1. **agent が読む保証がない**: 資料由来 chunk は `search_grounding` を agent が
   自発的に呼んだときにしか届かない。しかも初期 instructions には資料の一覧すら
   載らないため、agent は検索すべき対象の存在自体を知らない。ADR-0035 が準備
   フォームについて特定した穴と同型で、資料だけ「retrieval 任せ」のまま残っていた。
2. **事前アップロード分の能動注入が消える**: `analysis.visual`（ADR-0040 §4）は
   解析完了時点でルームに在室している agent にしか届かない。セッション開始前に
   解析が済んだ資料では誰も受信せず、能動的に触れられる機会が失われる。
   また doc（PDF/Office 等）はそもそも能動注入の対象外。
3. **UI の約束との乖離**: web は「中身を AI が読み取り、要件の抽出や確認に
   使います」（ヘルプ「参考資料」）と明示しており、読んでいない実装は
   ユーザーの信頼を毀損する。資料に書いたことを一度聞かれたユーザーは
   「アップロードは無意味」と学習し、以後資料を渡さなくなる。
4. **grounding バックエンド欠落がサイレント**: `ELASTICSEARCH_URL` 未設定・不通の
   構成では GroundingStore / ContextIndexer がプロセス内メモリへ縮退し、API/worker が
   索引した chunk は agent プロセスから一切見えないまま無警告で動き続ける。
   機能欠損が観測できない（CLAUDE.md 原則 3 に反する）。

## 決定
資料の解析結果を **agent 起動時に素材メタから読み、初期 instructions へ機械的に
シードする**（ADR-0035 のパターンを資料へ一貫適用する）。

1. **シード源は `materials.extracted_texts`（LLM 追加呼び出しなし）**: agent は
   `list_materials` で解析済み（status=done）素材を読み、ファイル名と
   `extracted_texts` を `<materials-context>` フェンス（`build_untrusted_fence`）で
   囲んで `VOICE_AGENT_INSTRUCTIONS` へ連結する。扱いの指示（既知の再質問を
   しない・発話と食い違えば矛盾として指摘する・詳細は `search_grounding`）を併記する。
   `extracted_texts` は web 表示用に生のまま保存されている（画像/動画の既存パターン）
   ため、LLM コンテキストへ流す前に読み取り側で PII をマスクする（索引経路の
   書き込み時マスクと同じ規律。`search_grounding` の返り値と露出面をそろえる）。
2. **シード上限は機械的に切る**: 1 素材あたり 600 字・全体 4,000 字。超過した
   素材は本文を載せずファイル名のみ列挙（上限 20 件 + 残数表記）し、`search_grounding`
   での深掘りへ誘導する（初期コンテキスト肥大による音声レイテンシ・コスト増を抑える）。
3. **doc アップロードも `extracted_texts` を保存する**: API の doc 経路は現状
   chunk を ES にのみ投入し素材メタへ本文を残していないため、抽出 chunk の先頭
   （上限 4,000 字）を `extracted_texts` として保存し、画像（API）・動画（worker）と
   形をそろえる。既存素材（保存前にアップロード済み）はファイル名のみのシードに
   フォールバックする。
4. **end_user モードにはシードしない**: 資料は owner/開発側が投入する内部素材で
   あり、利用者会話への露出遮断（ADR-0032 決定8・grounding allowlist）と揃える。
   セッション文書が読めずモードを確認できないときもシードしない（フェイルクローズ、
   repo 前提と同じ倒し方）。
5. **`context.progress` に source=materials を追加**: シードした素材数を会話開始時の
   セットアップバブルとして正直に表示する（実際に読み込んだときだけ出す。
   ADR-0023 §1 の規律）。web の contract（types/parse/表示）も対応する。
6. **grounding バックエンドは「起動時 fail-fast・実行中 fail-soft」**:
   `REQUIRE_ELASTICSEARCH=true`（本番環境で設定）のとき、agent worker・api・worker は
   起動時に ES へ到達できなければエラーで落ちる（設定漏れという直せる欠陥を
   サイレントに通さない）。実行中の ES 障害は従来どおり in-memory 縮退＋警告ログで
   会話を止めない（可用性はフェイルソフト）。ローカル・テスト（未設定時）は
   従来どおりフォールバックで動く。
7. **スコープはセッション単位のまま**: 資料の可視範囲は当該セッションに限る。
   product 横断の資料継承はスコープ外（必要になれば別 ADR）。
8. **会話中の doc アップロードも能動注入する（ADR-0040 §4 の対象拡大）**: 画像（API）・
   動画（worker）と同じく、doc の索引完了時にも `analysis.visual` を publish し、在室中の
   agent が既存の機会注入経路（非割り込み・`claim_video_injection` の dedup と end_user
   ゲート）で内容に触れられるようにする。新しい注入面は作らない（ADR-0037 の恒久ポリシー
   は不変）。イベントに載せる観察は朗読ではなく認識合わせ用の抜粋（先頭 3 件・各 300 字）
   とし、LLM コンテキストへ直行するため送信前に PII をマスクする。会話開始前のアップロード
   分は決定 1 のシードが担い、visual は会話中の投入分を担う（役割分担）。

## 検討したが採用しなかった選択肢
- **retrieval（search_grounding）のみで届ける現状維持**: 音声 LLM がツールを確実に
  呼ぶ保証はなく、存在を知らない資料への検索動機は生まれない。ADR-0035 が準備
  フォームで棄却済みの構図。
- **シード時に LLM 要約を生成する**: 追加呼び出しのコスト・レイテンシ・失敗面が
  増える。ADR-0028 の「機械的組み立て」の流儀に従い、既存の解析結果
  （extracted_texts）をそのまま使う。要約品質が足りない場合の LLM ダイジェスト化は
  効果測定後に別途判断する。
- **agent 起動時に ES から asset chunk を引き直す**: source 前方一致の fetch API を
  GroundingStore へ足す必要があり、ES 不通時にシードごと失われる。素材メタ
  （Firestore）を正とすれば既存の読み取りに相乗りでき、ES 縮退時もシードが生きる。
- **実行中も ES 必須（hard-fail）にする**: 会話中の一時障害でセッションが死ぬ。
  設定の正しさ（起動時）と可用性（実行時）で境界を分ける。
- **product 横断の資料継承**: 価値はあり得るが可視範囲・保持期間・削除伝播の設計が
  別論点として大きい。今回はスコープ外とする。

## 影響
- プロンプト退行ガードを `apps/agent/tests/test_prompts.py` に、モード分岐・
  フェイルクローズ・上限挙動を `apps/agent/tests/test_interview_mode.py` に追加する。
- doc 経路の `extracted_texts` 保存は `apps/api/tests` で検証する。
- 観測性: シード結果は `agent_instructions_built`（materials 件数を追加）と
  `context.progress`（source=materials）で追える。ES 未設定による縮退は既存アラートの
  フィルタ文字列と同じ `elasticsearch_unavailable_using_memory`（reason=not_configured）で
  警告し、Terraform のログベースメトリクス（`infra/terraform/observability.tf`）に
  そのまま載せる（新しいログ名を増やさない）。
- IaC: 本番の Cloud Run 環境変数に `REQUIRE_ELASTICSEARCH=true` を追加する
  （`infra/` の変更は別 PR・要レビュー）。デプロイチェックリスト
  （`docs/how-to/deploy-gcp.md`）に設定確認項目を追記済み。
- フォローアップ（本 ADR のスコープ外・ロードマップ）: ADK 分析
  （`analyze_transcript`）への資料ノート前置（inquiry `origin=material` の実働）、
  repo 前提の深化。
