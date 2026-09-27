/**
 * Double-submit CSRF protection (spec §8).
 *
 * The session cookie is SameSite=Lax, which already blocks the cross-site form
 * POST. This is the second layer, and it is the one that survives a browser
 * that mishandles SameSite, a `<form>` smuggled through a same-site subdomain,
 * or a future need to relax SameSite for an embedded flow.
 *
 * Edge-runtime safe: no `node:crypto`, so middleware can issue tokens.
 */

const TOKEN_BYTES = 32;

/** 256 bits from the CSPRNG. `Math.random` is not a CSPRNG and never will be. */
export function createCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Length-independent, content-constant-time string comparison.
 *
 * `a === b` short-circuits on the first differing byte, and the timing
 * difference is measurable across enough samples — that is a token-recovery
 * oracle. This accumulates every difference before deciding, so the work done
 * depends only on the length, which is public.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Verifies a mutating request's CSRF pair.
 *
 * Fails CLOSED on any missing half. An earlier-generation bug pattern is to
 * skip the check when the header is absent "because old clients don't send it";
 * that turns the control off for precisely the attacker who chooses not to
 * send it.
 */
export function verifyCsrf(cookieToken: string | undefined, headerToken: string | null): boolean {
  if (cookieToken === undefined || cookieToken === "" || headerToken === null || headerToken === "") {
    return false;
  }
  return timingSafeEqual(cookieToken, headerToken);
}
