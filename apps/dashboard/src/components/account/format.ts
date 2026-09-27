import type { CurrencyCode, Locale, Minor } from "@akai/contracts";
import { formatMoney } from "@akai/money";

/**
 * Display formatting for the account surface.
 *
 * All of it goes through `@akai/money` and `Intl`. Nothing here does float
 * maths on a price: amounts arrive as branded integer `Minor` values from a
 * parsed contract and are handed straight to the formatter.
 */

/**
 * Narrow next-intl's `string` locale to the platform's `Locale` union.
 *
 * `useLocale()` is typed `string` because next-intl cannot know our routing
 * config. A cast would be the obvious move and the wrong one — this is a real
 * runtime narrowing with a defined fallback, which is what `unknown`-style
 * discipline looks like applied to a widened primitive.
 */
export function asLocale(value: string): Locale {
  return value === "en" ? "en" : "es";
}

export function formatAmount(
  amount: Minor,
  currency: CurrencyCode,
  locale: Locale,
): string {
  return formatMoney(amount, currency, locale);
}

/**
 * Format an ISO timestamp as a date.
 *
 * The timezone is pinned to UTC deliberately. Without it the server renders in
 * the container's zone and the browser renders in the visitor's, which produces
 * a React hydration mismatch — and, on orders placed near midnight, a date that
 * visibly changes after the page loads.
 */
export function formatDate(isoDateTime: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "es" ? "es-ES" : "en-IE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDateTime));
}

export function formatDateTime(isoDateTime: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "es" ? "es-ES" : "en-IE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(isoDateTime));
}

/** "Elena Ruiz", or null when the customer has filled in neither name. */
export function fullName(
  firstName: string | null,
  lastName: string | null,
): string | null {
  const joined = [firstName, lastName].filter((part) => part !== null).join(" ").trim();
  return joined.length > 0 ? joined : null;
}
