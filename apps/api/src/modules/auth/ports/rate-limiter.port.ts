import type { Clock } from "./clock.port";

/**
 * Rate limiting, behind a port.
 *
 * Spec §5 puts the real throttler store in Postgres (pg-boss is already the one
 * stateful service, so Redis buys nothing). `libs/db` is owned by another agent
 * this pass, so the shipped binding is an in-process fixed-window counter and
 * the Postgres-backed store is a followUp. The port is what makes that a
 * one-line provider swap rather than a refactor.
 *
 * The in-process limiter is genuinely useful even after the swap lands — it
 * keeps a single instance from hammering the database on a credential-stuffing
 * burst — but on its own it is PER-PROCESS, so it does not bound an attacker
 * spread across replicas. That limitation is the reason the followUp matters,
 * and it is the reason account lockout (which IS durable, in
 * `customer.failedLoginCount`/`lockedUntil`) exists alongside it rather than
 * instead of it.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets. Surfaced as the Retry-After header. */
  readonly retryAfterSeconds: number;
}

export interface AuthRateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  /** Clears a key after a successful login, so one success forgives the burst. */
  reset(key: string): Promise<void>;
}

export const AUTH_RATE_LIMITER = Symbol("AUTH_RATE_LIMITER");

interface WindowState {
  count: number;
  resetAt: number;
}

/** Fixed-window counter. Bounded in size so it cannot be turned into a leak. */
export class InMemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly clock: Clock,
    /**
     * Hard cap on tracked keys. An attacker rotating source IPs would otherwise
     * grow this map without bound — the limiter itself becoming the DoS.
     */
    private readonly maxKeys = 10_000,
  ) {}

  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    this.evictExpired(now);

    const existing = this.windows.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) {
        this.evictOldest();
      }
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return Promise.resolve({
        allowed: true,
        remaining: Math.max(0, limit - 1),
        retryAfterSeconds: 0,
      });
    }

    existing.count += 1;
    const allowed = existing.count <= limit;

    return Promise.resolve({
      allowed,
      remaining: Math.max(0, limit - existing.count),
      retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
    });
  }

  reset(key: string): Promise<void> {
    this.windows.delete(key);
    return Promise.resolve();
  }

  private evictExpired(now: number): void {
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }

  private evictOldest(): void {
    // Map preserves insertion order, so the first key is the oldest window.
    const oldest = this.windows.keys().next();
    if (oldest.done !== true) {
      this.windows.delete(oldest.value);
    }
  }
}
