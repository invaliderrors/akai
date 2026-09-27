/**
 * The store-wide free-shipping threshold the client asked for on 2026-09-24:
 * orders of €250.00 or more ship free, on EVERY rate in EVERY zone
 * (docs/superpowers/specs/2026-09-24-client-feedback-changes.md §3, D3b).
 *
 * This is what the seeds and `seed-shipping-2026-09-24.ts` WRITE into
 * `shipping_rate.freeOverSubtotal`. Nothing at runtime reads it: checkout, the
 * quote endpoint and the storefront all read the threshold from the rate rows.
 *
 * Dependency-free on purpose, like the seed scripts themselves: it is imported
 * by scripts run with `tsx` against a live database.
 *
 * `free-shipping-threshold.test.ts` pins it to the storefront marquee copy
 * ("… superiores a 250 €"), so changing one without the other fails CI.
 */
export const FREE_SHIPPING_THRESHOLD_MINOR = 25_000;
