# ADR-0040: アップロード動画の非同期解析パイプライン（GCS + Cloud Tasks + 専用ワーカー）

- ステータス: Accepted（`apps/worker` 実装・`infra/terraform/media.tf` によるインフラ定義は完了。
  `.github/workflows/deploy.yml` の CD 配線は未対応 — 手動デプロイが必要。詳細は下記フォローアップ参照）
- 日付: 2026-07-06
- 関連: ADR-0004（マルチモーダル入力）/ ADR-0023（解析進捗の発行設計）/ ADR-0003（Elasticsearch grounding）/
  ADR-0037（背景先読み・注入方針）/ 契約 `docs/reference/realtime-contract.md` §3
- 実装計画: [`docs/notes/video-and-screen-analysis-implementation-plan.md`](../notes/video-and-screen-analysis-implementation-plan.md)

## コンテキスト

セッション中の動画アップロードは UI・保存・素材メタ永続化まで実装済みだが、**解析が存在しない**。

- `apps/api/src/sanba_api/main.py` `add_context_file` の動画分岐（`kind == "video" and not settings.enable_video_analysis`）は
  保存のみで `analysis_pending=True` を返す。`enable_video_analysis` の解析側実装は**無い**（フラグだけが先行）。
- grounding 索引に何も入らないため、エージェントは動画の内容に一切到達できない。素材 UI は永遠に「解析中」のまま。
- 本番は `GCS_BUCKET` 未設定のため `AssetStore` が in-memory フォールバックで動いており、**素材そのものがインスタンス再起動で消える**
  （`docs/reference/architecture.md` にも素材バケット未プロビジョニングと明記）。
- Terraform には GCS バケット・Cloud Tasks・Pub/Sub・Cloud Run Job のいずれも無く、非同期処理基盤はゼロ。

画像は `analyze_image` → `index_context(source="asset:{id}")` → `search_grounding` の経路が既に通っており、
動画だけが取り残されている。要件深掘りの入力として動画（操作録画・バグ再現・モックのウォークスルー）を使えるようにしたい。

想定する動画は**短い画面録画（〜5分程度）**。上限は 10 分 / 200MB とし、超過は明示的にエラーで弾く（下記）。

## 決定

### 1. インフラ（Terraform 新設）

- **GCS バケット**（セッション素材用）: uniform bucket-level access・非公開。オブジェクトの lifecycle 削除は
  Firestore `materials` の TTL（`expireAt`）と揃えた保持期間にする。`AssetStore` は既存実装のまま
  `GCS_BUCKET` を Cloud Run env に配線するだけで GCS 保存へ切り替わる（画像も恩恵を受ける）。
- **Cloud Tasks キュー** `video-analysis`: HTTP push・OIDC 認証・リトライ上限つき。dispatch deadline は
  ワーカーの想定処理時間より長く設定する（下記 timeout と揃える）。
- **専用ワーカーサービス** `apps/worker`（Cloud Run service・非 root・最小ベース）: Cloud Tasks からの
  push を受ける FastAPI。invoker は Cloud Tasks 用 SA のみに限定。SA 権限は最小
  （バケット read / Firestore / Vertex AI / Elasticsearch 接続）。**request timeout は既定 5 分のままにせず**、
  10 分動画の解析（Gemini 呼び出し込み）が収まる値（15 分目安）を明示的に設定する。
- **API SA のバケット権限は書き込みだけでなく list/delete も含める**: 既存の
  `DELETE /context/file/{asset_id}` が `AssetStore.delete()` で GCS の prefix list + blob delete を
  実行するため、書き込みのみだと素材破棄が GCS 実体だけ失敗する。

API 同居ではなく専用サービスにするのは、解析（LLM 呼び出しで数十秒〜分オーダー）のレイテンシ・リソース特性が
API と異なるためと、将来の中尺動画・セグメント分割解析への拡張点を分離しておくため。

### 2. アップロード経路と解析フロー

