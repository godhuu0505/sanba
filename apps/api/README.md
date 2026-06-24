# apps/api — API（トークン発行・オーケストレーション）

**FastAPI** バックエンド。LiveKit の参加トークン発行、セッション CRUD、参考資料の取り込み（ingestion）、
成果物の書き出しを担う。ステートレスに保ち、状態は Firestore / Elasticsearch に永続化する。

- 言語/管理: **Python 3.12 / [uv](https://docs.astral.sh/uv/)**

## 構成

```
src/sanba_api/
  main.py          FastAPI アプリ・ルーティング・ヘルスチェック
  auth.py          署名付き招待トークン検証 / LiveKit 参加トークン発行（TTL・room スコープ）
  ingestion.py     参考資料の取り込み（チャンク化 → PII マスク → Elasticsearch 索引）
  pii.py           索引前 PII マスキング
  observability.py OpenTelemetry 計装（FastAPI instrumentation）
  config.py        環境変数（pydantic-settings）
tests/             pytest（auth / ingestion / api / pii）
```

## 開発

```bash
# リポジトリルートから（推奨）
just api-dev            # uvicorn --reload（:8080）

# このディレクトリでネイティブに回す
uv sync
uv run uvicorn sanba_api.main:app --reload --port 8080
uv run pytest
uv run ruff check . && uv run mypy .
```

ヘルスチェック: `GET http://localhost:8080/healthz`

## 主な環境変数

| 変数 | 用途 |
|---|---|
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 参加トークン発行 |
| `SESSION_SIGNING_SECRET` | 招待トークンの HMAC 署名（本番は Secret Manager の強い値） |
| `FIRESTORE_*` | セッション/要件 |
| `ELASTICSEARCH_URL` | 資料索引・RAG |
| `GOOGLE_API_KEY` / Vertex 設定 | 埋め込み生成 |
| `GOOGLE_OAUTH_CLIENT_ID` | Google ログイン ID トークン検証の aud（ADR-0012） |
| `ADMIN_EMAILS` | 管理画面 (`/admin`) を使える email 許可リスト（ADR-0014） |
| `ALLOWED_ORIGINS` | CORS 許可ドメイン |
| `REQUIRE_CONSENT` / `MASK_PII_BEFORE_INDEX` / `DATA_RETENTION_DAYS` | データガバナンス |

## 管理 API（ADR-0014）

`require_admin`（`ADMIN_EMAILS` 照合）でガードする運用エンドポイント。閲覧は requirements のみで、
生の発話（utterances）は返さない。

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/admin/sessions` | セッション一覧 |
| `GET` | `/api/admin/sessions/{id}/requirements` | セッションの要件一覧 |
| `PATCH` | `/api/admin/sessions/{id}/requirements/{rid}` | 要件の編集（statement/priority/category）・承認/却下 |

`.env.example` が正。アクセス制御・データ取り扱いは [`docs/security.md`](../../docs/security.md)。
