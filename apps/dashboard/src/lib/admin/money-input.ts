import { MINOR_MAX, toMinor, type CurrencyCode, type Minor } from "@akai/contracts";
import { minorUnitExponent } from "@akai/money";

/**
 * The major-unit ⇄ minor-unit boundary for admin price entry, and the
 * percent ⇄ basis-point boundary that shares its arithmetic.
 *
 * An admin types "49.99"; the API stores 4999. An admin types "12.5"; the API
 * stores 1250 basis points. Those are the SAME operation at two different
 * exponents, so there is ONE parser (`parseScaledDecimal`) and two thin wrappers
 * over it. This file is the only place either conversion happens in the
 * dashboard, and it is deliberately the most paranoid file in the slice, because
 * every failure mode here ships product at the wrong price or a coupon at the
 * wrong rate.
 *
 * WHY STRING ARITHMETIC AND NOT `Math.round(Number(raw) * 100)`:
 * the float route is wrong in ways that do not show up until they do.
 * `1.005 * 100` is 100.49999999999999 in IEEE-754, so `Math.round` yields 100 —
 * a cent lost, silently, on a value the admin typed exactly. `Number("1e3")` is
 * 1000 and `Number("")` is 0, so a fat-fingered field becomes a free product
 * (the exact defect @akai/money's `parseMinorUnitString` was written to kill on
 * the read path — this is its write-path twin). Splitting the string and padding
 * the fraction to the target exponent involves no float at any point.
 *
 * WHY GROUPING SEPARATORS ARE REJECTED RATHER THAN PARSED:
 * "1,234" is €1.234 to a Spanish admin and €1,234 to an English one. There is no
 * way to disambiguate from the string alone, and guessing wrong is a 1000×
 * pricing error in either direction. Rejecting with a message the admin can act
 * on ("remove the thousands separator") is the only outcome that cannot ship a
 * €1,234 product for €1.23. Both `.` and `,` are accepted as the DECIMAL mark,
 * because a Spanish-default store's operators type "49,99" and refusing that
 * would be hostile — that case is unambiguous, so it is allowed.
 *
 * WHY AN OVER-LONG FRACTION IS REJECTED RATHER THAN ROUNDED:
 * "49.999" is not a euro price. Rounding it to 50.00 silently overcharges and
 * rounding to 49.99 silently undercharges; both hide a typo that the admin is
 * standing right there to fix. Rounding is correct when money is being *split*
 * (see @akai/money's allocator) and wrong when it is being *entered*.
 */

/**
 * Discriminated union rather than throw-or-null.
 *
 * A form needs the failure REASON to render next to the field, and a `null`
 * return cannot carry one. Throwing would be worse: invalid input is the
 * expected steady state of a form the user is still typing into, not an
 * exceptional condition.
 */
export type ScaledDecimalError =
  | "EMPTY"
  | "NOT_A_NUMBER"
  | "GROUPING_SEPARATOR"
  | "NEGATIVE"
  | "TOO_MANY_DECIMALS"
  | "TOO_LARGE";

export type ScaledDecimalResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: ScaledDecimalError };

export interface ScaledDecimalOptions {
  /** Digits after the decimal mark the target unit carries. EUR 2, JPY 0, % 2. */
  readonly exponent: number;
  /** Inclusive upper bound on the SCALED integer. MINOR_MAX for money, 10000 for bps. */
  readonly max: number;
}

/**
 * Parse a human-entered decimal into a scaled INTEGER, with no float step.
 *
 * The one generic operation behind both money entry and percentage entry.
 * Money passes the currency's exponent and MINOR_MAX; a percentage passes 2 and
 * 10000, because a basis point is one hundredth of a percent exactly as a cent
 * is one hundredth of a euro. Writing that conversion a second time for
 * discounts would have duplicated every rule above — the grouping-separator
 * refusal, the pad-never-truncate rule, the leading-zero normalisation — in a
 * file where getting it wrong misprices a coupon by 100×.
 */
export function parseScaledDecimal(
  raw: string,
  options: ScaledDecimalOptions,
): ScaledDecimalResult {
  const compact = raw.replace(WHITESPACE, "");

  if (compact.length === 0) {
    return { ok: false, error: "EMPTY" };
  }

  // Checked before the shape test so a negative gets its own message instead of
  // the generic "enter a number" — the admin's mistake is semantic, not typing.
  if (compact.startsWith("-")) {
    return { ok: false, error: "NEGATIVE" };
  }

  const separatorCount = countOccurrences(compact, ".") + countOccurrences(compact, ",");
  if (separatorCount > 1) {
    return { ok: false, error: "GROUPING_SEPARATOR" };
  }

  // Digits, optionally one separator, optionally more digits. `1e3`, `+5`, `0x10`
  // and a bare "." all fail here rather than reaching Number().
  const shape = /^(\d+)(?:[.,](\d*))?$/.exec(compact);
  if (shape === null) {
    return { ok: false, error: "NOT_A_NUMBER" };
  }

  // `noUncheckedIndexedAccess` makes these `string | undefined`. Group 1 always
  // participates when the regex matches, but the compiler cannot know that and a
  // non-null assertion is banned — so it is narrowed, not asserted.
  const integerPart = shape[1];
  if (integerPart === undefined) {
    return { ok: false, error: "NOT_A_NUMBER" };
  }
  const fractionPart = shape[2] ?? "";

  if (fractionPart.length > options.exponent) {
    // Covers zero-decimal currencies (JPY, KRW) for free: exponent 0 means any
    // fractional digit at all is rejected.
    return { ok: false, error: "TOO_MANY_DECIMALS" };
  }

  // "49.9" with exponent 2 is 49.90, i.e. 4990 — pad, never truncate.
  const scaledDigits = `${integerPart}${fractionPart.padEnd(options.exponent, "0")}`;

  // Strip leading zeros so "0000049.99" does not become an over-long numeric
  // string; "" (all zeros) normalises back to "0".
  const normalised = scaledDigits.replace(/^0+(?=\d)/, "");

  const parsed = Number(normalised);
  if (!Number.isSafeInteger(parsed) || parsed > options.max) {
    return { ok: false, error: "TOO_LARGE" };
  }

  return { ok: true, value: parsed };
}

