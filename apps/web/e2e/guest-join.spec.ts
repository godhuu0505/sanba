import { expect, test, type Page, type Request } from "@playwright/test";

// ゲスト入場 E2E（FR-2.1 / FR-2.2）。
// 未ログイン（シークレットウィンドウ相当）でリンク → 同意 → 会話開始画面まで到達すること、
// flag off の 401 でログイン誘導へフォールバックすることを実ブラウザで検証する。
// API は page.route でモックする（use_count 消費・LiveKit 接続はここでは扱わない）。

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
  // 未ログイン状態を確定させる: GIS スクリプトを遮断し、auth 側のフォールバック
  // （settle タイマー）で ready=true / loggedIn=false に落ち着かせる。
  await page.route("https://accounts.google.com/**", (route) => route.abort());
}

/**
 * 同意チェック → 開始ボタンの有効化まで待つ。
 * next dev の SSR → hydration の間に入ったクリックは React state（consent）に反映されず、
 * hydration 後の再描画でチェックが外れる。チェック状態と有効化を確認しながら再試行する
 * （認証 settle（約 2.5 秒）待ちもこのポーリングが吸収する）。
 */
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

  // ログインへ飛ばされず、同意ゲートが出る（FR-2.1）。
  await expect(page.getByText("リンクから会話に参加します")).toBeVisible();
  expect(new URL(page.url()).pathname).not.toContain("/login");

  // 同意文言: 30 日自動削除と発行者側に残る旨を明示（FR-2.2 / FR-2.7）。
  await expect(page.getByText(/30 日たつと自動で削除/)).toBeVisible();
  await expect(page.getByText(/発行者の手元には残ります/)).toBeVisible();

  // 表示しただけでは join を呼ばない（use_count を消費しない）。
  expect(joinRequests).toHaveLength(0);

  // 同意 → 開始（hydration・認証 settle 後の有効化を待って押す）。
  await agreeConsent(page);
  await page.getByRole("button", { name: "深掘りを開始する" }).click();

  // 会話開始画面（03 開始前サマリ）に到達 = join 済み・LiveKit 接続直前まで。
  await expect(page.getByText("支度、相整いまして")).toBeVisible();
  await expect(page.getByText("経費精算アプリ")).toBeVisible();

  // join は 1 回だけ・Authorization ヘッダなし・同意 true（ゲスト経路の契約）。
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

  // 利用者向け文言（技術用語なし）でログインへ誘導。開始 UI は出さない。
  await expect(page.getByText("参加にはログインが必要です")).toBeVisible();
  await expect(page.getByRole("button", { name: "深掘りを開始する" })).toHaveCount(0);

  await page.getByRole("button", { name: "ログインして参加する" }).click();
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(`/join/${TOKEN}`)}`));
});
