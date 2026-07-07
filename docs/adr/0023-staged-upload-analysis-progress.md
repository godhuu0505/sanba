# ADR-0023: アップロード素材の解析進捗（analysis.progress / analysis.visual）の発行設計

- ステータス: Accepted（2026-07-05・#287 で実ルーム publish のスモークテストを実施し確定）
- 日付: 2026-06-28
- 関連: #145（analysis.progress / analysis.visual の publish）/ #143（05 参考資料の進捗表示）/
  #287（実ルーム publish スモークテスト・`enable_realtime_publish` 本番 ON）/
  ADR-0004（マルチモーダル入力）/ ADR-0021（reliable-seq・seq 永続化）/ 契約 `docs/reference/realtime-contract.md` §3,§5
- 下敷き: ADR-0008（中核＝矛盾・抜け検知）/ ADR-0018（会話体験・05 参考資料は会話を止めない）

## コンテキスト

05 参考資料は「アップロード → 背景解析（進捗インライン）→ 詳細/要件絵巻へ反映」を AC にしている（ADR-0018 §5）。
契約 §3 は `analysis.progress(asset_id, pct, stage)` と `analysis.visual(asset_id, extracted, conflicts)` を定義し、
web（`store.ts`/`MaterialsList`）は asset_id で素材行へ対応付けて描画できる状態にある。

しかし現状、**アップロード素材の解析はこれらのイベントを live で発行していない**:

- アップロードは **API** が処理する（`apps/api/src/sanba_api/main.py` `add_context_file`）。画像は `vision.analyze_image`
  で **Gemini を 1 回呼ぶ**だけ（領域検出→OCR→突合のような多段パイプラインは存在しない）。結果は
  `material_record(status="analyzing"/"done", extracted=N)` として保存し、`ContextResponse` を返す。
- **realtime を publish できるのは agent だけ**（`apps/agent` の `EventPublisher`）。API は LiveKit トークン発行のみで
  データチャネルへ publish する経路を持たない。agent 側の `analysis.visual` は会話中の画面共有
  （`note_visual_requirement`）から **1 ショット**で出るだけで、アップロード素材には対応しない。
- そのため web はアップロード解析の状態を **live 差分ではなくハイドレーション GET（#184）** でしか取得できず、
  「進捗インライン（pct が伸びる）」体験が出せない。

加えて #145 の文言「段階化（領域検出→OCR→突合）」を額面どおり実装すると、**実体のない中間段階を捏造**する
ことになり、CLAUDE.md「指標をハックしない／本番志向」に反する。

## 決定

### 1. ステージは「実体に正直」な粗い段階にする（捏造しない）
- 現行の解析は単発 Gemini 呼び出しなので、ステージは **`received` → `analyzing` → `done` / `failed`** とする。
  pct はこの境界に対応（受領=10 → 解析中=50 → 完了=100 等の意味のある値）。
- 「領域検出 / OCR / 突合」のような細分ステージは、**実際に多段 CV パイプラインを実装したときに限り**追加する
  （その時点で本 ADR を改訂）。現時点でフェイクの中間 pct は出さない。
- #143 の 05 行 UI は、この**正直なステージ**（受領/解析中/完了/失敗）を表示する。3 段チェックリストは
  多段パイプライン実装後に対応する。

### 2. publish 経路 = API に最小の LiveKit データ送信を持たせる（採用案）
- API（解析の実行主体）が、解析の境界で `analysis.progress` を、完了時に `analysis.visual` を
  **LiveKit データチャネル（topic `sanba.events`、reliable）** へ直接 publish する。**サーバ identity**
  （`can_publish` のみ・`can_subscribe` 不要のトークン）で送る。
- 利点: 解析を持つ API がそのまま進捗を出せる。agent を経由しない（疎結合）。既存の realtime 契約・web 受信
  （`parse.ts`/`store.ts`）をそのまま使える。
- seq: アップロード解析イベントも **ADR-0021 の reliable-seq 規約**に従う（ギャップ検知が壊れないよう、
  seq の採番・永続化は ADR-0021 の決定に合わせる）。本 ADR は ADR-0021 を前提とする。
- `analysis.visual` の `extracted` は `analyze_image` の観察文、`conflicts` は「言葉×画の矛盾」（ADR-0004。
  当面は空配列でも可、後続で突合を実装）。

### 3. 失敗とフォールバック
- 解析失敗時は `analysis.progress(stage="failed")` を出し、web は 05 行に再試行導線を出す（既存 #219 と整合）。
- creds 未設定/ローカルでは `analyze_image` が空配列を返す現挙動を維持し、`stage="done", extracted=0` とする
  （落とさない）。LiveKit 未接続時は publish を no-op にする（API 本処理を止めない）。
