import type { Clock } from "./clock.port";
import type { AuthRateLimiter, RateLimitDecision } from "./rate-limiter.port";
import type { RateLimitStore } from "./rate-limit-store.port";

/**
 * The durable, cross-instance rate limiter (spec §5) — the fix for the
 * per-process `InMemoryAuthRateLimiter` that a second replica bypasses.
 *
 * It holds NO state. The count lives in `rate_limit_counter`, shared by every
 * instance, so progressive login lockout keyed on email + IP holds across the
 * whole fleet rather than per box. This class only turns the store's atomic
 * counter into an allow/deny decision — pure logic, unit-tested against a fake
 * store; the atomic increment itself is the store's SQL, exercised by the
 * integration suite against a real Postgres.
 *
 * The clock is injected for the same reason it is everywhere else in auth: the
 * Retry-After maths must be assertable without the suite waiting out a window.
 */
export class PostgresAuthRateLimiter implements AuthRateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly clock: Clock,
  ) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.clock.now();
    const { count, resetAt } = await this.store.increment(key, windowMs, now);

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    // Retry-After is only meaningful when blocked. Floor it at 1s: a window that
    // rounds down to 0 would tell the client to retry immediately and defeat the
    // limit on the very next request.
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000));

    return { allowed, remaining, retryAfterSeconds };
  }

  reset(key: string): Promise<void> {
    return this.store.clear(key);
  }
}
