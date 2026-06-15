# E2E 疎通検証レポート（2026-06-15）

> 目的: 「コードはあるが本物の経路が一度も通っていない」リスクの切り分け。
> 何が**実際に動く**か、どこで **fallback に落ちる**かを記録し、残作業（Issue）に落とす。

## 1. ローカル静的検証（実施済み・全 PASS）

| 対象 | コマンド | 結果 |
|---|---|---|
| agent | `uv run ruff check` / `uv run pytest` | ✅ lint clean / **17 passed** |
| api | `uv run ruff check` / `uv run pytest` | ✅ lint clean / **24 passed** |
| web | `tsc --noEmit` | ✅ 型エラー無し |
| four-keys | `ruff` / `mypy` / `pytest` | ✅ clean / clean / **6 passed** |
| docker-compose | `docker compose config` | ⚠️ `.env` 必須（未作成）。定義自体は妥当 |

結論: **コード品質・型・単体テストは健全**。CI が守る範囲は信頼できる。

## 2. 実経路（本物）が通っていない箇所 — fallback トリガ一覧

すべての外部依存が「未設定なら graceful fallback」で実装されている。テストは通るが、
**以下は実 API/インフラを繋いだE2Eが一度も実行されていない**（= デモ当日の最大リスク）。

| 実経路 | fallback 条件 | 落ちる先 | 検証に必要なもの |
|---|---|---|---|
| Gemini Live S2S（音声対話の本体） | LiveKit/Gemini creds 無し | ワーカー起動せず | `GOOGLE_API_KEY` + LiveKit + 実機マイク |
| ADK マルチエージェント分析 | `google_api_key` 無し | ヒューリスティック近似 | Gemini key + `analyze_requirements` 実呼び出し |
| Firestore 永続化 | Firestore 未設定 | in-memory | emulator or 実 Firestore へ書き込み確認 |
| Elasticsearch RAG | ES 未起動 | 語の重なり近似 | ES 起動 + index/search 確認 |
| 埋め込み生成 | `google_api_key` 無し | なし（近似検索） | Gemini embeddings |
| LLM-as-a-judge 評価 | LLM 無し | ヒューリスティック採点 | Gemini key + Langfuse |
| Langfuse トレース | keys 無し | 送信スキップ | Langfuse keys |

## 3. 「とどける」軸の状態

- Cloud Run デプロイ URL: **未取得**（`deploy.yml` は `vars.GCP_PROJECT_ID` 未設定で skip）。
- → 審査軸「とどける」が現状 0 点。最優先で実デプロイ URL を作る必要がある。

## 4. ここから出てくる残作業（Issue 化）

1. `.env` を整備し `just up` でスタック全起動を一度通す（Phase 0 のチェック未消化）。
2. 実 creds で **1 経路だけ** E2E 疎通（Gemini Live + LiveKit + ADK 1 周 + Firestore 永続化）を録画。
3. Cloud Run へ実デプロイし公開 URL を得る（WIF + `GCP_PROJECT_ID`）。
4. fallback 起因の「見せかけ完成」を避けるため、実経路を通す統合テストを CI の任意ジョブに追加。

> 本レポートは静的検証まで。実 creds を伴う疎通は環境にシークレットが無いため未実施。
> 上記 1〜4 を Issue として起票し、Bootcamp 直後の集中実装期間で消化する。
