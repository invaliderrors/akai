import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./constants";

/**
 * Cookie ATTRIBUTES — declared once for every app that holds a session.
 *
 * The names stay app-local (they are configuration), but the attributes are a
 * security contract: httpOnly on the session, readable on the CSRF token,
 * SameSite=Lax on both, and a cleared cookie that matches the original exactly.
 * A `Set-Cookie` written with a different Path does not overwrite the original,
 * it creates a SECOND cookie of the same name; the browser then sends both and
 * which one wins is unspecified. That reads as "sign-out sometimes doesn't
 * work" and is miserable to diagnose — so there is one definition of it.
 *
 * `secure` and `domain` are parameters rather than reads of an app's own env,
 * because those are the lines that legitimately differ per deployment.
 *
 * DOMAIN IS WHAT MAKES SINGLE SIGN-ON POSSIBLE. Omitted, the cookie is host-only.
 * Set to a registrable parent (`.akai.shop`), the browser sends it to every
 * subdomain, so a session written by the store is presented to the dashboard and
 * the customer crosses between them without signing in twice. In development the
 * two apps are ports on `localhost` — and cookies ignore the PORT — so they
 * already share a jar with no domain set at all.
 *
 * THE COST IS REAL AND SHOULD BE UNDERSTOOD: a parent-domain cookie reaches
 * EVERY subdomain, including ones that have nothing to do with this platform. Any
 * host under it that can run JavaScript, or that is ever compromised, is handed
 * the session cookie by the browser. Scope it to the narrowest parent that
 * actually spans the two apps, and never to a domain that hosts third-party or
 * user-controlled content.
 */

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };

/** Minimal structural shape of what Next's cookie stores accept. */
export interface CookieAttributes {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: string;
  readonly maxAge: number;
  /** Absent for a host-only cookie; set to share across subdomains. */
  readonly domain?: string | undefined;
}

/** Per-deployment cookie scope. */
export interface CookieScope {
  readonly secure: boolean;
  /** e.g. ".akai.shop". Omit for host-only. */
  readonly domain?: string | undefined;
}

/** Spread rather than assigned: `exactOptionalPropertyTypes` forbids an explicit undefined. */
function scopeAttributes(scope: CookieScope): { secure: boolean; domain?: string } {
  return {
    secure: scope.secure,
    ...(scope.domain === undefined || scope.domain === "" ? {} : { domain: scope.domain }),
  };
}

/**
 * SameSite=Lax rather than Strict: email-verification and password-reset links
 * are top-level cross-site navigations, and Strict would withhold the cookie on
 * exactly those, so a verified user would land looking signed out. Lax still
 * blocks the cross-site POST that CSRF needs, and the double-submit token
 * covers the remainder.
 */
export function sessionCookieAttributes(
  maxAgeSeconds: number,
  scope: CookieScope,
): CookieAttributes {
  return { httpOnly: true, sameSite: "lax", path: "/", maxAge: maxAgeSeconds, ...scopeAttributes(scope) };
}

/** Not httpOnly by design: client JS must read it to echo the header back. */
export function csrfCookieAttributes(maxAgeSeconds: number, scope: CookieScope): CookieAttributes {
  return { httpOnly: false, sameSite: "lax", path: "/", maxAge: maxAgeSeconds, ...scopeAttributes(scope) };
}

/**
 * Attributes that delete a cookie: `maxAge: 0` with the SAME path and security
 * attributes as the original. A mismatch silently leaves the cookie in place,
 * which on a shared computer means the next person is still signed in.
 */
export function clearedCookieAttributes(httpOnly: boolean, scope: CookieScope): CookieAttributes {
  // The SAME domain as the original, or the delete silently misses: a cookie set
  // on `.akai.shop` is not removed by a host-only `Set-Cookie` of the same
  // name, and the browser keeps sending the old one.
  return { httpOnly, sameSite: "lax", path: "/", maxAge: 0, ...scopeAttributes(scope) };
}

/** Seconds until `isoTimestamp`, floored at zero. */
export function secondsUntil(isoTimestamp: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((Date.parse(isoTimestamp) - now.getTime()) / 1000));
}
