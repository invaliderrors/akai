import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  clearedCookieAttributes as libCleared,
  csrfCookieAttributes as libCsrf,
  sessionCookieAttributes as libSession,
  secondsUntil,
  type CookieAttributes,
  type CookieScope,
} from "@akai/session";
import { isProduction, serverEnv } from "../env";

/**
 * The dashboard's cookie vocabulary.
 *
 * The ATTRIBUTES live in `@akai/session` — they are a security contract and two
 * copies could drift. What stays here is the per-deployment part.
 *
 * THE NAME IS SHARED WITH THE STOREFRONT ON PURPOSE. One sealed cookie, one
 * SESSION_SECRET, decoded by both apps: that is how a customer who signs in on
 * the store arrives at the account area already authenticated. In production the
 * two are different subdomains, so SESSION_COOKIE_DOMAIN must be set to a parent
 * that spans them (`.akai.shop`) or the cookie is host-only and the hand-off
 * silently does not happen.
 */

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, secondsUntil, type CookieAttributes };

export function sessionCookieName(): string {
  return serverEnv().SESSION_COOKIE_NAME;
}

function cookieScope(): CookieScope {
  const domain = process.env.SESSION_COOKIE_DOMAIN;
  return {
    secure: isProduction(),
    ...(domain === undefined || domain.trim() === "" ? {} : { domain: domain.trim() }),
  };
}

export function sessionCookieAttributes(maxAgeSeconds: number): CookieAttributes {
  return libSession(maxAgeSeconds, cookieScope());
}

export function csrfCookieAttributes(maxAgeSeconds: number): CookieAttributes {
  return libCsrf(maxAgeSeconds, cookieScope());
}

export function clearedCookieAttributes(httpOnly: boolean): CookieAttributes {
  return libCleared(httpOnly, cookieScope());
}