**動画はブラウザから GCS へ直送する（署名付き resumable URL）。** 現行の `POST /context/file`
（multipart）経路は使えない: Cloud Run の HTTP/1 request body 上限は 32MiB であり、200MB の動画は
FastAPI に届く前に弾かれる。画像（≦25MB）は既存の multipart 経路を維持する。

```
API: upload-init（署名付き resumable URL 発行 + materials(status=uploading)）
  → ブラウザ → GCS 直送（x-goog-content-length-range で 200MB を強制）
  → API: upload-complete（オブジェクト検証 → materials(status=analyzing) → Cloud Tasks enqueue）
  → worker: 実長・サイズ検証 → Gemini 2.5 Flash 動画理解（映像+音声）
  → タイムスタンプ付き観察チャンク → index_context(source="asset:{id}")
  → materials(status=done, extracted=N) → analysis.progress / analysis.visual publish
```

- **抽出内容**: ①音声の転写（発話単位）②画面・シーンごとの観察（UI 要素・操作フロー・ドメイン用語）
  ③要件候補・矛盾候補。すべて `MM:SS` タイムスタンプ付きチャンクで grounding へ投入し、既存の
  `search_grounding` にそのまま乗せる。
- **モデル呼び出し**: 本番（`GOOGLE_GENAI_USE_VERTEXAI=true`）は `gs://` URI を直接 `Part.from_uri` で渡す。
  ローカル/GenAI API 経路は Files API（または 20MB 未満は inline bytes）でフォールバック。
- **上限は kind 別に持つ**: 動画 200MB（署名付き URL の `x-goog-content-length-range` + ワーカー検証で強制）、
  画像は既存 `max_asset_bytes`（25MB）を維持する。単一設定の引き上げで画像側のメモリ/コストガードを
  壊さない。実長 10 分はワーカーで検証。超過は `status=failed` + 理由付きで UI に返す。
  フェイクの中間ステージは出さない（ADR-0023 の「実体に正直」を踏襲）。
- **`asset_id` の導出**: 直送では API がバイト列を経由しないため、既存 `compute_asset_id`（内容ハッシュ）は
  そのまま使えない。upload-complete 時に GCS オブジェクトのメタデータ（md5/crc32c）から導出して
  冪等性の性質を保つ。

### 3. 冪等性・失敗

- Cloud Tasks の task 名は **`session_id` + `asset_id` 由来**にして重複 enqueue を排除する。
  `asset_id` は内容ハッシュのため、同じ動画を別セッションでアップロードすると同一になる —
  `asset_id` 単独を task 名にすると 2 件目のセッションの解析が重複扱いで抑止され、
  `analyzing` のまま取り残される。ワーカーは処理前に `materials.status` を確認して二重解析をスキップする。
- **破棄済み素材を復活させない**: 解析中にユーザーが `DELETE /context/file/{asset_id}` で素材を破棄した場合、
  ワーカーが Gemini 呼び出し後にそのまま書き込むと削除済みの素材と grounding が復活する。
  `save_material` / `index_context` の**書き込み直前にも material の存在を再確認**し、
  消えていれば結果を破棄して正常終了する。
- **リトライ枯渇時の失敗確定はハンドラ内で行う**: Cloud Tasks は試行上限到達後にハンドラを再呼び出しせず
  タスクを削除するため、「枯渇したら failed にする」コードの置き場所が無い。ワーカーは失敗を自前で捕捉し、
  恒久エラー（上限超過・非対応形式等）は即 `status=failed` を永続化して 2xx を返し、一時エラーは
  `X-CloudTasks-TaskRetryCount` ヘッダで最終試行を判定して**最終試行なら failed 化してから** 2xx、
  それ以外は 5xx でリトライさせる。取りこぼしの保険として、`analyzing` のまま長時間経過した素材を
  failed 化するリーパー（ハイドレーション時の reconcile）も置く。
- 失敗確定時は `analysis.progress(stage="failed")` を publish（web の再試行導線と整合）。
  publish は ADR-0023 どおり fail-open（本処理を止めない）。

