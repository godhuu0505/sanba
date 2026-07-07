# apps/web — Web クライアント

**Next.js (App Router) / TypeScript** のフロントエンド。LiveKit ルームへの参加、音声の送受、
確定要件の可視化を行う。**LiveKit React Components** を利用。

## 構成

```
app/
  page.tsx     ルーム参加 UI / 音声セッション
  layout.tsx   ルートレイアウト
lib/
  api.ts       API（apps/api）への呼び出し（トークン取得など）
public/        静的アセット
```

## 開発

```bash
# リポジトリルートから（推奨）
just web-dev            # next dev（:3000）

# このディレクトリでネイティブに回す
npm install
npm run dev             # http://localhost:3000
npm run lint            # eslint
npm run typecheck       # tsc --noEmit
npm run build           # 本番ビルド
```

## 主な環境変数

| 変数 | 用途 |
|---|---|
| `NEXT_PUBLIC_API_URL` | API（apps/api）のベース URL |
| `NEXT_PUBLIC_LIVEKIT_URL` | LiveKit の WebSocket URL |

`.env.example` が正。`NEXT_PUBLIC_*` はブラウザに露出するため、秘密情報を入れない。

## UX 方針

- セッション参加は**同意チェック**でゲートする（録音・AI 処理への明示的同意。[`docs/reference/security.md`](../../docs/reference/security.md)）。
- 本番品質 UX を Cloud Run で提供する（[ADR-0001](../../docs/adr/0001-tech-stack.md)）。
- 画面共有 / モック映像の共有 UI は Phase 2（[`docs/explanation/roadmap.md`](../../docs/explanation/roadmap.md)）。
