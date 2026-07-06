# ADR-0040: 資料アップロードの形式拡張と Google ドライブ取り込み

- ステータス: Accepted
- 日付: 2026-07-06

## コンテキスト
参考資料のアップロードは画像（PNG/JPG）と動画（MP4/MOV）が中心で、テキスト（txt/md/pdf）は
API 側にだけ経路があり web のピッカから選べなかった。要件の根拠になる資料は PRD・議事録・
仕様書・課題一覧などで、実務では Markdown/HTML/CSV/Office 形式、そして Google ドライブ上の
Google ドキュメント/スプレッドシート/スライドに置かれていることが多い。ADR-0007 では
Google Drive 連携を「保留」としていた（当時は OAuth スコープ運用の複雑さとデモ破綻リスクのため）。

## 決定
1. **ローカルアップロードの受理形式を拡張する**: 既存の PNG/JPG・MP4/MOV・txt/md/pdf に加え、
   `.markdown / .html / .htm / .csv / .json / .docx / .xlsx / .pptx` を受理する。
   - 抽出は API 側（`ingestion.extract_text_from_upload`）: HTML は stdlib `HTMLParser` で可視
     テキストのみ、docx/xlsx/pptx は `python-docx` / `openpyxl` / `python-pptx`。壊れたファイルは
     500 にせず空抽出（`indexed_chunks=0`）へ平す（best-effort）。
   - サイズ上限: プレーンテキストは従来どおり `max_context_chars×4` バイト、バイナリ文書
     （pdf/docx/xlsx/pptx）はバイト数≠文字数のため `max_asset_bytes`（25MB）で守り、
     抽出後テキストを `max_context_chars` で検査する。
2. **資料も素材（material）として一級化する**: 画像/動画と同じ content-hash の安定
   `asset_id`（`asset_kind="doc"`）を発番し、素材一覧（GET context/files）への永続化・
   DELETE での破棄（メタ+grounding 索引）・再投入の冪等化（同一資料は索引を張り替え）を揃える。
   binary は保存しない（grounding に必要なのは抽出テキストのみ）。
3. **Google ドライブ取り込みは `drive.file` スコープ + Google Picker**:
   - `drive.readonly`（全ファイル閲覧）は使わない。Picker でユーザーが選んだファイルだけに
     アクセス権が付く最小権限構成にし、Google のセンシティブスコープ審査を避ける。
   - Google ドキュメントは Markdown、スプレッドシートは xlsx（CSV は先頭シートのみのため）、
     スライドはテキストへ export し、それ以外（PDF 等）は `alt=media` でそのまま取得。
     取得はブラウザで行い、既存の `POST /context/file` に合流させる（API に Google の
     資格情報を渡さない・新規エンドポイント不要）。
4. **権限は Google ログインのタイミングで求める**: 明示ログイン（GIS `select_by != "auto"`）の
   直後に GIS OAuth トークンクライアントで `drive.file` の同意を求める。拒否・ポップアップ
   ブロック時は `driveGranted=false` とし Drive 取り込みは動かさない。その状態で「Google
   ドライブから選ぶ」を押した時に**再度同意を求める**（要件どおりの再同意 UX）。リロード時の
   静かな復元（`select_by="auto"`）ではポップアップを出さない（ユーザー操作なしではブロック
   されるため、操作時の再同意に委ねる）。
5. **アクセストークンはクライアント側メモリのみ**（ADR-0014 §7 の方針を踏襲）: localStorage
   や Firestore に保存しない。失効（約 1 時間）後の取り込みは同意済みなら軽い再取得で継続する。
   サーバ側 refresh token 保管（GitHub App 型）は、常時同期などの要件が出るまで採らない。

## リスクと緩和
- **同意ポップアップのブロック**: ログイン直後の自動要求はブロックされ得る → error_callback で
  `driveGranted=false` に確定し、取り込み操作（ユーザー操作起点）での再同意に必ず落ちる。
- **スコープのチェック外し**: 同意画面で drive.file を外して許可された場合はトークンを受け取らず
  未許可扱い（fail-closed）。
- **Picker には API キーが必要**: `NEXT_PUBLIC_GOOGLE_API_KEY` 未設定の環境では Drive 導線は
  「利用できない」案内に退化し、ローカルアップロードは影響を受けない。
- **Office 解析の失敗**: 壊れた/巨大ファイルは空抽出・413 に平し、アップロード全体を壊さない。
- **依存追加**（python-docx/openpyxl/python-pptx）: CI の pip-audit / Trivy の走査対象に入る。

## 影響
- `apps/api`: `storage.py`（許可リスト・`is_binary_document`）、`ingestion.py`（抽出関数群）、
  `main.py`（doc 経路の素材一級化・415/413 の整理）、依存 3 件追加。
- `apps/web`: `lib/api.ts`（`ACCEPTED_DOC`・`classifyFileUpload`・`UploadKind`）、
  `lib/auth.tsx`（`driveGranted` / `requestDriveAccess`）、`lib/googleDrive.ts`（Picker・
  export/download）、`EntryFlow` / `SessionView` / `MaterialSourceSheet` の配線。
- 環境変数: `NEXT_PUBLIC_GOOGLE_API_KEY`（Picker 用ブラウザキー）を追加。Google Cloud 側で
  **Google Drive API と Google Picker API の有効化**、API キーの HTTP リファラ制限を推奨。
- ADR-0007 の「Google Drive は保留」を解除する（本 ADR が優先する）。
