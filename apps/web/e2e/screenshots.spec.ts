import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { test, type BrowserContext, type Route } from "@playwright/test";

const OUT = resolve(process.cwd(), "screenshots");
const SID = "devsessioncookie_0123456789ABCDEFGHIJ";

const ts = (n: number) => new Date(2026, 5, 24, 12, 48, n % 60).toISOString();

const requirements = [
  {
    id: "r1",
    statement: "キーワード検索を新設し、結果を既定で関連度順に並べる。",
    category: "functional",
    priority: "must",
    confidence: 0.86,
    source_speaker: "顧客",
    citations: [{ kind: "utterance", ref: "u1" }],
    status: "confirmed",
  },
  {
    id: "r2",
    statement: "並び順は関連度順を既定とし、新着順へ切り替え可能にする。",
    category: "constraint",
    priority: "should",
    confidence: 0.9,
    source_speaker: "インタビュー統括",
    citations: [{ kind: "utterance", ref: "u2" }],
    status: "confirmed",
  },
  {
    id: "r3",
    statement: "『該当なし』の空状態を設計する。",
    category: "scope",
    priority: "should",
    confidence: 0.72,
    source_speaker: "scope_specialist",
    citations: [{ kind: "utterance", ref: "u1" }],
    status: "draft",
  },
];

const product = {
  id: "demo-product",
  name: "サンバ EC",
  slug: "sanba-ec",
  description: "EC サイトの検索・購買体験を扱うプロダクト。",
  glossary: ["関連度順", "ファセット検索"],
  created_at: "2026-06-01T00:00:00Z",
  github_repo: "godhuu0505/sanba",
  github_branch: "main",
  github_commit_sha: "abc1234",
  github_index_status: "ready",
  role: "owner",
  output_formats: {},
  output_format_defaults: {
    end_user: "# 利用者向け\n- 何ができるか\n",
    planner: "# 企画向け\n- 背景と狙い\n",
    developer: "# 開発者向け\n- 受け入れ条件\n",
  },
  check_items: [
    { text: "アクセシビリティを満たすか", target: null },
    { text: "パフォーマンス目標を満たすか", target: "developer" },
  ],
  check_items_limit: 20,
  check_point_defaults: {
    end_user: ["使いやすさ"],
    planner: ["KPI への寄与"],
    developer: ["性能・信頼性"],
  },
};

const mySessions = [
  {
    id: "demo-session",
    title: "検索体験の要件深掘り",
    created_at: "2026-07-10T04:30:00Z",
    status: "completed",
    finalized: true,
    labels: ["検索", "EC"],
    issue_url: "https://github.com/godhuu0505/sanba/issues/999",
  },
  {
    id: "sess-2",
    title: "通知設定の要件整理",
    created_at: "2026-07-08T06:00:00Z",
    status: "active",
    finalized: false,
    labels: ["通知"],
    issue_url: null,
  },
];

const mySessionRequirements = {
  id: "demo-session",
  title: "検索体験の要件深掘り",
  created_at: "2026-07-10T04:30:00Z",
  finalized: false,
  goal: "検索結果の並び順を決める",
  goal_detail: "関連度順か新着順か、既定をどちらにするか",
  materials: [{ id: "a1", name: "一覧画面.png", kind: "image", status: "analyzed" }],
  open_inquiries: [{ id: "nq-g1", kind: "gap", text: "『該当なし』の空状態が未定義です。" }],
  items: requirements,
};

const resultDocument = {
  audience: "planner",
  is_custom_format: false,
  markdown:
    "# 要件ドキュメント\n\n## 概要\n検索体験を改善し、結果の並び順の規矩を定める。\n\n## 要件\n- キーワード検索を新設する\n- 並び順は関連度順を既定とし、新着順へ切替可能とする\n- 『該当なし』の空状態を設計する\n",
};

