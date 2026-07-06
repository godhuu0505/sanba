// アプリ slug（URL キーワード / ADR-0040）のクライアント側検証。
// 規則は API（apps/api の `_clean_slug`）と揃える: 小文字英数とハイフン・2〜40 文字・
// 先頭末尾は英数。予約語（web のトップレベルルート）もここで先に弾き、サーバー往復なしで
// その場で指摘する。最終判定（グローバル一意を含む）は常に API 側。

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

// apps/api の `_RESERVED_SLUGS` と同期する（web のトップレベルルートを増やしたら両方更新）。
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "assets",
  "design",
  "join",
  "login",
  "member-invites",
  "prepare",
  "products",
  "results",
  "session",
  "sessions",
  "settings",
  "static",
]);

/** 正規化（trim + 小文字化）して検証する。形式違反・予約語は null。 */
export function cleanSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return null;
  if (RESERVED_SLUGS.has(slug) || slug.startsWith("_")) return null;
  return slug;
}
