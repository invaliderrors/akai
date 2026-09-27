import { describe, expect, it } from "vitest";
import {
  MINOR_MAX,
  isMinor,
  minorAmountSchema,
  moneySchema,
  nonNegativeMinorSchema,
  toMinor,
} from "./money";

describe("Minor money amounts", () => {
  it("accepts an integer number of cents", () => {
    expect(toMinor(4999)).toBe(4999);
    expect(toMinor(0)).toBe(0);
  });

  it("REJECTS floats — a float in the money path is always a bug", () => {
    // 49.99 euros is 4999 cents. If someone passes the euro figure, we must
    // fail loudly rather than silently truncate to 49 cents.
    expect(() => toMinor(49.99)).toThrow();
    expect(minorAmountSchema.safeParse(0.1).success).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(minorAmountSchema.safeParse(Number.NaN).success).toBe(false);
    expect(minorAmountSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it("clamps at MINOR_MAX to stay inside a 32-bit Postgres Int column", () => {
    expect(minorAmountSchema.safeParse(MINOR_MAX).success).toBe(true);
    expect(minorAmountSchema.safeParse(MINOR_MAX + 1).success).toBe(false);
  });

  it("allows negative amounts only on the signed schema", () => {
    expect(minorAmountSchema.safeParse(-500).success).toBe(true);
    expect(nonNegativeMinorSchema.safeParse(-500).success).toBe(false);
  });

  it("narrows unknown values with isMinor", () => {
    const value: unknown = 1234;
    expect(isMinor(value)).toBe(true);
    expect(isMinor("1234")).toBe(false);
    expect(isMinor(12.5)).toBe(false);
  });
});

describe("Money envelope", () => {
  it("requires an uppercase ISO-4217 currency", () => {
    expect(moneySchema.safeParse({ amount: 4999, currency: "EUR" }).success).toBe(true);
    expect(moneySchema.safeParse({ amount: 4999, currency: "eur" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: 4999, currency: "EURO" }).success).toBe(false);
  });

  it("rejects unknown keys so a stray field cannot ride along", () => {
    const result = moneySchema.safeParse({
      amount: 4999,
      currency: "EUR",
      display: "€49.99",
    });
    expect(result.success).toBe(false);
  });
});