/** Render a scaled integer back into the plain decimal string an input holds. */
export function formatScaledDecimal(value: number, exponent: number): string {
  if (exponent === 0) {
    return String(value);
  }

  const digits = String(Math.abs(value)).padStart(exponent + 1, "0");
  const splitAt = digits.length - exponent;
  const sign = value < 0 ? "-" : "";

  return `${sign}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type MoneyInputError = ScaledDecimalError;

export type MoneyInputResult =
  | { readonly ok: true; readonly value: Minor }
  | { readonly ok: false; readonly error: MoneyInputError };

/**
 * Human-facing message per failure. Kept beside the codes so a new failure mode
 * cannot be added without deciding what the admin is told about it.
 *
 * TODO (followUps): these are the one user-facing string set in this slice not
 * yet routed through next-intl. The discount surface DOES translate them — it
 * maps the same codes onto `admin.discounts.fieldErrors.*` — so this map is now
 * only the product/refund forms' remaining debt, and the swap is mechanical.
 */
export const MONEY_INPUT_MESSAGES: Readonly<Record<MoneyInputError, string>> = {
  EMPTY: "Enter a price.",
  NOT_A_NUMBER: "Enter a number, for example 49.99.",
  GROUPING_SEPARATOR:
    "Remove the thousands separator — enter 1234.56 rather than 1,234.56.",
  NEGATIVE: "A price cannot be negative.",
  TOO_MANY_DECIMALS: "Too many decimal places for this currency.",
  TOO_LARGE: "That price is larger than the system allows.",
};

/** Every character that can show up as whitespace in a pasted amount. */
const WHITESPACE = /[\s  ]/g;

/**
 * Parse an admin-entered major-unit amount into integer minor units.
 *
 * Returns a `Minor`, so the result is unassignable to a plain-number slot and
 * cannot be accidentally re-multiplied by 100 downstream.
 */
export function parseMajorUnitInput(
  raw: string,
  currency: CurrencyCode,
): MoneyInputResult {
  const parsed = parseScaledDecimal(raw, {
    exponent: minorUnitExponent(currency),
    max: MINOR_MAX,
  });

  if (!parsed.ok) {
    return parsed;
  }

  // `toMinor` re-validates against the contracts schema. Belt and braces on
  // purpose: this is the only place in the dashboard that mints a Minor from
  // user input, so it pays the cost of the second check.
  return { ok: true, value: toMinor(parsed.value) };
}

/**
 * Render minor units back into the plain major-unit string a form input holds.
 *
 * NOT localised, and that is deliberate: this feeds `<input value>`, where the
 * value must round-trip through `parseMajorUnitInput` unchanged. Localised
 * display money goes through @akai/money's `formatMoney`, which is locale-aware
 * and produces "49,99 €" — a string this parser would reject, as it should.
 */
export function formatMinorAsInput(amount: Minor, currency: CurrencyCode): string {
  return formatScaledDecimal(amount, minorUnitExponent(currency));
}

// ---------------------------------------------------------------------------
// Percentages — the same arithmetic at a fixed exponent.
// ---------------------------------------------------------------------------

/** A basis point is 1/100 of a percent, so a percent has two decimal places. */
export const PERCENTAGE_EXPONENT = 2;

/** 100% — the API refuses more, because a coupon may not over-refund. */
export const MAX_BASIS_POINTS = 10_000;

/**
 * Parse an admin-entered percentage ("12.5") into BASIS POINTS (1250).
 *
 * Basis points, not a float rate, for the reason stated in @akai/money: 21% is
 * exactly 2100 and never 0.21000000000000002. The cap is enforced here as well
 * as server-side so the operator is told before the round trip, and the failure
 * codes are the money parser's, so one translated message set covers both.
 */
export function parsePercentageInput(raw: string): ScaledDecimalResult {
  return parseScaledDecimal(raw, {
    exponent: PERCENTAGE_EXPONENT,
    max: MAX_BASIS_POINTS,
  });
}

/** Inverse of `parsePercentageInput`: 1250 → "12.50". */
export function formatPercentageAsInput(basisPoints: number): string {
  return formatScaledDecimal(basisPoints, PERCENTAGE_EXPONENT);
}

function countOccurrences(value: string, character: string): number {
  let count = 0;
  for (const char of value) {
    if (char === character) {
      count += 1;
    }
  }
  return count;
}
