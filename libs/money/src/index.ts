/**
 * @akai/money — the ONLY money implementation in the platform.
 *
 * Absorbs the old apps/storefront/src/lib/pricing.ts and fixes its two defects:
 *   1. it hardcoded `Intl.NumberFormat("en-US")` — a Colombian shopper expects
 *      "$ 89.000", not "$89,000.00" (every amount now formats in `es-CO`);
 *   2. it parsed Woo's string minor units inline with `parseInt(x || "0")`,
 *      which silently turns malformed input into zero — a free product.
 *
 * The `Minor` brand is imported from @akai/contracts rather than redeclared;
 * see the rationale at the top of libs/contracts/src/lib/money.ts. This lib owns
 * all ARITHMETIC over that type.
 */

import {
  MINOR_MAX,
  STORE_LOCALE,
  type CurrencyCode,
  type Minor,
  type Money,
  toMinor,
} from "@akai/contracts";

export type { Minor, Money, CurrencyCode };
export { toMinor };

/** Zero, pre-branded. Avoids `toMinor(0)` noise in reducers. */
export const ZERO: Minor = toMinor(0);

/**
 * Every arithmetic result goes through here. Two things it guarantees that raw
 * `+` does not: the result is still an integer (so no float leaked in via a
 * mis-typed input), and it is still inside the range a Postgres Int column can
 * hold. Overflow is thrown, never wrapped.
 */
function guard(value: number, operation: string): Minor {
  if (!Number.isInteger(value)) {
    throw new RangeError(
      `Money ${operation} produced a non-integer result (${value}). ` +
        `Minor units must stay integral — a float entered the money path.`,
    );
  }
  if (value > MINOR_MAX || value < -MINOR_MAX) {
    throw new RangeError(
      `Money ${operation} overflowed the supported range (${value}). ` +
        `Limit is ±${MINOR_MAX} minor units.`,
    );
  }
  return value as Minor;
}

export function add(a: Minor, b: Minor): Minor {
  return guard(a + b, "add");
}

export function subtract(a: Minor, b: Minor): Minor {
  return guard(a - b, "subtract");
}

export function sum(amounts: readonly Minor[]): Minor {
  return amounts.reduce<Minor>((total, amount) => add(total, amount), ZERO);
}

export function negate(amount: Minor): Minor {
  return guard(-amount, "negate");
}

export function absolute(amount: Minor): Minor {
  return guard(Math.abs(amount), "absolute");
}

/**
 * Multiply by an integer factor (a line quantity). Separate from the
 * fractional path so the overwhelmingly common case cannot round at all.
 */
export function multiply(amount: Minor, factor: number): Minor {
  if (!Number.isInteger(factor)) {
    throw new RangeError(
      `multiply() takes an integer factor; got ${factor}. ` +
        `For a rate or percentage use multiplyByRate() or applyBasisPoints(), ` +
        `which document their rounding.`,
    );
  }
  return guard(amount * factor, "multiply");
}

/**
 * THE ROUNDING RULE, stated once: round HALF-UP, per line, then sum.
 *
 * The alternative (sum then round) produces different totals on multi-line
 * orders, and the difference is a real accounting defect that surfaces as an
 * invoice that does not foot. Half-up is chosen because it matches what
 * invoicing conventions and every finance stakeholder expect; banker's rounding
 * would be defensible but must not be mixed in.
 *
 * Note `Math.round` is half-up only toward +∞ (it maps -0.5 to -0), so
 * negatives are mirrored explicitly to keep the rule symmetric.
 */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Multiply by an arbitrary rate, rounding half-up. Use for tax and discounts. */
export function multiplyByRate(amount: Minor, rate: number): Minor {
  if (!Number.isFinite(rate)) {
    throw new RangeError(`Rate must be finite; got ${rate}`);
  }
  return guard(roundHalfUp(amount * rate), "multiplyByRate");
}

/**
 * Apply a rate expressed in BASIS POINTS (1 bp = 0.01%).
 *
 * Tax rates are stored as integer bps rather than floats precisely so the
 * stored rate is exact: 19% IVA is 1900, not 0.19000000000000003.
 */
export function applyBasisPoints(amount: Minor, basisPoints: number): Minor {
  if (!Number.isInteger(basisPoints)) {
    throw new RangeError(`Basis points must be an integer; got ${basisPoints}`);
  }
  return guard(roundHalfUp((amount * basisPoints) / 10_000), "applyBasisPoints");
}

