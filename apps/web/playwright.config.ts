import { defineConfig } from "@playwright/test";

// E2E（PR9 / FR-2.1）: 未ログイン（シークレットウィンドウ相当）のゲスト入場フローを
// 実ブラウザで検証する。API はテスト内の page.route でモックする（LiveKit サーバや
// バックエンド常駐を要求しない・CI でも回せる最小構成）。実バックエンド結合の E2E は
// docs/design/product-enduser-implementation-plan.md §5 のとおり別レイヤで拡張する。
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  use: {
    // Next 16 は dev リソースへのクロスオリジンアクセスを既定で遮断する（allowedDevOrigins）。
    // 127.0.0.1 だと hydration 用チャンクが弾かれるため、サーバと同じ localhost で開く。
    baseURL: "http://localhost:3100",
  },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // real 認証モードにする（devMode だと authGate/ゲスト分岐が素通しになるため）。
      // GIS スクリプトはテスト側で遮断し、「未ログインで settle」させる。
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: "e2e-dummy.apps.googleusercontent.com",
      // 実在しない宛先。実リクエストは page.route が全て捕捉する（誤爆防止）。
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:8799",
    },
  },
});
