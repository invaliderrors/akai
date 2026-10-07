import { HttpStatus, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  PublicRateLimitDecision,
  PublicRateLimiter,
} from "./rate-limiter.port";
import { THROTTLE_RULES, type ThrottleRule } from "./throttle.decorator";
import { ThrottleGuard, buildThrottleKey } from "./throttle.guard";

/**
 * A limiter that records every key it was asked about.
 *
 * The keys matter more than the verdict: a guard that allows or denies correctly
 * but derives one key for two different clients has no limit at all, and that
 * bug is invisible from the outside until someone is throttled by a stranger's
 * traffic.
 */
class RecordingLimiter implements PublicRateLimiter {
  readonly calls: { key: string; limit: number; windowMs: number }[] = [];
  private allowed = true;

  denyNext(): void {
    this.allowed = false;
  }

  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<PublicRateLimitDecision> {
    this.calls.push({ key, limit, windowMs });
    return Promise.resolve(
      this.allowed
        ? { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 }
        : { allowed: false, remaining: 0, retryAfterSeconds: 42 },
    );
  }
}

interface ContextOptions {
  readonly rule?: ThrottleRule | undefined;
  readonly ip?: string | undefined;
  readonly type?: "http" | "rpc";
}

function contextFor(options: ContextOptions): ExecutionContext {
  const request = options.ip === undefined ? {} : { ip: options.ip };

  // Hand-built rather than mocked wholesale: only the four members the guard
  // touches are provided, so a future guard that reaches for a fifth fails here
  // loudly instead of reading `undefined` off a permissive mock.
  const context = {
    getType: (): string => options.type ?? "http",
    getHandler: (): unknown => handlerMarker,
    getClass: (): unknown => classMarker,
    switchToHttp: () => ({ getRequest: (): unknown => request }),
  };

  return context as unknown as ExecutionContext;
}

const handlerMarker = function handler(): void {};
const classMarker = class Controller {};

function reflectorReturning(rule: ThrottleRule | undefined): Reflector {
  // getAllAndOverride is the only method the guard uses; stubbing it keeps the
  // test free of decorator-metadata plumbing while still driving the guard's
  // real lookup path.
  const stub = {
    getAllAndOverride: (): ThrottleRule | undefined => rule,
  };
  return stub as unknown as Reflector;
}

describe("buildThrottleKey", () => {
  it("namespaces public buckets away from the auth counters in the same table", () => {
    expect(buildThrottleKey(THROTTLE_RULES.contact, "203.0.113.7")).toBe(
      "public:contact:203.0.113.7",
    );
  });

  it("separates buckets by rule name so catalog reads cannot starve checkout", () => {
    const ip = "203.0.113.7";

    expect(buildThrottleKey(THROTTLE_RULES.catalogRead, ip)).not.toBe(
      buildThrottleKey(THROTTLE_RULES.checkout, ip),
    );
  });

  it("separates buckets by client", () => {
    expect(buildThrottleKey(THROTTLE_RULES.checkout, "198.51.100.1")).not.toBe(
      buildThrottleKey(THROTTLE_RULES.checkout, "198.51.100.2"),
    );
  });

  it("collapses an unattributable client into one shared bucket rather than a fresh one", () => {
    expect(buildThrottleKey(THROTTLE_RULES.checkout, null)).toBe(
      "public:checkout:unknown",
    );
  });
});

describe("ThrottleGuard", () => {
  let limiter: RecordingLimiter;

  beforeEach(() => {
    limiter = new RecordingLimiter();
  });

  it("allows an undecorated route without touching the limiter", async () => {
    const guard = new ThrottleGuard(reflectorReturning(undefined), limiter);

    await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
    expect(limiter.calls).toHaveLength(0);
  });

  it("consumes the decorated rule's budget for the requesting client", async () => {
    const guard = new ThrottleGuard(
      reflectorReturning(THROTTLE_RULES.cartWrite),
      limiter,
    );

    await expect(
      guard.canActivate(contextFor({ rule: THROTTLE_RULES.cartWrite, ip: "203.0.113.9" })),
    ).resolves.toBe(true);

    expect(limiter.calls).toEqual([
      {
        key: "public:cart-write:203.0.113.9",
        limit: THROTTLE_RULES.cartWrite.limit,
        windowMs: THROTTLE_RULES.cartWrite.windowMs,
      },
    ]);
  });

  it("throws 429 with the retry delay once the budget is spent", async () => {
    limiter.denyNext();
    const guard = new ThrottleGuard(reflectorReturning(THROTTLE_RULES.contact), limiter);

    const attempt = guard.canActivate(contextFor({ ip: "203.0.113.9" }));

    await expect(attempt).rejects.toBeInstanceOf(HttpException);
    await expect(attempt).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    await expect(attempt).rejects.toThrow("42 seconds");
  });

  it("skips non-HTTP contexts, which have no client to attribute a bucket to", async () => {
    const guard = new ThrottleGuard(reflectorReturning(THROTTLE_RULES.contact), limiter);

    await expect(guard.canActivate(contextFor({ type: "rpc" }))).resolves.toBe(true);
    expect(limiter.calls).toHaveLength(0);
  });
});

describe("THROTTLE_RULES", () => {
  it("keeps money-creating writes tighter than reads", () => {
    expect(THROTTLE_RULES.checkout.limit).toBeLessThan(
      THROTTLE_RULES.catalogRead.limit,
    );
    expect(THROTTLE_RULES.cartWrite.limit).toBeLessThan(
      THROTTLE_RULES.catalogRead.limit,
    );
    // Each return-page confirmation can cost a Wompi lookup: never looser than checkout.
    expect(THROTTLE_RULES.paymentConfirm.limit).toBeLessThanOrEqual(
      THROTTLE_RULES.checkout.limit,
    );
  });

  it("keeps the outbound-email route the tightest bucket of all", () => {
    const others = [
      THROTTLE_RULES.catalogRead,
      THROTTLE_RULES.cartWrite,
      THROTTLE_RULES.shippingQuote,
      THROTTLE_RULES.checkout,
    ];

    for (const rule of others) {
      // Compare rate, not raw limit: contact uses a 15-minute window.
      const contactRate = THROTTLE_RULES.contact.limit / THROTTLE_RULES.contact.windowMs;
      expect(contactRate).toBeLessThan(rule.limit / rule.windowMs);
    }
  });

  it("gives every bucket a distinct name", () => {
    const names = Object.values(THROTTLE_RULES).map((rule) => rule.name);

    expect(new Set(names).size).toBe(names.length);
  });
});
