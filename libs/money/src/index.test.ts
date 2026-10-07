import { describe, expect, it } from "vitest";
import { MINOR_MAX } from "@akai/contracts";
import {
  ZERO,
  add,
  allocate,
  allocateEvenly,
  applyBasisPoints,
  displayFractionDigits,
  formatAggregateMinor,
  formatMoney,
  fromDecimalString,
  grossFromNet,
  intlLocale,
  minorUnitExponent,
  multiply,
  parseMinorUnitString,
  roundHalfUp,
  splitGross,
  subtract,
  sum,
  toDecimalString,
  toMinor,
  tryParseMinorUnitString,
} from "./index";

describe("arithmetic", () => {
  it("adds, subtracts and sums", () => {
    expect(add(toMinor(1999), toMinor(1))).toBe(2000);
    expect(subtract(toMinor(2000), toMinor(1))).toBe(1999);
    expect(sum([toMinor(100), toMinor(250), toMinor(3)])).toBe(353);
    expect(sum([])).toBe(ZERO);
  });

  it("multiplies by a line quantity", () => {
    expect(multiply(toMinor(1999), 3)).toBe(5997);
  });

  it("refuses a fractional multiply factor so rounding is never implicit", () => {
    expect(() => multiply(toMinor(1000), 1.5)).toThrow(/integer factor/);
  });

  it("throws on overflow rather than wrapping", () => {
    expect(() => multiply(toMinor(2_000_000_000), 2)).toThrow(/overflow/i);
  });
});

describe("rounding rule", () => {
  it("rounds half-up, symmetrically across zero", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3); // NOT banker's rounding, which gives 2
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });

  it("applies basis points", () => {
    // 21% VAT on €100.00 net
    expect(applyBasisPoints(toMinor(10_000), 2100)).toBe(2100);
    // 10% on an odd amount, rounded half-up: 999 * 0.10 = 99.9 -> 100
    expect(applyBasisPoints(toMinor(999), 1000)).toBe(100);
  });
});

describe("VAT-inclusive splitting", () => {
  it("guarantees net + tax === gross exactly", () => {
    for (const grossAmount of [4999, 100, 1, 12_345, 999_99]) {
      const split = splitGross(toMinor(grossAmount), 2100);
      expect(split.net + split.tax).toBe(grossAmount);
    }
  });

  it("splits a $89.000 COP tee at 19% IVA so net + tax foots exactly", () => {
    const parts = splitGross(toMinor(8_900_000), 1900);
    expect(parts.net).toBe(7_478_992);
    expect(parts.tax).toBe(1_421_008);
    expect(parts.net + parts.tax).toBe(8_900_000);
  });

  it("splits €49.99 at 21% into 4131 net + 868 tax", () => {
    const split = splitGross(toMinor(4999), 2100);
    expect(split.net).toBe(4131);
    expect(split.tax).toBe(868);
  });

  it("round-trips net -> gross", () => {
    const built = grossFromNet(toMinor(10_000), 2100);
    expect(built.gross).toBe(12_100);
    expect(built.tax).toBe(2100);
  });

  it("treats a zero rate as a no-op", () => {
    const split = splitGross(toMinor(4999), 0);
    expect(split.net).toBe(4999);
    expect(split.tax).toBe(0);
  });
});

