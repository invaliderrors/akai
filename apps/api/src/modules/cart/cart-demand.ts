/**
 * THE ONE PLACE "how many units of each variant does this cart want" is summed.
 *
 * A variant can sit in one cart several times over: as a standalone line, as a
 * component of one or more pack instances, and — for a component with a recipe
 * quantity > 1 — split across two rows of the same instance at two adjacent
 * prices (`pack-pricing.ts`). Stock is one number per variant, so every check
 * against it must use the SUM across all of those rows. Checking each row on
 * its own is how "3 standalone + a pack needing 5" passed against 6 in stock.
 *
 * Every caller — `addItem`, `updateItemQuantity`, `addPack` and the read-time
 * `evaluateLine` — builds the cart AS IT WOULD BE (current rows, with the ones
 * the write replaces swapped for the rows it would store) and asks this. None
 * of them sums by hand.
 */
export interface DemandLine {
  readonly variantId: string;
  readonly quantity: number;
}

export function demandByVariant(lines: readonly DemandLine[]): ReadonlyMap<string, number> {
  const demand = new Map<string, number>();
  for (const line of lines) {
    demand.set(line.variantId, (demand.get(line.variantId) ?? 0) + line.quantity);
  }
  return demand;
}
