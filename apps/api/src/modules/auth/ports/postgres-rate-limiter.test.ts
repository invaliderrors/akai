import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.port";
import { PostgresAuthRateLimiter } from "./postgres-rate-limiter";
import type { RateLimitStore, RateLimitWindow } from "./rate-limit-store.port";

/**
 * A faithful in-memory reimplementation of the store's SQL semantics: atomic
 * increment with window reset on lapse. Testing the limiter through this proves
 * the DECISION logic (allow/deny, remaining, Retry-After) that the SQL cannot
 * itself express, while the SQL's own atomicity is covered by the integration
 * suite against a real Postgres.
 */
class FakeRateLimitStore implements RateLimitStore {
  private readonly rows = new Map<string, { count: number; resetAt: number }>();

  increment(key: string, windowMs: number, now: Date): Promise<RateLimitWindow> {
    const nowMs = now.getTime();
    const existing = this.rows.get(key);

    if (existing === undefined || existing.resetAt <= nowMs) {
      const fresh = { count: 1, resetAt: nowMs + windowMs };
      this.rows.set(key, fresh);
      return Promise.resolve({ ...fresh });
    }

    existing.count += 1;
    return Promise.resolve({ count: existing.count, resetAt: existing.resetAt });
  }

  clear(key: string): Promise<void> {
    this.rows.delete(key);
    return Promise.resolve();
  }

  /** Test-only peek — proves the limiter shares one durable counter. */
  peek(key: string): number {
    return this.rows.get(key)?.count ?? 0;
  }
}

function harness(): {
  limiter: PostgresAuthRateLimiter;
  store: FakeRateLimitStore;
  advance: (ms: number) => void;
} {
  let now = new Date("2026-07-20T12:00:00.000Z");
  const clock: Clock = { now: () => new Date(now) };
  const store = new FakeRateLimitStore();
  return {
    limiter: new PostgresAuthRateLimiter(store, clock),
    store,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("PostgresAuthRateLimiter", () => {
  it("allows exactly `limit` requests inside the window", async () => {
    const { limiter } = harness();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await limiter.consume("login:1.2.3.4", 5, 60_000)).allowed).toBe(true);
    }
    expect((await limiter.consume("login:1.2.3.4", 5, 60_000)).allowed).toBe(false);
  });

  it("reports remaining budget and a bounded retry hint", async () => {
    const { limiter } = harness();

    expect((await limiter.consume("k", 3, 60_000)).remaining).toBe(2);
    expect((await limiter.consume("k", 3, 60_000)).remaining).toBe(1);
    expect((await limiter.consume("k", 3, 60_000)).remaining).toBe(0);

    const blocked = await limiter.consume("k", 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("floors Retry-After at one second so a blocked caller cannot retry instantly", async () => {
    const { limiter, advance } = harness();

    await limiter.consume("k", 1, 1_000);
    // 999ms into a 1000ms window: (resetAt - now) rounds up to 1, never 0.
    advance(999);
    const blocked = await limiter.consume("k", 1, 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
  });

  it("starts a fresh window once the old one lapses", async () => {
    const { limiter, advance } = harness();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.consume("k", 3, 60_000);
    }
    expect((await limiter.consume("k", 3, 60_000)).allowed).toBe(false);

    advance(60_001);
    expect((await limiter.consume("k", 3, 60_000)).allowed).toBe(true);
  });

  it("keeps buckets independent per key", async () => {
    const { limiter } = harness();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.consume("login:1.1.1.1", 3, 60_000);
    }

    expect((await limiter.consume("login:2.2.2.2", 3, 60_000)).allowed).toBe(true);
    expect((await limiter.consume("register:1.1.1.1", 3, 60_000)).allowed).toBe(true);
  });

  it("forgives the burst after an explicit reset", async () => {
    const { limiter } = harness();

    await limiter.consume("k", 1, 60_000);
    expect((await limiter.consume("k", 1, 60_000)).allowed).toBe(false);

    await limiter.reset("k");
    expect((await limiter.consume("k", 1, 60_000)).allowed).toBe(true);
  });

  it("shares one durable counter rather than a per-call one", async () => {
    // The whole point of SEV3: the count lives in the store, not the limiter, so
    // a second limiter instance over the SAME store keeps counting where the
    // first left off — the cross-replica guarantee, modelled.
    const { limiter, store } = harness();
    const clock: Clock = { now: () => new Date("2026-07-20T12:00:00.000Z") };
    const secondReplica = new PostgresAuthRateLimiter(store, clock);

    await limiter.consume("login:9.9.9.9", 2, 60_000);
    await secondReplica.consume("login:9.9.9.9", 2, 60_000);

    expect(store.peek("login:9.9.9.9")).toBe(2);
    // Third hit across the two replicas is over the limit of 2.
    expect((await secondReplica.consume("login:9.9.9.9", 2, 60_000)).allowed).toBe(false);
  });
});
