import { defineConfig } from "@playwright/test";

const PORT = 3210;

export default defineConfig({
  testDir: ".",
  testMatch: /screenshots.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: "",
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:8799",
      NEXT_PUBLIC_RETENTION_DAYS: "30",
    },
  },
});
