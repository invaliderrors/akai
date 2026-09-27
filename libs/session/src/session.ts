import { z } from "zod";
import { emailSchema, idSchema, isoDateTimeSchema, roleSchema } from "@akai/contracts";
import type { AuthTokens } from "./api-auth";
import { seal, unseal } from "./seal";

/**
 * The dashboard session — the BFF half of spec §8's token flow.
 *
 * The API issues a short-lived access JWT and an opaque refresh token. Neither
 * may reach browser JavaScript, so this app holds both inside a sealed,
 * httpOnly cookie and speaks bearer tokens to the API on the browser's behalf.
 * The browser gets exactly one opaque string it cannot read.
 *
 * "Held server-side" here means "held in a payload only the server can decrypt",
 * not "held in a server-side store". A store would mean Redis or a second
 * Postgres client in a `scope:web` project — the former is rejected by spec §5,
 * the latter by the Nx boundary that keeps `@akai/db` out of browser apps. The
 * security property that matters (the browser cannot read or forge it) holds
 * either way; see seal.ts.
 */

export const sessionPayloadSchema = z
  .object({
    /** Bearer credential for the API. Rotated on refresh. */
    accessToken: z.string().min(1),
    accessTokenExpiresAt: isoDateTimeSchema,
    /** Opaque, single-use. Replaying a consumed one revokes the whole family. */
    refreshToken: z.string().min(1),
    refreshTokenExpiresAt: isoDateTimeSchema,
    sessionId: idSchema,

    // ---- Identity cached for rendering, never for authorisation. ----
    customerId: idSchema,
    email: emailSchema,
    /**
     * Display name, cached so the storefront header can greet a customer without
     * an `/auth/me` round trip on every page render.
     *
     * OPTIONAL FOR BACKWARD COMPATIBILITY, and it must stay that way. This
     * schema is `.strict()` and runs against cookies that are ALREADY in
     * browsers: making it required would fail to decode every session sealed
     * before this field existed, signing the whole fleet out at deploy time.
     *
     * Stale by nature — a customer who renames themselves in the dashboard sees
     * the old name in the store until the session is next written. That is the
     * accepted cost of not paying a request per page view, and it is display
     * only, so the worst case is a stale greeting.
     */
    firstName: z.string().min(1).max(80).nullable().optional(),
    /**
     * ADVISORY ONLY.
     *
     * Spec §8 requires the role to be re-read from the DB session row on every
     * request, and the API's RolesGuard does exactly that. This copy exists so
     * middleware can redirect without a network round trip on every navigation.
     * A stale value here can at worst show a user a page whose data the API then
     * refuses to return — it can never grant access to anything.
     */
    role: roleSchema,
    emailVerified: z.boolean(),
    twoFactorEnabled: z.boolean(),
  })
  .strict();

export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

/**
 * Encodes a session for the cookie.
 *
 * `.parse` rather than a bare cast: this is the last point at which a
 * mis-shaped object can be caught before it becomes an opaque blob that only
 * fails on the next request, in a different file, with no stack pointing here.
 */
export async function encodeSession(payload: SessionPayload, secret: string): Promise<string> {
  return seal(JSON.stringify(sessionPayloadSchema.parse(payload)), secret);
}

/**
 * Decodes a cookie value into a session, or null.
 *
 * Null covers absent, forged, truncated, re-keyed and SHAPE-DRIFTED cookies
 * alike. That last case is the reason the payload is re-validated after
 * decryption rather than trusted because it decrypted: a cookie sealed by a
 * previous release with a different field set is authentic but no longer
 * satisfies this type, and treating it as valid would put `undefined` where the
 * type promises a string.
 */
export async function decodeSession(
  cookieValue: string | undefined,
  secret: string,
): Promise<SessionPayload | null> {
  if (cookieValue === undefined || cookieValue === "") {
    return null;
  }

  const plaintext = await unseal(cookieValue, secret);
  if (plaintext === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(plaintext);
  } catch {
    return null;
  }

  const result = sessionPayloadSchema.safeParse(parsedJson);
  return result.success ? result.data : null;
}

/**
 * Clock skew applied when deciding whether the access token is still usable.
 *
 * Treating a token that expires in 30 seconds as already expired avoids the
 * race where it passes this check, spends 400ms in flight, and arrives at the
 * API expired — which would surface to the user as a spurious sign-out.
 */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

export function isAccessTokenExpired(session: SessionPayload, now: Date = new Date()): boolean {
  return Date.parse(session.accessTokenExpiresAt) - ACCESS_TOKEN_SKEW_MS <= now.getTime();
}

/**
 * The refresh token is the last credential standing. Once it expires there is
 * nothing left to rotate and the user must sign in again — so this check has NO
 * skew: burning a still-valid second is better than attempting a refresh that
 * is guaranteed to fail.
 */
export function isSessionExpired(session: SessionPayload, now: Date = new Date()): boolean {
  return Date.parse(session.refreshTokenExpiresAt) <= now.getTime();
}

/** True when the caller may act as STAFF or ADMIN. Advisory; see `role` above. */
export function isPrivileged(session: SessionPayload): boolean {
  return session.role === "ADMIN" || session.role === "STAFF";
}

/**
 * Folds a fresh token pair into an existing session, carrying every identity
 * field over unchanged.
 *
 * ONE PLACE FOR THIS MERGE. `middleware.ts`'s own GET-path refresh and a
 * Server-Action-triggered retry-on-401 both rotate the SAME five fields out of
 * the SAME `AuthTokens` shape; duplicating the object spread in both callers is
 * exactly how the two would drift the day a sixth token field is added to one
 * and not the other.
 */
export function applyRefreshedTokens(session: SessionPayload, tokens: AuthTokens): SessionPayload {
  return {
    ...session,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    sessionId: tokens.sessionId,
  };
}
