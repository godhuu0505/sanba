
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

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

export function cleanSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return null;
  if (RESERVED_SLUGS.has(slug) || slug.startsWith("_")) return null;
  return slug;
}