/**
 * Extract the tax component from a VAT-INCLUSIVE (gross) amount.
 *
 * Colombian consumer prices are displayed IVA-inclusive, so this is the
 * direction that actually runs at checkout: given $89.000 gross at 19%, the net
 * is gross / 1.19 and the tax is the remainder. Deriving tax as `gross - net`
 * rather than computing it independently guarantees `net + tax === gross`
 * exactly, with no ±1 cent drift on the invoice.
 */
export function splitGross(
  gross: Minor,
  taxRateBps: number,
): { net: Minor; tax: Minor; gross: Minor } {
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0) {
    throw new RangeError(
      `Tax rate must be a non-negative integer bps; got ${taxRateBps}`,
    );
  }
  const net = guard(
    roundHalfUp((gross * 10_000) / (10_000 + taxRateBps)),
    "splitGross",
  );
  return { net, tax: subtract(gross, net), gross };
}

/** Build a gross amount from a net one. Inverse of splitGross. */
export function grossFromNet(
  net: Minor,
  taxRateBps: number,
): { net: Minor; tax: Minor; gross: Minor } {
  const tax = applyBasisPoints(net, taxRateBps);
  return { net, tax, gross: add(net, tax) };
}

/**
 * Split an amount across N shares with NO cent lost or invented (Fowler's
 * remainder-distributing allocator).
 *
 * This is why an order-level discount can be pushed down onto lines and the
 * lines still sum to the order total. Naive per-line rounding loses centavos,
 * and a $10.000 discount that only removes $9.999,99 is a defect nobody can
 * explain to an accountant.
 *
 * Remainder cents go to the earliest shares, which is deterministic and
 * therefore reproducible in a dispute.
 */
export function allocate(amount: Minor, ratios: readonly number[]): Minor[] {
  if (ratios.length === 0) {
    throw new RangeError("allocate() requires at least one ratio");
  }
  if (ratios.some((ratio) => ratio < 0 || !Number.isFinite(ratio))) {
    throw new RangeError("allocate() ratios must be finite and non-negative");
  }

  const total = ratios.reduce((acc, ratio) => acc + ratio, 0);
  if (total === 0) {
    throw new RangeError("allocate() ratios must not sum to zero");
  }

  const shares: Minor[] = [];
  let allocated = 0;

  for (const ratio of ratios) {
    // Truncate toward zero so the remainder is always distributable and the
    // last share can never be over-allocated.
    const share = Math.trunc((amount * ratio) / total);
    shares.push(guard(share, "allocate"));
    allocated += share;
  }

  let remainder = amount - allocated;
  const step = remainder < 0 ? -1 : 1;

  for (let index = 0; remainder !== 0; index = (index + 1) % shares.length) {
    const current = shares[index];
    // noUncheckedIndexedAccess: the modulo keeps index in range, but prove it
    // to the compiler rather than silencing it with a non-null assertion.
    if (current === undefined) {
      break;
    }
    shares[index] = guard(current + step, "allocate");
    remainder -= step;
  }

  return shares;
}

/** Split evenly — the common case of allocate(). */
export function allocateEvenly(amount: Minor, shareCount: number): Minor[] {
  if (!Number.isInteger(shareCount) || shareCount < 1) {
    throw new RangeError(`shareCount must be a positive integer; got ${shareCount}`);
  }
  return allocate(amount, new Array<number>(shareCount).fill(1));
}

// ---------------------------------------------------------------------------
// Boundary conversion
// ---------------------------------------------------------------------------

/**
 * The SINGLE audited boundary converting an EXTERNAL string minor-unit value
 * into an integer `Minor`.
 *
 * Our own API returns integers, so nothing internal needs this. It exists for
 * third-party boundaries — payment providers and their webhooks routinely encode
 * amounts as strings — and it is the reason no call site should ever reach for
 * `parseInt`. `parseInt(value || "0", 10)` maps "", "abc" and undefined all to
 * 0, i.e. a malformed upstream payload silently becomes a free product. This
 * rejects instead. It is deliberately strict about the string's SHAPE too:
 * `parseInt("49.99")` returns 49, quietly discarding the
 * fraction, so a decimal point is an error rather than a truncation.
 */
export function parseMinorUnitString(value: unknown): Minor {
  if (typeof value !== "string") {
    throw new TypeError(
      `Expected a minor-unit string, got ${typeof value}. ` +
        `Upstream money values must arrive as strings of digits.`,
    );
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new RangeError(
      `Malformed minor-unit string ${JSON.stringify(value)}. ` +
        `Expected only digits (optionally signed) — a decimal point means the ` +
        `upstream value is in MAJOR units and would be silently truncated.`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`Minor-unit string ${trimmed} exceeds safe integer range`);
  }

  return guard(parsed, "parseMinorUnitString");
}

