import { describe, expect, it } from "vitest";
import { MINOR_MAX, toMinor, type CurrencyCode } from "@akai/contracts";
import {
  formatMinorAsInput,
  formatPercentageAsInput,
  parseMajorUnitInput,
  parsePercentageInput,
  parseScaledDecimal,
} from "./money-input";

const EUR = "EUR" as CurrencyCode;
/** Zero-decimal currency: proves the exponent is read, not hardcoded to 2. */
const JPY = "JPY" as CurrencyCode;
/** Three-decimal currency, for the same reason in the other direction. */
const BHD = "BHD" as CurrencyCode;

/** Unwraps a success, failing the test with the error code if it is not one. */
function expectMinor(raw: string, currency: CurrencyCode = EUR): number {
  const result = parseMajorUnitInput(raw, currency);
  if (!result.ok) {
    throw new Error(`Expected "${raw}" to parse, got ${result.error}`);
  }
  return result.value;
}

function expectError(raw: string, currency: CurrencyCode = EUR): string {
  const result = parseMajorUnitInput(raw, currency);
  if (result.ok) {
    throw new Error(`Expected "${raw}" to be rejected, got ${result.value}`);
  }
  return result.error;
}

describe("parseMajorUnitInput", () => {
  it("converts a plain two-decimal amount", () => {
    expect(expectMinor("49.99")).toBe(4999);
  });

  it("pads a short fraction rather than truncating it", () => {
    // The bug this pins: "49.9" read as 499 would price a €49.90 product at
    // €4.99 — a 10x undercharge from a single missing zero.
    expect(expectMinor("49.9")).toBe(4990);
    expect(expectMinor("49.")).toBe(4900);
  });

  it("treats a whole number as major units", () => {
    expect(expectMinor("50")).toBe(5000);
    expect(expectMinor("0")).toBe(0);
  });

  it("accepts a comma as the decimal mark for Spanish-locale operators", () => {
    // The store's default locale is Spanish; "49,99" is what an operator types.
    expect(expectMinor("49,99")).toBe(4999);
  });

  it("survives the float cases that break Math.round(value * 100)", () => {
    // Math.round(1.005 * 100) === 100 in IEEE-754, losing a cent, because 1.005
    // is not exactly representable. String arithmetic has no such failure mode.
    expect(expectMinor("1.005", BHD)).toBe(1005);
    expect(expectMinor("8.165", BHD)).toBe(8165);
    expect(expectMinor("2.675", BHD)).toBe(2675);
    expect(expectMinor("1.15")).toBe(115);
    // Same value at EUR's exponent is a THREE-decimal string and is rejected —
    // the exponent comes from the currency, never from the input's shape.
    expect(expectError("1.005")).toBe("TOO_MANY_DECIMALS");
  });

  it("ignores surrounding and internal whitespace", () => {
    expect(expectMinor("  49.99 ")).toBe(4999);
    expect(expectMinor("49. 99")).toBe(4999);
  });

  it("normalises leading zeros", () => {
    expect(expectMinor("0049.99")).toBe(4999);
    expect(expectMinor("00.00")).toBe(0);
  });

  it("rejects an empty or whitespace-only field", () => {
    expect(expectError("")).toBe("EMPTY");
    expect(expectError("   ")).toBe("EMPTY");
  });

  it("rejects a grouping separator instead of guessing the convention", () => {
    // "1,234" is €1.234 in es-ES and €1234 in en-IE. Guessing is a 1000x
    // pricing error; refusing is not.
    expect(expectError("1,234.56")).toBe("GROUPING_SEPARATOR");
    expect(expectError("1.234,56")).toBe("GROUPING_SEPARATOR");
  });

  it("rejects a negative price with its own message", () => {
    expect(expectError("-1.00")).toBe("NEGATIVE");
  });

  it("rejects an over-long fraction rather than silently rounding it", () => {
    // Rounding "49.999" either over- or undercharges by a cent, and hides a typo
    // from the person standing right there to fix it.
    expect(expectError("49.999")).toBe("TOO_MANY_DECIMALS");
    expect(expectError("49.9999", BHD)).toBe("TOO_MANY_DECIMALS");
  });

  it("rejects any fraction at all on a zero-decimal currency", () => {
    expect(expectMinor("500", JPY)).toBe(500);
    expect(expectError("500.5", JPY)).toBe("TOO_MANY_DECIMALS");
  });

  it("rejects the numeric shapes Number() would happily accept", () => {
    // Each of these is a valid JS number literal (or coerces to one) and none is
    // a valid price. Number("") === 0 is the free-product case.
    expect(expectError("1e3")).toBe("NOT_A_NUMBER");
    expect(expectError("0x10")).toBe("NOT_A_NUMBER");
    expect(expectError("+5")).toBe("NOT_A_NUMBER");
    expect(expectError("Infinity")).toBe("NOT_A_NUMBER");
    expect(expectError(".")).toBe("NOT_A_NUMBER");
    expect(expectError("abc")).toBe("NOT_A_NUMBER");
    expect(expectError(".99")).toBe("NOT_A_NUMBER");
  });

  it("rejects an amount above the platform cap", () => {
    // MINOR_MAX is 2_000_000_000 minor units = €20,000,000.
    expect(expectMinor("20000000")).toBe(MINOR_MAX);
    expect(expectError("20000000.01")).toBe("TOO_LARGE");
    expect(expectError("999999999999")).toBe("TOO_LARGE");
  });
});

