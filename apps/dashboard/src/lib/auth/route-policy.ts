import type { Role } from "@akai/contracts";

/**
 * Which visitors may reach which routes.
 *
 * Extracted from middleware as PURE functions so the access rules can be
 * exhaustively unit-tested without a Next request, an Edge runtime or a live
 * API. Authorisation logic that can only be exercised by booting the app is
 * authorisation logic that does not get tested.
 *
 * This layer is a UX gate, not the security boundary. The real boundary is the
 * API's `JwtAuthGuard` + `RolesGuard`, which re-read the role from the database
 * on every request. Everything here could be bypassed by an attacker crafting
 * requests directly at the API and it would change nothing — which is the
 * property that makes a cached role in a cookie safe to use for routing.
 */

export type AccessLevel =
  /** Reachable ONLY while signed out — the sign-in page, and so on. */
  | "anonymous-only"
  /** Reachable either way (email verification arrives from a mail client). */
  | "public"
  /** Any signed-in role. */
  | "authenticated"
  /** STAFF or ADMIN only. */
  | "privileged"
  /** PARTNER only — see `decideAccess`'s own note on why this is an ALLOW-list. */
  | "partner";

export const SIGN_IN_PATH = "/sign-in";
export const DASHBOARD_HOME_PATH = "/";

/** Paths that must not be visited while signed in. */
const ANONYMOUS_ONLY_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
] as const;

/**
 * Reachable in both states.
 *
 * `/verify-email` is here rather than in anonymous-only because the link is
 * clicked from an email client that may well already have a session — bouncing
 * a signed-in user away from their own verification link would leave the
 * account permanently unverified.
 */
const PUBLIC_PREFIXES = ["/verify-email"] as const;

const PRIVILEGED_PREFIXES = ["/admin"] as const;

const PARTNER_PREFIXES = ["/partner"] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  // Exact match, or a genuine path segment boundary. A plain `startsWith`
  // would classify `/sign-in-help` as the sign-in page and `/administrators`
  // as an admin route.
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function classifyPath(pathname: string): AccessLevel {
  if (PRIVILEGED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return "privileged";
  }
  if (PARTNER_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return "partner";
  }
  if (PUBLIC_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return "public";
  }
  if (ANONYMOUS_ONLY_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return "anonymous-only";
  }
  // DENY BY DEFAULT. A new page added by another slice is protected the moment
  // it exists; making it public is an explicit, reviewable edit to the list
  // above. The opposite default leaks a new page the day someone forgets.
  return "authenticated";
}

export type RedirectReason =
  | "unauthenticated"
  | "already-signed-in"
  | "insufficient-role";

export type RouteDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "redirect"; readonly path: string; readonly reason: RedirectReason };

export interface RoutePolicyInput {
  /** Locale-stripped, e.g. `/admin/products` for `/en/admin/products`. */
  readonly pathname: string;
  /** Null when anonymous. `role` is the cached, advisory value. */
  readonly session: { readonly role: Role } | null;
}

const ALLOW: RouteDecision = { kind: "allow" };

export function decideAccess({ pathname, session }: RoutePolicyInput): RouteDecision {
  const level = classifyPath(pathname);

  if (level === "public") {
    return ALLOW;
  }

  if (session === null) {
    return level === "anonymous-only"
      ? ALLOW
      : { kind: "redirect", path: SIGN_IN_PATH, reason: "unauthenticated" };
  }

  if (level === "anonymous-only") {
    // Signed in but asking for the sign-in page — usually a back-button. Send
    // them home rather than rendering a form that would create a SECOND session
    // and orphan the first.
    return { kind: "redirect", path: DASHBOARD_HOME_PATH, reason: "already-signed-in" };
  }

  if (level === "privileged" && session.role !== "STAFF" && session.role !== "ADMIN") {
    // An ALLOW-LIST, matching `(admin)/layout.tsx`'s own cached-role check
    // line for line. Used to read `session.role === "CUSTOMER"` — a deny-list
    // that would have silently let the new PARTNER role straight through this
    // gate (the layout's own allow-list still would have caught it, but a
    // visitor should not clear ANY gate on the way to a route they cannot
    // use). Redirect, not 404, because middleware cannot render one; the
    // layout's `notFound()` is what a customer who reaches an admin URL by
    // any other path actually sees.
    return { kind: "redirect", path: DASHBOARD_HOME_PATH, reason: "insufficient-role" };
  }

  if (level === "partner" && session.role !== "PARTNER") {
    // An ALLOW-LIST, deliberately unlike "privileged" above: `role === "PARTNER"`
    // is required explicitly rather than merely excluding CUSTOMER, so a role
    // added after this one is written does NOT silently fall through to allow.
    // The `(partner)/` layout's own server-side re-check repeats this same
    // allow-list against the LIVE role, matching `(admin)/layout.tsx`'s own
    // two-gate shape.
    return { kind: "redirect", path: DASHBOARD_HOME_PATH, reason: "insufficient-role" };
  }

  return ALLOW;
}

/**
 * Splits a locale prefix off a pathname.
 *
 * `localePrefix: "as-needed"` means the default locale carries NO prefix, so
 * `/orders` and `/en/orders` are the same route. Policy must see the same
 * string for both or the rules apply to only one of the two languages — a
 * bug that reliably escapes review because the default locale keeps working.
 */
export function stripLocale(
  pathname: string,
  locales: readonly string[],
): { readonly locale: string | null; readonly pathname: string } {
  const segments = pathname.split("/");
  const first = segments[1];

  if (first !== undefined && locales.includes(first)) {
    const remainder = `/${segments.slice(2).join("/")}`;
    return { locale: first, pathname: remainder === "/" ? "/" : remainder.replace(/\/$/, "") };
  }

  const normalised = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  return { locale: null, pathname: normalised };
}

/**
 * Validates a `?next=` destination before redirecting to it.
 *
 * OPEN REDIRECT DEFENCE. `next` is attacker-controllable — a phishing mail can
 * link to `/sign-in?next=https://akai.example.com/`, and a user who signs
 * in successfully then lands on the attacker's page still trusting it. So:
 *
 *  - must start with a single `/` (rejects absolute URLs)
 *  - `//host` and `/\host` are rejected: browsers treat both as protocol-relative
 *  - anything else falls back to the dashboard home
 *
 * The locale prefix is stripped because the caller passes the result to
 * next-intl's router, which adds its own — leaving it would produce `/en/en/orders`.
 */
export function sanitiseNextPath(
  raw: string | null,
  locales: readonly string[],
): string {
  if (raw === null || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return DASHBOARD_HOME_PATH;
  }

  // The query string is preserved but kept out of locale stripping, which
  // reasons about path segments only. `/en/orders?cursor=abc` must survive as
  // `/orders?cursor=abc`, not lose the cursor and silently reset to page one.
  const queryStart = raw.indexOf("?");
  const pathPart = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = queryStart === -1 ? "" : raw.slice(queryStart);

  const { pathname } = stripLocale(pathPart, locales);

  // A redirect back to an anonymous-only page after signing in would bounce
  // straight back out again via `decideAccess`. Home is the useful destination.
  return classifyPath(pathname) === "anonymous-only"
    ? DASHBOARD_HOME_PATH
    : `${pathname}${query}`;
}

/** Re-applies a locale prefix, honouring `as-needed` for the default locale. */
export function localisedPath(
  path: string,
  locale: string,
  defaultLocale: string,
): string {
  return locale === defaultLocale ? path : `/${locale}${path === "/" ? "" : path}`;
}
