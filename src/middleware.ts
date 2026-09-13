import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

// ── Admin isolation ───────────────────────────────────────────────────────
// The admin panel is served ONLY on the admin host (dexvra.fun) under a secret,
// unguessable path (ADMIN_PATH, e.g. "admin-<hash>") that middleware rewrites to
// the internal /panel routes. It is invisible on the public site (dexvra.io),
// and every admin page + API is gated by a signed session cookie.

const INTERNAL = "/panel";

const adminHosts = (): string[] =>
  (process.env.ADMIN_HOSTS ?? "dexvra.fun,www.dexvra.fun")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function isAdminHost(host: string): boolean {
  const h = host.split(":")[0].toLowerCase();
  if (adminHosts().includes(h)) return true;
  // Local dev / explicit opt-in so the panel is testable off dexvra.fun.
  if (process.env.ADMIN_ALLOW_ANY_HOST === "1") return true;
  if (process.env.NODE_ENV !== "production" && (h === "localhost" || h === "127.0.0.1")) return true;
  return false;
}

const secretPath = (): string => {
  const p = (process.env.ADMIN_PATH ?? "").trim().replace(/^\/+|\/+$/g, "");
  return p ? `/${p}` : "";
};

const notFound = () => new NextResponse("Not Found", { status: 404 });

/** The hostname alone — "www.dexvra.io:3000" → "www.dexvra.io". The port is a
 *  separate field on NextURL, so mixing it into a hostname comparison is how a
 *  local ":3000" request gets redirected to a port that is not listening. */
const hostnameOf = (hostHeader: string): string => hostHeader.split(":")[0].toLowerCase();

async function authed(req: NextRequest): Promise<boolean> {
  return (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) != null;
}

export async function middleware(req: NextRequest) {
  // ── Crash guard: bogus Server Action requests ──────────────────────────
  // Next.js 14.2.x crashes the whole Node process when it receives a Server
  // Action request (a POST carrying a `Next-Action` header) whose action ID
  // isn't in the current build — stale browser tabs after a redeploy, or bots
  // probing the site. This app ships NO Server Actions ("use server" is unused),
  // so every such request is bogus. Short-circuit it here, before Next's action
  // handler can throw an uncaught error and take the server down (the recurring
  // "Failed to find Server Action" pm2 restart loop).
  if (req.headers.get("next-action")) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;
  const onAdminHost = isAdminHost(host);
  const secret = secretPath();

  // ── Public host: admin surface must not exist here at all ──────────────
  if (!onAdminHost) {
    if (
      pathname === INTERNAL ||
      pathname.startsWith(`${INTERNAL}/`) ||
      pathname.startsWith("/api/admin")
    ) {
      return notFound();
    }
    // www → apex, permanently. The domain has a `www` CNAME, so both spellings
    // resolve and serve the same pages — two addresses for one site, which
    // splits every ranking signal between them and is the classic way a brand
    // ends up ranking for neither. The canonical tags already name the apex;
    // this makes it a redirect rather than a hint, and keeps anyone who typed
    // the www out of a URL that will never be the one indexed.
    //
    // Deliberately AFTER the admin-host check: www.dexvra.fun is an admin host
    // and must not be redirected onto the public site.
    const name = hostnameOf(host);
    if (name.startsWith("www.")) {
      const url = req.nextUrl.clone();
      // hostname, not host: the port is its own field and must survive, or a
      // local www test redirects to a port nothing is listening on.
      url.hostname = name.slice(4);
      return NextResponse.redirect(url, 308);
    }
    return NextResponse.next();
  }

  // ── Admin host ─────────────────────────────────────────────────────────
  // Admin API: login is open (rate-limited in the route); everything else needs
  // a valid session.
  if (pathname.startsWith("/api/admin")) {
    if (pathname === "/api/admin/login" || pathname === "/api/admin/logout") {
      return NextResponse.next();
    }
    if (!(await authed(req))) return new NextResponse("Unauthorized", { status: 401 });
    return NextResponse.next();
  }

  // Secret path → rewrite to the internal panel; require a session for anything
  // but the login screen.
  if (secret && (pathname === secret || pathname.startsWith(`${secret}/`))) {
    const rest = pathname.slice(secret.length);
    const url = req.nextUrl.clone();
    url.pathname = `${INTERNAL}${rest === "" || rest === "/" ? "" : rest}`;
    if (url.pathname !== `${INTERNAL}/login` && !(await authed(req))) {
      url.pathname = `${INTERNAL}/login`;
    }
    return NextResponse.rewrite(url);
  }

  // Direct hits on the internal path (bypassing the secret) don't exist.
  if (pathname === INTERNAL || pathname.startsWith(`${INTERNAL}/`)) {
    return notFound();
  }

  // The admin host must never show up in search results. A second domain
  // carrying the brand name is exactly what a brand query does not need, and
  // every public path here already 404s — but a 404 on /robots.txt reads as
  // "crawl whatever you like", so say the opposite in the one file crawlers ask
  // for first. The public host's real robots.txt is generated by app/robots.ts
  // and is unaffected: this branch is only reachable on an admin host.
  if (pathname === "/robots.txt") {
    return new NextResponse("User-agent: *\nDisallow: /\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Allow framework internals, icons, and public APIs to load on the admin host;
  // hide everything else (the public site is not served here).
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.webmanifest"
  ) {
    return NextResponse.next();
  }
  return notFound();
}

export const config = {
  // Run on everything except static asset outputs.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