describe("formatMinorAsInput", () => {
  it("renders minor units as a plain major-unit string", () => {
    expect(formatMinorAsInput(toMinor(4999), EUR)).toBe("49.99");
    expect(formatMinorAsInput(toMinor(4990), EUR)).toBe("49.90");
  });

  it("pads amounts below one major unit", () => {
    // 5 cents must render "0.05", never "0.5" or ".5".
    expect(formatMinorAsInput(toMinor(5), EUR)).toBe("0.05");
    expect(formatMinorAsInput(toMinor(0), EUR)).toBe("0.00");
  });

  it("omits the fraction entirely on a zero-decimal currency", () => {
    expect(formatMinorAsInput(toMinor(500), JPY)).toBe("500");
  });

  it("uses three decimals on a three-decimal currency", () => {
    expect(formatMinorAsInput(toMinor(1005), BHD)).toBe("1.005");
  });

  it("round-trips through the parser for every representative amount", () => {
    // The property that actually matters: loading a product into the edit form
    // and saving it without touching the price must not change the price.
    for (const amount of [0, 1, 5, 99, 100, 4999, 100_000, MINOR_MAX]) {
      const rendered = formatMinorAsInput(toMinor(amount), EUR);
      expect(expectMinor(rendered)).toBe(amount);
    }
  });
});

describe("Colombian pesos — entered in whole pesos, stored in centavos", () => {
  const COP = "COP" as CurrencyCode;

  it("reads a plain whole-peso amount and stores it ×100", () => {
    // $89.000 is 8_900_000 centavos — exactly what amount_in_cents expects.
    expect(expectMinor("89000", COP)).toBe(8_900_000);
    expect(expectMinor("0", COP)).toBe(0);
    expect(expectMinor(" 15 000 ", COP)).toBe(1_500_000);
  });

  it("accepts the dot (Colombian) or comma grouping, in groups of three", () => {
    expect(expectMinor("89.000", COP)).toBe(8_900_000);
    expect(expectMinor("1.234.567", COP)).toBe(123_456_700);
    expect(expectMinor("219,000", COP)).toBe(21_900_000);
  });

  it("refuses a decimal: pesos are entered without centavos", () => {
    expect(expectError("89.5", COP)).toBe("TOO_MANY_DECIMALS");
    expect(expectError("89,50", COP)).toBe("TOO_MANY_DECIMALS");
  });

  it("refuses malformed grouping rather than guessing", () => {
    expect(expectError("1.23.456", COP)).toBe("GROUPING_SEPARATOR");
    expect(expectError("89.0000", COP)).toBe("GROUPING_SEPARATOR");
    expect(expectError("1.234,567", COP)).toBe("GROUPING_SEPARATOR");
  });

  it("keeps the money parser's other refusals", () => {
    expect(expectError("", COP)).toBe("EMPTY");
    expect(expectError("-5000", COP)).toBe("NEGATIVE");
    expect(expectError("1e3", COP)).toBe("NOT_A_NUMBER");
    expect(expectError("$89.000", COP)).toBe("NOT_A_NUMBER");
  });

  it("caps at the platform maximum, in pesos", () => {
    // MINOR_MAX centavos is $20.000.000.
    expect(expectMinor("20.000.000", COP)).toBe(MINOR_MAX);
    expect(expectError("20.000.001", COP)).toBe("TOO_LARGE");
  });

  it("renders whole pesos back into the input, and round-trips", () => {
    expect(formatMinorAsInput(toMinor(8_900_000), COP)).toBe("89000");
    for (const amount of [0, 100, 1_500_000, 8_900_000, 30_000_000, MINOR_MAX]) {
      expect(expectMinor(formatMinorAsInput(toMinor(amount), COP), COP)).toBe(amount);
    }
  });

  it("shows stray centavos exactly, so the parser refuses them instead of rounding", () => {
    const rendered = formatMinorAsInput(toMinor(8_900_050), COP);
    expect(rendered).toBe("89000.50");
    expect(expectError(rendered, COP)).toBe("TOO_MANY_DECIMALS");
  });
});