/** Non-throwing variant for rendering paths that must degrade rather than 500. */
export function tryParseMinorUnitString(value: unknown): Minor | null {
  try {
    return parseMinorUnitString(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Minor units per major unit, by currency — the ISO 4217 exponent. Almost
 * everything is 2 (COP included: amounts are stored in centavos), but assuming
 * so breaks on JPY (0) and the dinars (3).
 */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  TND: 3,
};

export function minorUnitExponent(currency: CurrencyCode): number {
  return CURRENCY_EXPONENT[currency] ?? 2;
}

/**
 * Fraction digits a currency is DISPLAYED and ENTERED with, where that differs
 * from its ISO exponent.
 *
 * COP has exponent 2 — we store centavos, and a payment provider's
 * `amount_in_cents` is exactly that — but nobody in Colombia prices in
 * centavos: a tee is "$ 89.000", never "$ 89.000,00", and an operator types
 * "89000". So COP is shown and typed in WHOLE PESOS while every stored and
 * computed amount stays in centavos.
 */
const DISPLAY_FRACTION_DIGITS: Readonly<Record<string, number>> = {
  COP: 0,
};

export function displayFractionDigits(currency: CurrencyCode): number {
  return DISPLAY_FRACTION_DIGITS[currency] ?? minorUnitExponent(currency);
}

/**
 * Format for display. The shop is Spanish only, so every amount formats in
 * `STORE_LOCALE` (es-CO): COP yields "$ 89.000" — whole pesos, no decimals
 * (`displayFractionDigits`).
 */
export function formatMoney(amount: Minor, currency: CurrencyCode): string {
  return formatMinorUnits(amount, currency);
}

/** Convenience over the Money envelope. */
export function formatMoneyValue(value: Money): string {
  return formatMoney(value.amount, value.currency);
}

/**
 * Format an AGGREGATE — lifetime revenue, a period total, an average order
 * value — for DISPLAY ONLY.
 *
 * WHY THIS EXISTS AND WHY IT DOES NOT TAKE `Minor`. An aggregate is a sum over
 * an unbounded number of orders, so it has no ceiling; `Minor` has one, at
 * `MINOR_MAX` ($20.000.000 COP), and `toMinor` THROWS above it. That cap is
 * correct for a single amount — a $20m line item is a bug or an attack — and wrong for
 * a lifetime total, which is why the admin schemas type these figures as a bare
 * `z.number().int()` rather than parsing them as `Minor`. Branding one anyway
 * would make the dashboard start crashing on a SUCCESSFUL business, and the
 * usual `isMinor(...)` narrowing degrades to the same defect from the other
 * side: it returns false for exactly the over-cap values, so the fallback path
 * renders a bare integer — `2400000000` where a peso figure belongs.
 *
 * So this takes an unbranded integer, applies no range check, and never throws.
 * The Intl call is the same one `formatMoney` makes, so an aggregate and a line
 * total render identically.
 *
 * DISPLAY ONLY, and the three halves of that are load-bearing:
 *   - it NEVER feeds a charge, a refund, or any other value that moves money;
 *   - it is NEVER accepted from a request — nothing parses back out of it;
 *   - it is NEVER the input to arithmetic. Sum in minor units, format last.
 * Anything that must be added, compared or settled goes through `Minor` and its
 * overflow guard, which is the whole point of the cap this function sidesteps.
 */
export function formatAggregateMinor(value: number, currency: CurrencyCode): string {
  return formatMinorUnits(value, currency);
}

/**
 * The one Intl call. Shared by `formatMoney` and `formatAggregateMinor` so the
 * branded and the display-only paths cannot drift into two spellings of the
 * same figure.
 *
 * `narrowSymbol` so COP renders "$ 89.000" rather than "COP 89.000": the
 * store sells in one currency, so the bare "$" is unambiguous to its shoppers.
 * A COP amount with stray centavos is ROUNDED for display only — it is never
 * the stored value, which stays exact.
 */
function formatMinorUnits(amount: number, currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  const fractionDigits = displayFractionDigits(currency);
  const major = amount / 10 ** exponent;

  return new Intl.NumberFormat(STORE_LOCALE, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(major);
}

/**
 * The MACHINE-readable decimal form: `8900000` COP → `"89000.00"`.
 *
 * NOT a display format. `formatMoney` emits es-CO grouping separators, a
 * currency symbol and a decimal COMMA — all correct
 * for a human and all invalid in the places this function exists for: a
 * schema.org `offers.price`, a `<meta itemprop="price">`, a CSV export, an
 * analytics event. Feeding a rendered "1.234,56 €" to any of those is a
 * thousand-fold price error a rich result will happily publish.
 *
 * Uses the ISO exponent, NOT the display digits: this is the exact value.
 *
 * Computed with INTEGER and STRING operations only. `amount / 10 ** exponent`
 * would reintroduce exactly the binary-float rounding that integer minor units
 * exist to prevent, and the point of insertion for a wrong price is a `.toFixed`
 * on a value that is already 34.499999999999996.
 *
 * Always emits the currency's full precision (2 for COP, 0 for JPY, 3 for KWD),
 * because a consumer of this string has no way to guess how many decimals it
 * was meant to carry.
 */
export function toDecimalString(amount: Minor, currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  const negative = amount < 0;
  // `padStart(exponent + 1, "0")` guarantees at least one integer digit, so 5
  // minor units render "0.05" rather than ".05".
  const digits = String(Math.abs(amount)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * The INVERSE of `toDecimalString`: `"89000.00"` COP -> `8900000`.
 *
 * THE PAYMENT-PROVIDER BOUNDARY. A provider that speaks MAJOR units (an exact
 * decimal string, or a bare number passed as `String(n)` — JS's shortest
 * round-tripping decimal, so nothing is invented) becomes a `Minor` here and
 * nowhere else. Wompi does not need it: `amount_in_cents` is already centavos,
 * the same unit as the ledger, so the payment path compares integers directly.
 *
 * INTEGER AND STRING OPERATIONS ONLY. `Number(value) * 10 ** exponent` is the
 * obvious implementation and it is wrong: `49.99 * 100` is 4998.999999999999,
 * and a `Math.round` on top of that hides the defect for two-decimal currencies
 * while still losing to KWD. The digits are sliced and concatenated instead, so
 * there is no magnitude at which the result can drift.
 *
 * IT REJECTS RATHER THAN COERCES, and that is the whole point of it existing.
 * Every rejected shape below is one that `Number()` would happily resolve:
 * `"1e3"` to 1000, `"10."` to 10, `" 10 "` to 10, `"Infinity"` to Infinity.
 * Accepting any of them would mean agreeing with a total expressed in a form
 * our own encoder never emits, through a path nobody reviewed. Most important
 * is EXCESS PRECISION: rounding `"49.999"` to 5000 would invent a cent the
 * provider never charged and silently satisfy the settlement check. A total we
 * cannot read exactly is a total we must not agree with, so the caller sees a
 * throw and the order lands in PAYMENT_MISMATCH.
 *
 * FEWER fraction digits than the currency carries is fine — `"49.9"` is
 * unambiguously nine tenths — as is a bare integer, which is how a round amount
 * usually arrives.
 */
export function fromDecimalString(value: string, currency: CurrencyCode): Minor {
  if (typeof value !== "string") {
    throw new TypeError(
      `Expected a decimal string, got ${typeof value}. ` +
        `A provider amount must arrive as a string of digits, not be stringified here.`,
    );
  }

  // No `.trim()`: surrounding whitespace means the value did not come from a
  // JSON number or a Money field, and guessing what it did come from is how a
  // malformed amount gets normalised into a plausible one.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);

  if (match === null) {
    throw new RangeError(
      `Malformed decimal string ${JSON.stringify(value)}. ` +
        `Expected digits with at most one decimal point — no exponent, no ` +
        `separators, no leading sign other than "-", no surrounding whitespace.`,
    );
  }

  // `noUncheckedIndexedAccess` types these as possibly-undefined. Groups 1 and 2
  // are non-optional in the pattern, so `?? ""` is a formality for the compiler;
  // group 3 is genuinely optional and "" is the correct no-fraction value.
  const sign = match[1] ?? "";
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";

  const exponent = minorUnitExponent(currency);

  if (fraction.length > exponent) {
    throw new RangeError(
      `Decimal string ${JSON.stringify(value)} carries ${fraction.length} fraction ` +
        `digits but ${currency} holds ${exponent}. Refusing to round: a total we ` +
        `cannot read exactly is a total we must not agree with.`,
    );
  }

  const digits = `${whole}${fraction.padEnd(exponent, "0")}`;
  const parsed = Number(`${sign}${digits}`);

  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`Decimal string ${value} exceeds safe integer range in minor units`);
  }

  return guard(parsed, "fromDecimalString");
}

/** Build a Money envelope. Prefer this over object literals so the brand is enforced. */
export function money(amount: Minor, currency: CurrencyCode): Money {
  return { amount, currency };
}
