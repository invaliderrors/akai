/**
 * Merchandising facts the storefront owns until the API does: the weekly drop
 * calendar and which category slugs the home page and the nav point at.
 */

/** Next weekly drop. Once it passes, the countdown rolls forward a week at a time. */
export const NEXT_DROP = "2026-09-27T12:00:00+09:00";

/** When the current Weekly Exclusive ends. Rolls forward the same way. */
export const EXCLUSIVE_ENDS = "2026-10-02T00:00:00+09:00";

/**
 * The categories the design merchandises. The API owns the categories; these
 * are the slugs to create there. A slug the API does not know just links to
 * an empty listing and shows no style count.
 */
export const CATEGORY_SLUGS = {
  exclusive: "exclusive",
  tees: "graphic-tees",
  oversized: "oversized",
  sweatshirts: "sweatshirts",
} as const;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How product cards pick their badge (see `productBadge`). */
export const BADGE_RULES = {
  lowStockThreshold: 5,
  limitedCategorySlug: CATEGORY_SLUGS.exclusive,
  newForMs: 2 * WEEK_MS,
} as const;

/** `target`, or the first weekly repeat of it that is still in the future. */
export function nextWeekly(target: string, now: number): number {
  const start = Date.parse(target);
  if (start > now) return start;
  return start + Math.ceil((now - start + 1) / WEEK_MS) * WEEK_MS;
}

const pad = (value: number) => String(value).padStart(2, "0");

export type CountdownFormat = "short" | "minutes" | "seconds";

/** "06D 04H", "06D 04H 12M" or "06D 04H 12M 09S". */
export function formatCountdown(ms: number, format: CountdownFormat): string {
  const left = Math.max(0, ms);
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor(left / 3_600_000) % 24;
  const minutes = Math.floor(left / 60_000) % 60;
  const seconds = Math.floor(left / 1000) % 60;
  let text = `${pad(days)}D ${pad(hours)}H`;
  if (format !== "short") text += ` ${pad(minutes)}M`;
  if (format === "seconds") text += ` ${pad(seconds)}S`;
  return text;
}