describe("parsePercentageInput", () => {
  /** Unwraps a success, failing with the error code if it is not one. */
  function expectBps(raw: string): number {
    const result = parsePercentageInput(raw);
    if (!result.ok) {
      throw new Error(`Expected "${raw}" to parse, got ${result.error}`);
    }
    return result.value;
  }

  function expectBpsError(raw: string): string {
    const result = parsePercentageInput(raw);
    if (result.ok) {
      throw new Error(`Expected "${raw}" to be rejected, got ${result.value}`);
    }
    return result.error;
  }

  it("converts a whole percent into basis points", () => {
    // The conversion the discount form depends on: an operator types 10 and the
    // API stores 1000. Reading 1000 as "1000%" or storing 10 as "0.1%" are both
    // hundred-fold coupon errors.
    expect(expectBps("10")).toBe(1000);
    expect(expectBps("100")).toBe(10_000);
    expect(expectBps("0")).toBe(0);
  });

  it("keeps two decimal places of a percent, which is exactly one basis point", () => {
    expect(expectBps("12.5")).toBe(1250);
    expect(expectBps("12.55")).toBe(1255);
    expect(expectBps("0.01")).toBe(1);
  });

  it("accepts a comma as the decimal mark, like the money parser", () => {
    // Same reason: the store's default locale is Spanish and "12,5" is what an
    // operator types.
    expect(expectBps("12,5")).toBe(1250);
  });

  it("rejects more than a basis point of precision rather than rounding it", () => {
    // "12.345%" is not a rate anybody meant; rounding it either way hides a typo
    // the operator is standing right there to fix.
    expect(expectBpsError("12.345")).toBe("TOO_MANY_DECIMALS");
  });

  it("refuses anything above 100%", () => {
    // The API caps a PERCENTAGE discount at 10000 bps so a code can never
    // over-refund. The form says so before the round trip.
    expect(expectBpsError("100.01")).toBe("TOO_LARGE");
    expect(expectBpsError("150")).toBe("TOO_LARGE");
  });

  it("inherits the money parser's refusals verbatim", () => {
    // The point of sharing one implementation: none of these had to be
    // re-decided, and none can drift from the price field's behaviour.
    expect(expectBpsError("")).toBe("EMPTY");
    expect(expectBpsError("-5")).toBe("NEGATIVE");
    expect(expectBpsError("1,234.5")).toBe("GROUPING_SEPARATOR");
    expect(expectBpsError("1e2")).toBe("NOT_A_NUMBER");
  });
});

describe("formatPercentageAsInput", () => {
  it("round-trips through the parser", () => {
    // Loading a coupon into the edit form and saving it untouched must not move
    // the rate by a basis point.
    for (const bps of [0, 1, 250, 1000, 1255, 10_000]) {
      expect(parsePercentageInput(formatPercentageAsInput(bps))).toEqual({
        ok: true,
        value: bps,
      });
    }
  });
});

describe("parseScaledDecimal", () => {
  it("is the one implementation both wrappers use", () => {
    // Money at EUR's exponent and a percentage are the same call with different
    // options — which is the whole reason there is not a second ~90-line parser
    // living in the discount form.
    expect(parseScaledDecimal("49.99", { exponent: 2, max: MINOR_MAX })).toEqual({
      ok: true,
      value: 4999,
    });
    expect(parseScaledDecimal("12.5", { exponent: 2, max: 10_000 })).toEqual({
      ok: true,
      value: 1250,
    });
  });

  it("honours an arbitrary exponent, not a hardcoded 2", () => {
    expect(parseScaledDecimal("1.005", { exponent: 3, max: MINOR_MAX })).toEqual({
      ok: true,
      value: 1005,
    });
    expect(parseScaledDecimal("500", { exponent: 0, max: MINOR_MAX })).toEqual({
      ok: true,
      value: 500,
    });
    expect(parseScaledDecimal("5.5", { exponent: 0, max: MINOR_MAX })).toEqual({
      ok: false,
      error: "TOO_MANY_DECIMALS",
    });
  });
});