describe("allocate — the no-lost-cent guarantee", () => {
  it("distributes a remainder instead of dropping it", () => {
    // The canonical Fowler example: 5 cents across 3 ways.
    expect(allocateEvenly(toMinor(5), 3)).toEqual([2, 2, 1]);
  });

  it("always sums back to the original amount", () => {
    const cases: ReadonlyArray<[number, readonly number[]]> = [
      [1000, [1, 1, 1]],
      [999, [3, 7]],
      [1, [1, 1, 1, 1, 1]],
      [123_45, [2, 3, 5, 7, 11]],
      [0, [1, 1]],
    ];
    for (const [amount, ratios] of cases) {
      const shares = allocate(toMinor(amount), ratios);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(shares).toHaveLength(ratios.length);
    }
  });

  it("handles negative amounts (a discount pushed onto lines)", () => {
    const shares = allocate(toMinor(-1000), [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(-1000);
  });

  it("splits proportionally to the ratios", () => {
    // A €10.00 order discount across lines worth €30 and €70.
    expect(allocate(toMinor(1000), [30, 70])).toEqual([300, 700]);
  });

  it("rejects degenerate ratio sets", () => {
    expect(() => allocate(toMinor(100), [])).toThrow();
    expect(() => allocate(toMinor(100), [0, 0])).toThrow(/sum to zero/);
    expect(() => allocate(toMinor(100), [-1, 2])).toThrow(/non-negative/);
  });
});

describe("parseMinorUnitString — the external-string boundary", () => {
  it("parses a well-formed minor-unit string", () => {
    expect(parseMinorUnitString("4999")).toBe(4999);
    expect(parseMinorUnitString("0")).toBe(0);
    expect(parseMinorUnitString(" 250 ")).toBe(250);
  });

  it("REJECTS the inputs the old parseInt(x || '0') silently turned into a free product", () => {
    expect(() => parseMinorUnitString("")).toThrow();
    expect(() => parseMinorUnitString("abc")).toThrow();
    expect(() => parseMinorUnitString(undefined)).toThrow(TypeError);
    expect(() => parseMinorUnitString(null)).toThrow(TypeError);
  });

  it("REJECTS a decimal string rather than truncating it", () => {
    // parseInt("49.99") === 49 — a 99% discount, delivered silently.
    expect(() => parseMinorUnitString("49.99")).toThrow(/MAJOR units/);
  });

  it("rejects a number, which would bypass the audited boundary", () => {
    expect(() => parseMinorUnitString(4999)).toThrow(TypeError);
  });

  it("rejects values beyond the safe integer range", () => {
    expect(() => parseMinorUnitString("99999999999999999999")).toThrow();
  });

  it("degrades to null in the non-throwing variant", () => {
    expect(tryParseMinorUnitString("abc")).toBeNull();
    expect(tryParseMinorUnitString("4999")).toBe(4999);
  });
});

describe("formatting", () => {
  // Intl output contains non-breaking spaces; normalise before asserting.
  const normalise = (value: string): string => value.replace(/[\u00A0\u202F]/g, " ");

  it("formats COP as a Colombian shopper reads it: whole pesos, dot grouping, no decimals", () => {
    // 8_900_000 centavos is $89.000 — stored in centavos, never DISPLAYED in them.
    expect(normalise(formatMoney(toMinor(8_900_000), "COP", "es"))).toBe("$ 89.000");
    expect(normalise(formatMoney(toMinor(123_400), "COP", "es"))).toBe("$ 1.234");
    expect(normalise(formatMoney(toMinor(0), "COP", "es"))).toBe("$ 0");
  });

  it("formats COP in English with a bare leading symbol and comma grouping", () => {
    expect(normalise(formatMoney(toMinor(8_900_000), "COP", "en"))).toBe("$89,000");
  });

  it("rounds stray centavos for DISPLAY only", () => {
    expect(normalise(formatMoney(toMinor(8_900_060), "COP", "es"))).toBe("$ 89.001");
  });

  it("still formats a two-decimal currency with its decimals", () => {
    expect(normalise(formatMoney(toMinor(123_456), "EUR", "en"))).toBe("€1,234.56");
    expect(normalise(formatMoney(toMinor(123_456), "EUR", "es"))).toBe("€ 1.234,56");
  });

  it("formats Spanish with es-CO and English with en-US", () => {
    expect(intlLocale("es")).toBe("es-CO");
    expect(intlLocale("en")).toBe("en-US");
  });

  it("respects currencies whose minor unit is not 1/100", () => {
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("EUR")).toBe(2);
    expect(minorUnitExponent("KWD")).toBe(3);
    // 5000 JPY minor units is ¥5000, not ¥50.
    expect(normalise(formatMoney(toMinor(5000), "JPY", "en"))).toContain("5,000");
  });

  it("keeps COP's ISO exponent at 2 (centavos) while displaying it with 0 digits", () => {
    expect(minorUnitExponent("COP")).toBe(2);
    expect(displayFractionDigits("COP")).toBe(0);
    expect(displayFractionDigits("EUR")).toBe(2);
    expect(displayFractionDigits("JPY")).toBe(0);
  });
});

describe("formatAggregateMinor — the display-only path around the Minor cap", () => {
  // Intl separates a Spanish amount from its symbol with a no-break space, and
  // groups with a narrow one. Both normalise to a plain space before asserting.
  const normalise = (value: string): string => value.replace(/[\u00A0\u202F]/g, " ");

  it("renders exactly what formatMoney renders for an in-range amount", () => {
    // Same Intl call, so an aggregate tile and a line total cannot drift into
    // two spellings of the same peso figure.
    expect(normalise(formatAggregateMinor(8_900_000, "COP", "es"))).toBe("$ 89.000");
    expect(normalise(formatAggregateMinor(8_900_000, "COP", "en"))).toBe("$89,000");
    expect(normalise(formatAggregateMinor(8_900_000, "COP", "es"))).toBe(
      normalise(formatMoney(toMinor(8_900_000), "COP", "es")),
    );
  });

  it("formats an aggregate ABOVE MINOR_MAX where toMinor throws", () => {
    // THE WHOLE REASON THE FUNCTION EXISTS. MINOR_MAX is $20.000.000 COP —
    // correct as a ceiling on one order and wrong as a ceiling on lifetime
    // revenue. A dashboard that brands its aggregates starts crashing on a
    // SUCCESSFUL business, so the same figure that kills toMinor must still
    // render here.
    const lifetimeRevenue = MINOR_MAX * 50;

    expect(() => toMinor(lifetimeRevenue)).toThrow();
    expect(normalise(formatAggregateMinor(lifetimeRevenue, "COP", "es"))).toBe(
      "$ 1.000.000.000",
    );
    expect(normalise(formatAggregateMinor(lifetimeRevenue, "COP", "en"))).toBe("$1,000,000,000");
  });

  it("respects a currency whose minor unit is not 1/100, like formatMoney does", () => {
    expect(normalise(formatAggregateMinor(5000, "JPY", "en"))).toContain("5,000");
  });

  it("carries a sign, so a refunded-total tile is not read as a credit", () => {
    expect(normalise(formatAggregateMinor(-4_200_000, "COP", "es"))).toBe("-$ 42.000");
  });
});

describe("toDecimalString", () => {
  it("emits a machine-readable decimal, never a localized one", () => {
    // The point of the function: `formatMoney(…, "es")` gives "1.234,56 €",
    // which a schema.org consumer would read as 1234 with a stray comma.
    expect(toDecimalString(toMinor(123_456), "EUR")).toBe("1234.56");
  });

  it("keeps a leading zero for sub-unit amounts", () => {
    // ".05" is not a valid decimal for structured data.
    expect(toDecimalString(toMinor(5), "EUR")).toBe("0.05");
    expect(toDecimalString(toMinor(0), "EUR")).toBe("0.00");
  });

  it("uses the currency's own precision, not a hardcoded two", () => {
    expect(toDecimalString(toMinor(5000), "JPY")).toBe("5000");
    expect(toDecimalString(toMinor(5000), "KWD")).toBe("5.000");
  });

  it("works at the top of the representable range, where float division frays", () => {
    // MINOR_MAX is 2_000_000_000 minor units. This is one cent below it, and the
    // point is that no division happens at all: the digits are sliced, so there
    // is no magnitude at which the last two characters can drift.
    expect(toDecimalString(toMinor(1_999_999_999), "EUR")).toBe("19999999.99");
  });

  it("carries a sign for negative amounts (refund lines)", () => {
    expect(toDecimalString(toMinor(-3450), "EUR")).toBe("-34.50");
  });
});

describe("fromDecimalString", () => {
  it("reads exact major-unit decimal strings", () => {
    // A provider that speaks major units sends an exact decimal STRING so no
    // float rounds it in transit.
    expect(fromDecimalString("1234.56", "EUR")).toBe(123_456);
    expect(fromDecimalString("0.05", "EUR")).toBe(5);
    expect(fromDecimalString("0.00", "EUR")).toBe(0);
  });

  it("uses the currency's own precision, not a hardcoded two", () => {
    expect(fromDecimalString("5000", "JPY")).toBe(5000);
    expect(fromDecimalString("5.000", "KWD")).toBe(5000);
  });

  it("accepts a bare integer for a currency that has minor units", () => {
    // A provider may emit "10" as readily as "10.00" for a round amount.
    expect(fromDecimalString("10", "EUR")).toBe(1000);
  });

  it("accepts fewer fraction digits than the currency's exponent", () => {
    // "49.9" is unambiguous: nine tenths, not nine hundredths.
    expect(fromDecimalString("49.9", "EUR")).toBe(4990);
  });

  it("carries a sign for negative amounts", () => {
    expect(fromDecimalString("-34.50", "EUR")).toBe(-3450);
  });

  it("round-trips every amount toDecimalString can emit", () => {
    // The property that makes the boundary safe in both directions. Sampled
    // rather than exhaustive, but across the full magnitude range including the
    // decades where float division starts to fray.
    for (const currency of ["EUR", "JPY", "KWD"] as const) {
      for (let minor = 1; minor <= 1_000_000_000; minor = Math.ceil(minor * 1.7)) {
        const encoded = toDecimalString(toMinor(minor), currency);
        expect(fromDecimalString(encoded, currency)).toBe(minor);
      }
    }
  });

  it("round-trips through the float form a webhook delivers", () => {
    // `PaymentLegacy.total` is a bare `number`, not a Money string. `String(n)`
    // is JS's shortest round-tripping decimal, so feeding it back in is exact —
    // this is the step that would silently lose a cent if it were `n * 100`.
    for (let minor = 1; minor <= 100_000_000; minor = Math.ceil(minor * 1.9)) {
      const asFloat = Number(toDecimalString(toMinor(minor), "EUR"));
      expect(fromDecimalString(String(asFloat), "EUR")).toBe(minor);
    }
  });

  it("REJECTS more precision than the currency can hold", () => {
    // The one that matters. Rounding "49.999" to 5000 would invent a cent the
    // provider never charged and quietly agree with a total we never computed;
    // the settlement check must see a failure instead.
    expect(() => fromDecimalString("49.999", "EUR")).toThrow(RangeError);
    expect(() => fromDecimalString("5000.5", "JPY")).toThrow(RangeError);
  });

  it("REJECTS exponent notation rather than resolving it", () => {
    // `Number("1e3")` is 1000. Accepting it would mean a provider could express
    // an amount in a form our own encoder never emits, through a path nobody
    // reviewed.
    expect(() => fromDecimalString("1e3", "EUR")).toThrow(RangeError);
    expect(() => fromDecimalString("1E3", "EUR")).toThrow(RangeError);
  });

  it("REJECTS the shapes that would otherwise coerce to a number", () => {
    for (const malformed of ["", " ", "+10.00", "abc", "NaN", "Infinity", "10.", ".10", "1,00"]) {
      expect(() => fromDecimalString(malformed, "EUR")).toThrow(RangeError);
    }
  });

  it("REJECTS a non-string, rather than stringifying it", () => {
    // Guards the webhook path specifically: `PaymentLegacy.total` is
    // `number | null`, and a null that reached here must not become "null".
    expect(() => fromDecimalString(null as unknown as string, "EUR")).toThrow(TypeError);
    expect(() => fromDecimalString(49.99 as unknown as string, "EUR")).toThrow(TypeError);
  });

  it("REJECTS an amount beyond the representable range", () => {
    expect(() => fromDecimalString("99999999999.99", "EUR")).toThrow(RangeError);
  });
});