### 4. エージェントへの能動注入（RAG + プッシュ）

grounding 投入（受動・RAG）だけでは「エージェントが検索しようと思ったときにしか使われない」ため、
解析完了時に**エージェント側から深掘りを打てる**ようにする。

- ワーカーは ADR-0023 のサーバ identity パターンで `analysis.visual`（要約・要件候補・矛盾候補）を
  LiveKit データチャネルへ publish する。
- agent は room 参加者として topic `sanba.events` の `analysis.visual`（source が `asset:` のもの）を購読し、
  ライブセッションの会話コンテキストへ「アップロードされた動画の解析結果」として注入する。エージェントは
  これを受けて「動画を拝見しました。◯◯の画面遷移についてですが…」と深掘り質問を生成する。
- ルームが既に閉じている場合は注入をスキップする（grounding には入っているので、次回セッションや
  ハイドレーションで参照可能。取りこぼしを failure 扱いしない）。

## 理由 / 検討した代替案

- **採用（GCS + Cloud Tasks + 専用ワーカー）**: 本番志向（CLAUDE.md 原則2）。リトライ・冪等性・観測性を
  最初から確保し、素材の in-memory 消失も同時に解消する。短尺前提なら 1 タスク = 1 Gemini 呼び出しで収まり、
  Cloud Run のタイムアウト内で完結する。
- **API プロセス内 asyncio タスク（却下）**: 基盤追加なしで最速だが、Cloud Run インスタンス終了で解析が
  黙って消える。永続キューが無く「解析中のまま放置」という現状のバグを別の形で再生産する。
- **API サービスに同居した Tasks ハンドラ（却下）**: デプロイ単位は増えないが、解析の重い処理特性が
  API のオートスケール・レイテンシに干渉する。将来の長尺対応の分離点も失う。
- **Pub/Sub（却下）**: fan-out 不要・単一コンシューマなので、per-task リトライ制御と重複排除が素直な
  Cloud Tasks が適合。
- **Cloud Run Job（却下）**: 起動レイテンシが大きく、短尺動画の「会話中に解析が返ってくる」体験に不利。
- **Gemini Live へ動画ファイルを流す（却下）**: Live はリアルタイム対話経路であり、保存済みファイルの
  バッチ解析には不適。転写・タイムスタンプ付き構造化出力も得にくい。

## 影響 / フォローアップ

- **Terraform**: バケット・キュー・ワーカーサービス・SA/IAM・env（`GCS_BUCKET` / `ENABLE_VIDEO_ANALYSIS` /
  キュー名・ワーカー URL）を追加。infra 変更は必ずレビュー（CLAUDE.md）。
- **観測性（原則3）**: 既存パターンを踏襲 — OTel span（`sanba.asset.*` 属性）、メトリクス
  `sanba_video_analysis_total{result}` と処理時間ヒストグラム、structlog、Gemini 呼び出しの Langfuse トレース。
- **テスト**: 単体（enqueue 分岐・上限検証・チャンク整形）、結合（worker ↔ Firestore/grounding、モック Gemini）、
  E2E（アップロード → done → `search_grounding` で引ける）。LLM 出力は Langfuse 評価データセットに動画解析
  ケースを追加して回帰させる。
- **web**: `MaterialsList` の `analyzing` → `done`/`failed` 遷移は既存実装がそのまま生きる。
  上限超過エラーの文言追加のみ。
- **ADR-0023 改訂候補**: 動画解析は実体のある多段（受領→解析→索引投入）になるため、ステージ細分を
  この時点で正式に追加する。
- **CI/CD**: `apps/worker` は `.github/workflows/ci.yml` に lint/test ジョブがあるが、
  `.github/workflows/deploy.yml` の `paths-filter` と手動デプロイ対象には未追加。
  Terraform でサービスは既に作成されるため、コード変更が自動デプロイされない状態。追って対応する。
