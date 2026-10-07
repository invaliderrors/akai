/**
 * The store-wide free-shipping threshold: orders of $ 300.000 COP or more ship
 * free, on EVERY rate in EVERY zone. In MINOR units (centavos), like every
 * amount: 30_000_000 centavos = $ 300.000.
 *
 * This is what the seed WRITES into `shipping_rate.freeOverSubtotal` (see
 * `shipping-setup.ts`). Nothing at runtime reads it: checkout, the quote
 * endpoint and the storefront all read the threshold from the rate rows, and an
 * operator can change it per rate in /admin/shipping.
 *
 * Dependency-free on purpose, like the seed scripts themselves: it is imported
 * by scripts run with `tsx` against a live database.
 */
export const FREE_SHIPPING_THRESHOLD_MINOR = 30_000_000;
