import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE = "sanba_sid";

const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/design",
  "/logout",
]);

const PUBLIC_PREFIXES = ["/api/", "/_next/", "/design/", "/join/", "/member-invites/", "/favicon"];

const PUBLIC_FILES = new Set<string>(["/robots.txt", "/sitemap.xml"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (PUBLIC_FILES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const sid = request.cookies.get(SESSION_COOKIE)?.value;
  if (sid) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
