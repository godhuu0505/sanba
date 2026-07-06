# sanba-worker

アップロード動画の非同期解析ワーカー（ADR-0040）。

Cloud Tasks から push された 1 動画を Gemini で解析し、観察をタイムスタンプ付きで
共有 grounding 索引（`sanba_shared.grounding`）へ投入して、素材メタを `analyzing` →
`done` / `failed` に更新する。エージェントは `search_grounding` 経由でその内容を要件の
深掘りに使える。

## 特性

- **冪等**: `materials.status` が `analyzing` のときだけ処理する（二重配信・再解析を無視）。
- **破棄競合安全**: Gemini 解析後・書き込み直前に material の存在を再確認し、解析中に
  破棄された素材を復活させない。
- **失敗確定**: 恒久エラー（実長超過・非対応）は即 `failed`。一時エラー（ES/GCS 障害）は
  `X-CloudTasks-TaskRetryCount` で最終試行を判定し、枯渇時にハンドラ内で `failed` 化する
  （Cloud Tasks は上限到達後にハンドラを呼ばないため）。
- **解析経路**: 本番 Vertex は `gs://` URI を Gemini に直接渡す。ローカル/GenAI API は
  bytes を inline で渡す（短尺前提。大きすぎるものは弾く）。

## エンドポイント

- `GET /health` — ヘルスチェック。
- `POST /tasks/analyze-video` — Cloud Tasks OIDC push 受け口。
  payload: `{session_id, asset_id, gcs_uri, content_type?, filename?, duration_seconds?}`。

## ローカル実行

```sh
uv sync
uv run uvicorn sanba_worker.main:app --reload --port 8080
uv run pytest -q
```

`GCS_BUCKET` / `ELASTICSEARCH_URL` / Gemini creds 未設定でも、in-memory フォールバックで
テストは通る（実 GCS/ES/Gemini 呼び出しは差し込みで単体テストから切り離している）。
