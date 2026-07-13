import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { test, type Page } from "@playwright/test";

const OUT = resolve(process.cwd(), "screenshots");

type Shot = { name: string; url: string; tab?: string; buttons?: string[] };

const shots: Shot[] = [
  { name: "conv-01-listening", url: "/design/conversation?upto=2&mic=on" },
  { name: "conv-02-contradiction", url: "/design/conversation?upto=5&mic=on" },
  { name: "conv-03-agent-speaking", url: "/design/conversation?upto=4&speaking=1" },
  { name: "conv-04-active", url: "/design/conversation?upto=12&mic=on" },
  { name: "conv-05-requirements-tab", url: "/design/conversation?upto=12", tab: "要件一覧" },
  { name: "conv-06-materials-tab", url: "/design/conversation?upto=12", tab: "参考資料" },
  { name: "conv-07-end-confirm", url: "/design/conversation?upto=12", buttons: ["会話を終了"] },
  { name: "conv-08-result", url: "/design/conversation?upto=12", buttons: ["会話を終了", "終了する"] },
];

const viewports = [
  { device: "pc", width: 1440, height: 900 },
  { device: "mobile", width: 390, height: 844 },
];

async function capture(page: Page, dir: string, shot: Shot) {
  await page.goto(shot.url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);
  if (shot.tab) {
    const tabBtn = page.locator('[role="tab"]', { hasText: shot.tab }).first();
    await tabBtn.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  for (const name of shot.buttons ?? []) {
    await page.getByRole("button", { name }).first().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: resolve(dir, `${shot.name}.png`), fullPage: true });
}

for (const vp of viewports) {
  test(`conversation ${vp.device}`, async ({ browser }) => {
    const dir = resolve(OUT, vp.device);
    mkdirSync(dir, { recursive: true });
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      locale: "ja-JP",
    });
    await ctx.route("https://accounts.google.com/**", (r) => r.abort());
    const page = await ctx.newPage();
    for (const shot of shots) await capture(page, dir, shot);
    await ctx.close();
  });
}