const transcript = {
  id: "demo-session",
  utterances: [
    { speaker: "顧客", text: "検索結果は関連度順で出したい。", ts: ts(1) },
    { speaker: "PM", text: "さっきは新着順と言っていた気がします。", ts: ts(2) },
    { speaker: "産婆", text: "その二つ、相和しませぬ。いずれを規矩とすべきか。", ts: ts(3) },
  ],
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function handleApi(route: Route) {
  const req = route.request();
  const { pathname } = new URL(req.url());

  if (pathname === "/api/session/me") return json(route, null, 401);
  if (pathname === "/api/auth/nonce")
    return json(route, { nonce: "n", token: "t", expires_at: 9999999999 });

  if (pathname === "/api/products/mine") return json(route, [product]);
  if (pathname === "/api/products/join")
    return json(route, {
      session_id: "demo-session",
      invite: null,
      product_id: "demo-product",
      product_name: "サンバ EC",
      interview_mode: "end_user",
      join: null,
    });
  if (pathname.endsWith("/members")) return json(route, [
    { sub: "u-1", email: "member@example.com", display_name: "田中 太郎", created_at: "2026-06-02T00:00:00Z" },
  ]);
  if (pathname.endsWith("/invites")) return json(route, [
    { id: "inv-1", scope: "developer", expires_at: null, max_uses: null, use_count: 2, revoked: false, created_at: "2026-06-05T00:00:00Z", token: "tok_dev" },
  ]);
  if (pathname.endsWith("/member-invites")) return json(route, [
    { id: "mi-1", email: "new@example.com", status: "pending", created_at: "2026-06-06T00:00:00Z", expires_at: null, invited_by_email: "owner@example.com", token: "tok_mi" },
  ]);
  if (pathname.startsWith("/api/products/")) return json(route, product);

  if (pathname === "/api/sessions/mine") return json(route, mySessions);
  if (pathname.endsWith("/requirements")) return json(route, mySessionRequirements);
  if (pathname.includes("/result-document")) return json(route, resultDocument);
  if (pathname.endsWith("/transcript")) return json(route, transcript);
  if (pathname.endsWith("/export/eligibility"))
    return json(route, { can_export: true, repo: "godhuu0505/sanba" });

  if (pathname === "/api/github/link") return json(route, { linked: true, github_login: "godhuu0505" });
  if (pathname === "/api/github/repos") return json(route, { repos: [] });

  if (pathname === "/api/member-invites/mine") return json(route, []);
  if (pathname === "/api/member-invites/resolve")
    return json(route, {
      id: "mi-1",
      product_name: "サンバ EC",
      invited_by_email: "owner@example.com",
      masked_email: "n***@example.com",
      status: "pending",
      email_match: true,
    });

  return json(route, {});
}

async function setupContext(ctx: BrowserContext) {
  await ctx.addCookies([
    { name: "sanba_sid", value: SID, domain: "localhost", path: "/" },
  ]);
  await ctx.route(/\/api\//, handleApi);
  await ctx.route("https://accounts.google.com/**", (r) => r.abort());
}

const routes: { name: string; path: string }[] = [
  { name: "01-login", path: "/login" },
  { name: "02-home", path: "/" },
  { name: "03-prepare", path: "/sanba-ec/prepare" },
  { name: "04-products", path: "/products" },
  { name: "05-product-detail", path: "/products/demo-product" },
  { name: "06-results", path: "/results" },
  { name: "07-result-detail", path: "/results/demo-session" },
  { name: "08-settings", path: "/settings" },
  { name: "09-join", path: "/join/demo-invite.sig" },
  { name: "10-member-invite", path: "/member-invites/demo-invite.sig" },
  { name: "11-design-kit", path: "/design" },
];

const viewports = [
  { device: "pc", width: 1440, height: 900 },
  { device: "mobile", width: 390, height: 844 },
];

for (const vp of viewports) {
  test(`capture ${vp.device}`, async ({ browser }) => {
    mkdirSync(resolve(OUT, vp.device), { recursive: true });
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      locale: "ja-JP",
    });
    await setupContext(ctx);
    const page = await ctx.newPage();

    for (const r of routes) {
      await page.goto(r.path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1200);
      await page.screenshot({
        path: resolve(OUT, vp.device, `${r.name}.png`),
        fullPage: true,
      });
    }

    await ctx.close();
  });
}
