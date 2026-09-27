/**
 * The public throttler's view of a rate limiter.
 *
 * Structurally the read half of `AuthRateLimiter` — deliberately re-declared
 * here rather than imported, because the throttler only ever CONSUMES. It has no
 * `reset()`, and it should not: "one success forgives the burst" is a login
 * concept (a customer who finally typed the right password is not an attacker),
 * and there is no equivalent success signal on a catalog read. Importing the
 * wider interface would hand every future edit in this module a reset() it has
 * no correct use for.
 *
 * The BINDING is shared — the same Postgres-backed counter auth uses — so the
 * duplication is one interface, not one implementation.
 */
export interface PublicRateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets. Surfaced in the 429 message. */
  readonly retryAfterSeconds: number;
}

export interface PublicRateLimiter {
  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<PublicRateLimitDecision>;
}

export const PUBLIC_RATE_LIMITER = Symbol("PUBLIC_RATE_LIMITER");
