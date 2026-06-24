# 09 結果（要件絵巻）

- **優先度**: P0（核の成果物・未実装）
- **Figma 正本**: node `31:261`（09 結果・要件絵巻）

## 目的
セッションの成果物。確定要件を MoSCoW で構造化し、検知（矛盾解消・抜け発見）の実績とともに一覧する。
ループを閉じる起点として **GitHub Issue 書き戻し**（ADR-0007）へ接続する。

## UI 要素（Figma 由来）
- ヘッダ: 戻る `‹` + 「要件絵巻」+ 巻物アイコン。
- サマリ行: 「検索機能リニューアル · 確定12 · 検知6」。
- スタッツ 3 連: 「2 矛盾解消」/「4 抜け発見」/「6 Issue化」。
- 要件リスト（MoSCoW セクション）:
  - 「Must 必須」: 例「キーワード検索を新設し…」（タグ「境界」）。
  - 解消メモ: 「並び順は関連度順を既定（新着は切替）」（タグ「解消」）。
  - 「Should 望ましい」: 例「『該当なし』の空状態を設計する」（タグ「境界」）。
- 主 CTA: **「⎘ GitHub Issue を奉る（6件）」**（Figma 古語→現代語「GitHub Issue を作成（6件）」）。

## 状態 / 遷移
- データ: `requirement.upserted`（category=must/should/could/wont, confidence, source, citations, status）。
- グルーピング: MoSCoW でセクション化。各要件にタグ（境界/解消 等）と出所・確信度を併記。
- 遷移: Issue 作成 CTA → 起票実行 → 10 完了（Issue URL を引き渡す）。

## 連携（ハイドレーション必須）
- **接続/リロード時**: `GET /api/sessions/{id}/requirements`（P0・新規）でスナップショット → `requirement.upserted` で差分。
- Issue 化: `POST /api/sessions/{id}/export`（**P1・新規**）→ agent の `export_requirements_to_github` を起動し
  `{issue_url, doc_url}` を返す。件数（6件）は確定要件数と一致させる。

## 受け入れ基準（AC）
- [ ] 確定要件が MoSCoW（Must/Should/Could/Won't）でグルーピングされ、件数サマリと一致する。
- [ ] 各要件に出所（誰の発話／素材）と確信度が併記される（ADR-0008 #3）。
- [ ] 「矛盾解消 / 抜け発見 / Issue化」のスタッツが実データと一致する。
- [ ] Issue 作成 CTA で `POST /export` が走り、成功で 10 完了へ Issue URL を渡す。失敗時はエラー＋再試行。
- [ ] リロードしてもボードが復元される（GET ハイドレーション）。
- [ ] コピーは現代語（「奉る」等の古語はデモ演出として不採用）。

## 現状差分
- **未実装**。agent に `export_requirements_to_github` はあるが web から起動する経路・要件ボード UI が無い。
- 要件として `GET /requirements`・`POST /export` の追加を伴う。

## 根拠
壁打ちの最終成果物であり、要件→実装の地続き化（ADR-0007）の起点。核の出口として P0。
