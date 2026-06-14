# ADR-0003: Elasticsearch による RAG 根拠付けと過去セッション検索

- ステータス: Accepted
- 日付: 2026-06-14

## コンテキスト
要件インタビューの質を上げるには、エージェントの問いに「根拠」を持たせ、かつ過去の
類似セッションの知見を再利用したい。スポンサー任意技術の **Elasticsearch** を使う。
これは審査員 佐藤一憲氏が重視する *Agentic RAG with Vector Search* / *Generative
Recommendation* の文脈にも合致する。

## 決定
Elasticsearch を 2 用途で使う。

1. **RAG 根拠付け (grounding)**: 要件定義のベストプラクティス/チェックリスト(非機能要件・
   セキュリティ・MoSCoW 等)をインデックス化し、エージェントが問いの根拠として **引用元つき**で
   提示する。`search_grounding` ツールで取得。
2. **過去セッション検索**: 過去の発話・確定要件をインデックス化し、「以前似た議論をしましたよね」
   と能動的に呼び戻す(Generative Recommendation 的な能動提案)。

検索は **ハイブリッド** = BM25(全文) + kNN(Gemini `text-embedding-004` の dense_vector,
cosine)。Elasticsearch 非接続時は語の重なりスコアの in-memory フォールバックで動作し、
テストとローカル開発を止めない。

## 検討したが採用しなかった選択肢
- **Vertex AI Vector Search**: 強力だが、全文(BM25)とベクトルのハイブリッド・引用元管理・
  運用UIを 1 つでまかなえる Elasticsearch の方が「根拠付け+検索」の要件に素直。スポンサー
  技術の加点もある。
- **Firestore だけで類似検索**: ベクトル検索に最適化されておらず、根拠提示には不足。

## 影響
- `apps/agent/src/kikitori_agent/retrieval.py` に `GroundingStore` を追加。
- 確定要件・発話をインデックスし、`search_grounding` ツールで根拠/過去事例を返す。
- 本番では知識ベースを一度だけ投入する seeding ジョブが必要(per-room seeding は重複の元)。
- docker compose に `elasticsearch` を追加。本番は Elastic Cloud もしくは GKE 上の ECK を想定。
