import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:3100",
  },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: "e2e-dummy.apps.googleusercontent.com",
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:8799",
    },
  },
});
