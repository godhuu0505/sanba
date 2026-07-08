import { expect, test, type Page, type Request } from "@playwright/test";


const API = "http://127.0.0.1:8799";
const TOKEN = "e2e-invite.sig";

const GUEST_JOIN_RESPONSE = {
  session_id: "sess-e2e1",
  invite: null,
  product_id: "prod-1",
  product_name: "経費精算アプリ",
  interview_mode: "end_user",
  join: {
    token: "lk-guest-token",
    livekit_url: "ws://127.0.0.1:9",
    session_id: "sess-e2e1",
    identity: "guest:e2e123",
    session_token: "guest-session-token",
  },
};

async function blockGis(page: Page) {
  await page.route("https://accounts.google.com/**", (route) => route.abort());
}

async function agreeConsent(page: Page) {
  const checkbox = page.getByRole("checkbox");
  const start = page.getByRole("button", { name: "深掘りを開始する" });
  await expect(async () => {
    if (!(await checkbox.isChecked())) await checkbox.click({ timeout: 1000 });
    await expect(start).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await blockGis(page);
});

test("未ログインでリンク → 同意 → Authorization なしで join → 会話開始画面へ", async ({
  page,
}) => {
  const joinRequests: Request[] = [];
  await page.route(`${API}/api/products/join`, async (route) => {
    joinRequests.push(route.request());
    await route.fulfill({ json: GUEST_JOIN_RESPONSE });
  });

  await page.goto(`/join/${TOKEN}`);

  await expect(page.getByText("リンクから会話に参加します")).toBeVisible();
  expect(new URL(page.url()).pathname).not.toContain("/login");

  await expect(page.getByText(/30 日たつと自動で削除/)).toBeVisible();
  await expect(page.getByText(/発行者の手元には残ります/)).toBeVisible();

  expect(joinRequests).toHaveLength(0);

  await agreeConsent(page);
  await page.getByRole("button", { name: "深掘りを開始する" }).click();

  await expect(page.getByText("準備ができました")).toBeVisible();
  await expect(page.getByText("経費精算アプリ")).toBeVisible();

  expect(joinRequests).toHaveLength(1);
  expect(await joinRequests[0].headerValue("authorization")).toBeNull();
  expect(joinRequests[0].postDataJSON()).toEqual({
    token: TOKEN,
    consent_acknowledged: true,
  });
});

test("flag off（401）はログイン誘導へフォールバックする", async ({ page }) => {
  await page.route(`${API}/api/products/join`, (route) =>
    route.fulfill({ status: 401, json: { detail: "authentication required" } }),
  );

  await page.goto(`/join/${TOKEN}`);
  await agreeConsent(page);
  await page.getByRole("button", { name: "深掘りを開始する" }).click();

  await expect(page.getByText("参加にはログインが必要です")).toBeVisible();
  await expect(page.getByRole("button", { name: "深掘りを開始する" })).toHaveCount(0);

  await page.getByRole("button", { name: "ログインして参加する" }).click();
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(`/join/${TOKEN}`)}`));
});
