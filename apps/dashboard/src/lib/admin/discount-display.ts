import { isMinor, type Locale } from "@akai/contracts";
import { formatMoney } from "@akai/money";
import { DEFAULT_CURRENCY, type AdminDiscount } from "@/lib/admin/schemas";

/**
 * Pure display logic for the coupon list, extracted from the route module.
 *
 * It lives here because `page.tsx` is a server component that reaches
 * `createServerApiClient` -> `lib/session/server.ts`, which throws if it is ever
 * pulled into client code. That guard is correct, and it also made these pure
 * functions untestable from jsdom: importing the page to unit-test `resolveState`
 * trips the server-only guard. Splitting the pure half out is what makes the
 * precedence chain and the basis-points/minor-units split provable.
 *
 * TONES ARE NOT HERE ANY MORE. `DiscountState` is still DECLARED here, beside
 * the resolver that derives it, but the tone it badges with lives in
 * `lib/status` under the `discount` domain — one table for all twelve badged
 * vocabularies, so a coupon and an order cannot disagree about what green
 * means. Note the rename that came with it: the old local `positive` is spelled
 * `success` there, matching the `--success-*` token family.
 */

/**
 * What an operator actually needs to know at a glance, derived rather than
 * stored: the API has no `status` column, and computing this in one place beats
 * three columns the reader has to combine mentally.
 */
export type DiscountState = "ACTIVE" | "SCHEDULED" | "EXPIRED" | "EXHAUSTED" | "ARCHIVED";

export function resolveState(discount: AdminDiscount, now: number): DiscountState {
  if (discount.deletedAt !== null) {
    return "ARCHIVED";
  }
  if (discount.endsAt !== null && Date.parse(discount.endsAt) <= now) {
    return "EXPIRED";
  }
  if (discount.startsAt !== null && Date.parse(discount.startsAt) > now) {
    return "SCHEDULED";
  }
  if (discount.remainingRedemptions !== null && discount.remainingRedemptions <= 0) {
    return "EXHAUSTED";
  }
  return "ACTIVE";
}

/**
 * `value` is overloaded by `type` — basis points, minor units, or nothing —
 * so it is NEVER rendered raw. A bare "1000" in this column is 10% or €10.00
 * depending on a value in the next column over, and an operator reading it as
 * the wrong one changes a coupon by a factor of a hundred.
 */
export function formatValue(discount: AdminDiscount, locale: Locale): string {
  if (discount.type === "FREE_SHIPPING") {
    return "—";
  }

  if (discount.type === "PERCENTAGE") {
    // Basis points → a display fraction. This division is DISPLAY ONLY and never
    // re-enters the money path; `value` itself stays the integer 1000.
    return new Intl.NumberFormat(intlLocale(locale), {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(discount.value / 10_000);
  }

  // FIXED_AMOUNT: minor units, but the column is NOT branded `Minor` because
  // two thirds of its rows hold basis points instead. `isMinor` narrows rather
  // than asserting, so a row outside the money range degrades to its raw integer
  // instead of throwing inside `toMinor` and 500ing the whole list.
  const amount = discount.value;
  if (!isMinor(amount)) {
    return String(amount);
  }
  return formatMoney(amount, discount.currency ?? DEFAULT_CURRENCY, locale);
}

export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "short" }).format(
    new Date(iso),
  );
}

/** es-ES / en-IE, matching @akai/money's own choice so figures agree. */
export function intlLocale(locale: Locale): string {
  return locale === "es" ? "es-CO" : "en-US";
}
