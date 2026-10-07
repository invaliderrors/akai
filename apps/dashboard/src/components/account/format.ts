import { STORE_LOCALE, STORE_TIME_ZONE, type CurrencyCode, type Minor } from "@akai/contracts";
import { formatMoney } from "@akai/money";

/**
 * Display formatting for the account surface.
 *
 * All of it goes through `@akai/money` and `Intl`. Nothing here does float
 * maths on a price: amounts arrive as branded integer `Minor` values from a
 * parsed contract and are handed straight to the formatter.
 */

export function formatAmount(amount: Minor, currency: CurrencyCode): string {
  return formatMoney(amount, currency);
}

/**
 * Format an ISO timestamp as a date, in Colombian time.
 *
 * The time zone is pinned (`STORE_TIME_ZONE`) deliberately. Without it the
 * server renders in the container's zone and the browser renders in the
 * visitor's, which produces a React hydration mismatch — and, on orders placed
 * near midnight, a date that visibly changes after the page loads.
 */
export function formatDate(isoDateTime: string): string {
  return new Intl.DateTimeFormat(STORE_LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: STORE_TIME_ZONE,
  }).format(new Date(isoDateTime));
}

export function formatDateTime(isoDateTime: string): string {
  return new Intl.DateTimeFormat(STORE_LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: STORE_TIME_ZONE,
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
