import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { serverEnv } from "./lib/env";
import { refresh as refreshTokens } from "./lib/api/auth";
import { createCsrfToken } from "@akai/session";
import {
  CSRF_COOKIE_NAME,
  clearedCookieAttributes,
  csrfCookieAttributes,
  secondsUntil,
  sessionCookieAttributes,
} from "./lib/session/cookies";
import {
  applyRefreshedTokens,
  decodeSession,
  encodeSession,
  isAccessTokenExpired,
  isSessionExpired,
  type SessionPayload,
} from "@akai/session";
import { decideAccess, localisedPath, stripLocale } from "./lib/auth/route-policy";

/**
 * Locale routing + session refresh + route protection, in that dependency order.
 *
 * Middleware is the only place in a Next app that can BOTH read a request's
 * cookies and write cookies on the response before rendering starts. That makes
 * it the only correct home for token rotation — a server component that tried to
 * refresh would rotate the pair and then be forbidden from persisting it, and
 * since refresh tokens are single-use, the rotated pair would be lost and the
 * user silently signed out.
 */

const intlMiddleware = createIntlMiddleware(routing);

/** Cookie mutations to apply to whichever response we end up returning. */
interface CookieWrite {
  readonly name: string;
  readonly value: string;
  readonly attributes: ReturnType<typeof sessionCookieAttributes>;
}

export default async function middleware(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();
  const { locale, pathname } = stripLocale(request.nextUrl.pathname, routing.locales);
  const activeLocale = locale ?? routing.defaultLocale;

  const cookieWrites: CookieWrite[] = [];

  // -------------------------------------------------------------------------
  // 1. Resolve the session, rotating the token pair when it is due.
  // -------------------------------------------------------------------------
  let session = await decodeSession(
    request.cookies.get(env.SESSION_COOKIE_NAME)?.value,
    env.SESSION_SECRET,
  );

  if (session !== null && isSessionExpired(session)) {
    // Nothing left to rotate. Drop it now so the request is treated as
    // anonymous rather than being allowed through to a page whose every API
    // call is guaranteed to 401.
    session = null;
    cookieWrites.push(clearSessionCookie(env.SESSION_COOKIE_NAME), clearCsrfCookie());
  }

  if (session !== null && isAccessTokenExpired(session) && shouldAttemptRefresh(request)) {
    const rotated = await rotate(session, env.API_INTERNAL_URL);

    if (rotated === null) {
      // The API rejected the refresh token: expired, revoked, or detected as a
      // replay (which revokes the whole family). Either way this session is
      // over. Clearing the cookie is what prevents a redirect loop — a
      // known-bad cookie that we keep would bounce sign-in → page → sign-in.
      session = null;
      cookieWrites.push(clearSessionCookie(env.SESSION_COOKIE_NAME), clearCsrfCookie());
    } else {
      session = rotated;
      cookieWrites.push({
        name: env.SESSION_COOKIE_NAME,
        value: await encodeSession(rotated, env.SESSION_SECRET),
        attributes: sessionCookieAttributes(secondsUntil(rotated.refreshTokenExpiresAt)),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Issue a CSRF token when there isn't one.
  //
  // Every mutating BFF route requires the double-submit pair, and this is the
  // only code path that runs for every request — including the very first one,
  // where the browser arrives from an email link with no cookies at all.
  // -------------------------------------------------------------------------
  if (request.cookies.get(CSRF_COOKIE_NAME) === undefined) {
    cookieWrites.push({
      name: CSRF_COOKIE_NAME,
      value: createCsrfToken(),
      attributes: csrfCookieAttributes(CSRF_COOKIE_MAX_AGE_SECONDS),
    });
  }

  // -------------------------------------------------------------------------
  // 3. Apply the access rules.
  // -------------------------------------------------------------------------
  const decision = decideAccess({
    pathname,
    session: session === null ? null : { role: session.role },
  });

  if (decision.kind === "redirect") {
    const target = request.nextUrl.clone();
    target.pathname = localisedPath(decision.path, activeLocale, routing.defaultLocale);
    target.search = "";

    if (decision.reason === "unauthenticated") {
      // Preserve the destination so sign-in can return the user to the page
      // they actually asked for. `pathname + search` only — never an absolute
      // URL from user input, which is an open-redirect handed to a phisher.
      target.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    }

    return applyCookies(NextResponse.redirect(target), cookieWrites);
  }

  // -------------------------------------------------------------------------
  // 4. Hand off to next-intl for locale negotiation and rewriting.
  // -------------------------------------------------------------------------
  return applyCookies(intlMiddleware(request), cookieWrites);
}

/** A year. The CSRF token is not a credential; rotating it on every write suffices. */
const CSRF_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Whether this request should be allowed to burn the refresh token.
 *
 * REFRESH TOKENS ARE SINGLE-USE AND REPLAY-DETECTING. Presenting a consumed one
 * revokes the entire family and signs the user out of every device (spec §8).
 * A page load can fire a document request plus several RSC and prefetch
 * subrequests essentially simultaneously; if every one of them attempted a
 * refresh with the same token, the first would succeed and the rest would look
 * exactly like a stolen-token replay. The user would be logged out by their own
 * navigation.
 *
 * Restricting rotation to top-level document navigations reduces the concurrent
 * attempts to one per navigation. Prefetches and RSC payload requests simply run
 * with the old access token; the worst case is one 401 on a route the user has
 * not committed to yet.
 *
 * This is a mitigation, not a lock. The durable fix is a short grace window on
 * the API side where a just-rotated token is accepted once more instead of
 * being treated as a replay — noted in followUps.
 */
function shouldAttemptRefresh(request: NextRequest): boolean {
  if (request.method !== "GET") {
    return false;
  }
  if (request.headers.get("next-router-prefetch") !== null) {
    return false;
  }
  if (request.headers.get("rsc") !== null) {
    return false;
  }
  const destination = request.headers.get("sec-fetch-dest");
  // Browsers that omit Sec-Fetch-Dest fall through to allowed: refusing there
  // would mean those users could never refresh at all.
  return destination === null || destination === "document";
}

/**
 * Exchanges the refresh token for a new pair.
 *
 * Identity fields are CARRIED OVER rather than re-fetched: the refresh endpoint
 * returns only tokens. `role` in particular therefore ages across refreshes,
 * which is exactly why it is documented as advisory and why the API re-reads it
 * from the database on every request.
 */
async function rotate(
  session: SessionPayload,
  baseUrl: string,
): Promise<SessionPayload | null> {
  const result = await refreshTokens({ baseUrl }, session.refreshToken);
  if (!result.ok) {
    return null;
  }

  return applyRefreshedTokens(session, result.data.tokens);
}

function clearSessionCookie(name: string): CookieWrite {
  return { name, value: "", attributes: clearedCookieAttributes(true) };
}

function clearCsrfCookie(): CookieWrite {
  return { name: CSRF_COOKIE_NAME, value: "", attributes: clearedCookieAttributes(false) };
}

function applyCookies(response: NextResponse, writes: readonly CookieWrite[]): NextResponse {
  for (const write of writes) {
    response.cookies.set(write.name, write.value, write.attributes);
  }
  return response;
}

export const config = {
  /**
   * Excludes `/api` so the BFF route handlers are never locale-rewritten (an
   * `/en/api/auth/login` rewrite would 404) and never redirected — a route
   * handler answering a redirect instead of JSON breaks the sign-in form in a
   * way that looks like a server error.
   *
   * Also excludes `_next`, `_vercel` and anything with a file extension, so
   * static assets do not pay for a decrypt on every request.
   */
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