- **ルーム未確立時の publish 404 は許容し、room 事前生成もリトライもしない（対応不要）**。LiveKit の
  ルームは参加者が接続している間だけ存在するため、誰も接続していない瞬間の `RoomService.send_data` は
  `404 requested room does not exist` になる（本番 #287 で観測）。これは失敗ではなく **fail-open が正しく
  働いている状態**であり、以下の理由から追加のハードニングはしない:
  - **404 が起きる時＝受信者が誰もいない時**。ルームが無い＝ブラウザが subscribe していない、なので
    `create_room` で 404 を潰しても「誰も受け取らないルームへ配信する」だけで実利がない。逆にブラウザが
    接続していればルームは存在し 404 は起きない。
  - publish はアップロード要求内で `await` されるため、リトライを挟むと**アップロード応答をブロック**する。
    接続レースを拾える窓は 1 秒未満と狭く、レイテンシ悪化に見合わない。
  - 取りこぼした live は **GET context/files のハイドレーション（本 ADR の二層目）が必ず復元**する。素材・
    抽出観察・grounding 投入は publish 成否に依存せず成立する（#287 で `asset_analyzed` を実機確認）。
  - 影響は「入室直後の極早アップロードで進捗アニメが出ないことがある」程度で、ADR-0018 §5 の想定フロー
    （会話中＝ルーム稼働中の素材投入）では基本発生しない。

## 理由 / 検討した代替案
- **採用（API が直接 publish）**: 解析の所在（API）と publish を一致させ、最短で live 進捗を出せる。サーバ
  identity の最小トークンで安全に publish できる。
- **agent 経由で publish（却下）**: API→agent のシグナリング（Firestore/pub-sub）が要る。結合とレイテンシが増える。
  会話を駆動する agent に解析 I/O を負わせる必要もない。
- **live を出さず GET ハイドレーションのみ（却下）**: 実装は最小だが ADR-0018 §5「進捗インライン」を満たせず、
  「会話を止めずに解析が進む」体験が出ない。ただし **#184 の GET は再接続復元の土台として併存**させる
  （live は差分、GET はスナップショット。契約 §5 の二層）。
- **フェイク多段ステージ（却下）**: 実体のない pct を出すのは規約違反。正直な粗ステージにする。

## 検証（#287・2026-07-05）

`LiveKitServerSender`（RoomService.send_data）は導入以来 introspection/モックのみで実ルーム疎通が未検証だったため、
本番 ON 前に以下を確認した（ローカル、実 LiveKit server（`livekit/livekit-server:latest --dev`）・
API はネイティブ起動・`enable_realtime_publish=true`）。

- **実ルーム publish**: LiveKit ルームへ実際に参加した購読者（`livekit.rtc.Room`、topic `sanba.events`）が、
  アップロード解析フロー（画像アップロード → `received`→`analyzing`→`analysis.visual`）の 3 イベントを
  契約どおりのエンベロープ（`v/type/seq/ts/session_id` + 各イベント固有フィールド）で受信できることを確認した。
  `seq` は ADR-0021 の共有空間から単調増加。
- **fail-open**: LiveKit server を停止した状態でも `POST context/file` は 200 を返し、アップロード本処理
  （保存・解析・素材一覧への反映）は継続した。API ログには `analysis_publish_failed`（`sent=False`）が
  出るのみで例外は外に漏れない（`AnalysisPublisher._emit` の握り潰しが実際に機能）。
- **web 受信の確認範囲**: ブラウザ/Next.js UI を自動操作するツールが本セッションに無かったため、実ブラウザ経由の
  確認は未実施。代わりに、web が実際に読む契約（`apps/web/lib/realtime/parse.ts` の
  `analysis.progress`/`analysis.visual` 必須フィールド）と、上記で実際に受信したエンベロープの形が一致することを
  確認した（フィールド名・型は完全一致）。ブラウザでの目視確認は別途行うことを推奨。
- **CI/ローカル既定への影響**: `enable_realtime_publish` を既定 `True` に変更後も、LiveKit 未接続（CI・LiveKit
  コンテナ未起動時）では `send_data` が接続失敗し警告ログになるだけで、`apps/api` の既存テスト（200 件）は
  タイミング悪化なく全て通過することを確認した（接続失敗はローカルホストへの即時 refused のため待ちが発生しない）。

## 影響 / 移行
- **API**: LiveKit データ publish のヘルパ（サーバ identity・reliable・topic `sanba.events`）を追加し、
  `add_context_file` の境界で `analysis.progress`、完了で `analysis.visual` を発行（#145）。観測性: publish に
  span/log（`asset_id`/`stage`、CLAUDE.md 原則3）。
- **契約**: `realtime-contract.md` §3 に「アップロード解析も同イベントで live 発行（送信元=API サーバ identity）」を明記。
- **web**: 既存 `store.ts`/`MaterialsList` を流用。#143 は正直なステージ表示へ（フェイク 3 段は出さない）。
- **依存**: 本 ADR は **ADR-0021（reliable-seq）を前提**とする（seq 採番・ギャップ整合のため）。実装順は
  ADR-0021 → 本 ADR（#145）→ #143。
- 本 ADR は提案中。最終判断は人間レビューを経て Accepted とする（CLAUDE.md 原則1）。
