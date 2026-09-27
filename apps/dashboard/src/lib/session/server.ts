import { cookies } from "next/headers";
import { serverEnv } from "../env";
import {
  CSRF_COOKIE_NAME,
  clearedCookieAttributes,
  csrfCookieAttributes,
  secondsUntil,
  sessionCookieAttributes,
  sessionCookieName,
} from "./cookies";
import { createCsrfToken } from "@akai/session";
import {
  decodeSession,
  encodeSession,
  isSessionExpired,
  type SessionPayload,
} from "@akai/session";

/**
 * Server-side session access.
 *
 * This module reads SESSION_SECRET, so it must never be pulled into a client
 * bundle. The `server-only` package is the usual guard, but it is not a
 * dependency of this workspace; the browser check below is the dependency-free
 * equivalent and fails loudly at import time rather than shipping a secret. If
 * `server-only` is ever added, replace this with `import "server-only"`, which
 * catches the mistake at BUILD time instead of first render.
 *
 * WRITES (`writeSession`, `clearSession`) are only legal in a route handler or
 * a server action. Next throws if a server component mutates cookies, which is
 * why the refresh-and-rotate path lives in middleware and the BFF routes.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "apps/dashboard/src/lib/session/server.ts was imported from client code — it reads SESSION_SECRET and must stay server-side.",
  );
}

/** The smallest cookie-store surface this module needs. */
export interface ReadonlyCookieStore {
  get(name: string): { value: string } | undefined;
}

/**
 * Reads the session from an arbitrary cookie store (a `NextRequest`'s cookies,
 * for instance). Pure with respect to Next's request context, so it is directly
 * unit-testable.
 */
export async function readSessionFrom(
  store: ReadonlyCookieStore,
  secret: string = serverEnv().SESSION_SECRET,
  name: string = sessionCookieName(),
): Promise<SessionPayload | null> {
  const session = await decodeSession(store.get(name)?.value, secret);
  if (session === null) {
    return null;
  }
  // An expired refresh token is not a session, it is a corpse. Returning it
  // would let a caller attempt an API request that is certain to 401.
  return isSessionExpired(session) ? null : session;
}

/** The current request's session, or null when anonymous. */
export async function getSession(): Promise<SessionPayload | null> {
  return readSessionFrom(await cookies());
}

/**
 * The current session, or a thrown error.
 *
 * For server components behind a route that middleware has already gated, where
 * a null session means the middleware contract was violated — not a case the
 * page should render a friendly empty state for.
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (session === null) {
    throw new Error("requireSession called without a session — route protection is misconfigured");
  }
  return session;
}

/**
 * Persists a session and rotates the CSRF token.
 *
 * The CSRF token is regenerated on every session write. Carrying one across a
 * sign-in is session fixation's csrf-shaped cousin: an attacker who planted a
 * known token before authentication would still hold a valid one after.
 *
 * The cookie's lifetime tracks the REFRESH token, not the access token — the
 * session stays alive as long as it can be rotated.
 */
export async function writeSession(payload: SessionPayload): Promise<void> {
  const store = await cookies();
  const maxAge = secondsUntil(payload.refreshTokenExpiresAt);

  store.set(
    sessionCookieName(),
    await encodeSession(payload, serverEnv().SESSION_SECRET),
    sessionCookieAttributes(maxAge),
  );
  store.set(CSRF_COOKIE_NAME, createCsrfToken(), csrfCookieAttributes(maxAge));
}

/**
 * Deletes both cookies.
 *
 * Called on sign-out AND on every unrecoverable auth failure. Leaving a
 * known-bad session cookie in place produces a redirect loop: middleware sees a
 * cookie, lets the request through, the page's API call 401s, and it bounces
 * back to sign-in — forever.
 */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.set(sessionCookieName(), "", clearedCookieAttributes(true));
  store.set(CSRF_COOKIE_NAME, "", clearedCookieAttributes(false));
}

/** The current CSRF token, for a server component that renders it into a form. */
export async function getCsrfToken(): Promise<string | null> {
  return (await cookies()).get(CSRF_COOKIE_NAME)?.value ?? null;
}
