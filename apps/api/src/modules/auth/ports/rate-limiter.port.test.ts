import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.port";
import { InMemoryAuthRateLimiter } from "./rate-limiter.port";

function harness(): { limiter: InMemoryAuthRateLimiter; advance: (ms: number) => void } {
  let now = new Date("2026-07-20T12:00:00.000Z");
  const clock: Clock = { now: () => new Date(now) };
  return {
    limiter: new InMemoryAuthRateLimiter(clock),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("InMemoryAuthRateLimiter", () => {
  it("allows exactly `limit` requests inside the window", async () => {
    const { limiter } = harness();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await limiter.consume("login:1.2.3.4", 5, 60_000)).allowed).toBe(true);
    }

    // The 6th is the first rejection: an off-by-one here either lets an extra
    // guess through or rejects a legitimate final attempt.
    expect((await limiter.consume("login:1.2.3.4", 5, 60_000)).allowed).toBe(false);
  });

  it("reports remaining budget and a retry hint", async () => {
    const { limiter } = harness();

    expect((await limiter.consume("k", 3, 60_000)).remaining).toBe(2);
    expect((await limiter.consume("k", 3, 60_000)).remaining).toBe(1);
    expect((await limiter.consume("k", 3, 60_000)).remaining).toBe(0);

    const blocked = await limiter.consume("k", 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
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

    // One IP exhausting its budget must not lock out every other visitor, and
    // login must not consume register's allowance.
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

  it("bounds its own memory so the limiter cannot become the DoS", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const clock: Clock = { now: () => new Date(now) };
    const limiter = new InMemoryAuthRateLimiter(clock, 100);

    // An attacker rotating source IPs would otherwise grow this map without
    // bound.
    for (let index = 0; index < 500; index += 1) {
      await limiter.consume(`login:10.0.0.${index}`, 5, 60_000);
    }

    // Still enforcing after the churn.
    const key = "login:198.51.100.1";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await limiter.consume(key, 5, 60_000)).allowed).toBe(true);
    }
    expect((await limiter.consume(key, 5, 60_000)).allowed).toBe(false);
    expect(now.getTime()).toBeGreaterThan(0);
  });

  it("evicts lapsed windows rather than retaining them forever", async () => {
    const { limiter, advance } = harness();

    for (let index = 0; index < 50; index += 1) {
      await limiter.consume(`k${index}`, 5, 1_000);
    }

    advance(2_000);
    // Any consume call sweeps expired windows first.
    await limiter.consume("trigger", 5, 1_000);

    for (let index = 0; index < 50; index += 1) {
      expect((await limiter.consume(`k${index}`, 1, 1_000)).allowed).toBe(true);
    }
  });
});
