import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import type { CurrencyCode } from "@akai/contracts";
import { toMinor } from "@akai/money";

import type {
  DiscountRecord,
  DiscountsRepository,
  RecordRedemptionInput,
} from "./discounts.repository";
import { DiscountError } from "./discounts.errors";
import { type DiscountClock, DiscountsService } from "./discounts.service";

const EUR = "EUR" as CurrencyCode;
const NOW = new Date("2026-07-20T12:00:00.000Z");

class FakeDiscountsRepository implements DiscountsRepository {
  readonly discounts = new Map<string, DiscountRecord>();
  readonly customerRedemptions = new Map<string, number>();
  readonly recorded: RecordRedemptionInput[] = [];

  findActiveByCode(code: string): Promise<DiscountRecord | null> {
    return Promise.resolve(this.discounts.get(code) ?? null);
  }

  countCustomerRedemptions(discountId: string, customerId: string): Promise<number> {
    return Promise.resolve(this.customerRedemptions.get(`${discountId}:${customerId}`) ?? 0);
  }

  recordRedemption(input: RecordRedemptionInput): Promise<void> {
    this.recorded.push(input);
    return Promise.resolve();
  }
}

function discount(overrides: Partial<DiscountRecord> = {}): DiscountRecord {
  return {
    id: "disc-1",
    code: "SAVE10",
    type: "PERCENTAGE",
    value: 1000,
    minimumSubtotal: null,
    currency: null,
    maxRedemptions: null,
    maxRedemptionsPerCustomer: null,
    timesRedeemed: 0,
    stackable: false,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

function harness(): { service: DiscountsService; repo: FakeDiscountsRepository } {
  const repo = new FakeDiscountsRepository();
  const clock: DiscountClock = { now: () => NOW };
  return { service: new DiscountsService(repo, clock), repo };
}

const baseInput = {
  code: "SAVE10",
  subtotalGross: toMinor(3000),
  currency: EUR,
  customerId: "cust-1",
} as const;

describe("DiscountsService.validate", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
    h.repo.discounts.set("SAVE10", discount());
  });

  it("validates a live code and returns the computed amount", async () => {
    const result = await h.service.validate(baseInput);
    expect(result.amount).toBe(300); // 10% of 3000
    expect(result.discountId).toBe("disc-1");
    expect(result.type).toBe("PERCENTAGE");
  });

  it("matches codes case-insensitively", async () => {
    const result = await h.service.validate({ ...baseInput, code: "  save10  " });
    expect(result.amount).toBe(300);
  });

  it("rejects an unknown code as invalid", async () => {
    await expect(h.service.validate({ ...baseInput, code: "NOPE" })).rejects.toBeInstanceOf(
      DiscountError,
    );
  });

  it("rejects a blank code", async () => {
    await expect(h.service.validate({ ...baseInput, code: "   " })).rejects.toBeInstanceOf(
      DiscountError,
    );
  });

  it("rejects a code that has not started", async () => {
    h.repo.discounts.set("SAVE10", discount({ startsAt: new Date("2026-08-01T00:00:00Z") }));
    await expect(h.service.validate(baseInput)).rejects.toMatchObject({ reason: "NOT_ACTIVE" });
  });

  it("rejects an expired code", async () => {
    h.repo.discounts.set("SAVE10", discount({ endsAt: new Date("2026-07-01T00:00:00Z") }));
    await expect(h.service.validate(baseInput)).rejects.toMatchObject({ reason: "EXPIRED" });
  });

  it("treats endsAt exactly at now as expired", async () => {
    h.repo.discounts.set("SAVE10", discount({ endsAt: NOW }));
    await expect(h.service.validate(baseInput)).rejects.toMatchObject({ reason: "EXPIRED" });
  });

  it("rejects a currency mismatch", async () => {
    h.repo.discounts.set("SAVE10", discount({ currency: "USD" }));
    await expect(h.service.validate(baseInput)).rejects.toMatchObject({
      reason: "CURRENCY_MISMATCH",
    });
  });

  it("allows a null-currency code in any currency", async () => {
    h.repo.discounts.set("SAVE10", discount({ currency: null }));
    await expect(h.service.validate(baseInput)).resolves.toMatchObject({ amount: 300 });
  });

  it("rejects a basket below the minimum subtotal", async () => {
    h.repo.discounts.set("SAVE10", discount({ minimumSubtotal: 5000 }));
    await expect(h.service.validate(baseInput)).rejects.toMatchObject({ reason: "BELOW_MINIMUM" });
  });

  it("accepts a basket at exactly the minimum subtotal", async () => {
    h.repo.discounts.set("SAVE10", discount({ minimumSubtotal: 3000 }));
    await expect(h.service.validate(baseInput)).resolves.toMatchObject({ amount: 300 });
  });

  it("rejects a globally exhausted code", async () => {
    h.repo.discounts.set("SAVE10", discount({ maxRedemptions: 5, timesRedeemed: 5 }));
    await expect(h.service.validate(baseInput)).rejects.toMatchObject({
      reason: "USAGE_LIMIT_REACHED",
    });
  });

  it("rejects a code the customer has already used up", async () => {
    h.repo.discounts.set("SAVE10", discount({ maxRedemptionsPerCustomer: 1 }));
    h.repo.customerRedemptions.set("disc-1:cust-1", 1);
    await expect(h.service.validate(baseInput)).rejects.toMatchObject({
      reason: "USAGE_LIMIT_REACHED",
    });
  });

  it("does not apply a per-customer cap to a guest", async () => {
    h.repo.discounts.set("SAVE10", discount({ maxRedemptionsPerCustomer: 1 }));
    // A guest is untracked; only the global cap (absent here) could bind.
    await expect(
      h.service.validate({ ...baseInput, customerId: null }),
    ).resolves.toMatchObject({ amount: 300 });
  });

  it("never records a redemption while merely validating", async () => {
    await h.service.validate(baseInput);
    expect(h.repo.recorded).toHaveLength(0);
  });
});

describe("DiscountsService.recordRedemption", () => {
  it("delegates to the repository", async () => {
    const h = harness();
    await h.service.recordRedemption({
      discountId: "disc-1",
      orderId: "order-1",
      customerId: "cust-1",
      amountApplied: 300,
    });
    expect(h.repo.recorded).toHaveLength(1);
    expect(h.repo.recorded[0]?.orderId).toBe("order-1");
  });
});
