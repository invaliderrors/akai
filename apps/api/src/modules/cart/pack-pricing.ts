import { allocate, allocateEvenly, toMinor, type Minor } from "@akai/money";

/**
 * Pro-rates ONE pack's flat price across its real component lines.
 *
 * ONE FUNCTION, used identically by the cart's live re-pricing (`present()`)
 * and by order creation (`OrdersService.createFromCart()`) — the same
 * reasoning `resolveUnitPrice` is shared between the cart and the checkout
 * charge: "which price applies" must never be computed two different ways
 * that could disagree.
 *
 * ALLOCATES AT THE SINGLE-PACK BASIS, NOT `packPriceGross * quantity`, and
 * that is the whole point: `allocate()` already guarantees its shares sum
 * EXACTLY to the amount given it, so allocating one pack's worth gives every
 * component an EXACT integer total. Multiplying a resulting sub-line's
 * `quantity` by `packQuantity` afterwards (ordinary integer multiplication,
 * exact) is how a caller scales to "N packs" — the per-unit PRICE never
 * changes with how many packs are bought, only how many units land at it.
 *
 * TWO-LEVEL ALLOCATION, because a component can now claim more than one
 * physical unit per pack ("5x Reta 20mg" as one slot). A single `unitPriceGross`
 * scalar has to hold for a whole line's `quantity` (`cart-totals.ts`'s
 * `calculateTotals` re-derives every line's gross as `unitPriceGross *
 * quantity` — it never accepts a pre-computed total), but a component's
 * TOTAL share of the pack price does not, in general, divide evenly by its
 * own quantity. Rather than rounding around that gap (which would make the
 * sum across a pack's lines drift from the pack's own flat price — exactly
 * the drift this whole mechanism exists to eliminate), each component is
 * allowed to split into UP TO TWO lines at two adjacent per-unit prices:
 *
 *   1. `allocate()` distributes the pack price across components, weighted
 *      by `quantity * liveUnitPrice` (the value of one pack's worth of that
 *      slot) — an exact integer TOTAL per component, summing exactly to the
 *      pack price (already `allocate()`'s own guarantee).
 *   2. `allocateEvenly()` splits each component's total across its own
 *      `quantity` — `allocate()`'s remainder rule (truncate, then +1
 *      round-robin) guarantees the result contains AT MOST TWO distinct
 *      values for any group of identically-weighted entries, so a
 *      quantity-5 component whose share doesn't divide evenly becomes e.g.
 *      "3 units @ 199, 2 units @ 200" — two lines, not a rounding error.
 *
 * In practice this two-line split is the COMMON case for quantity > 1 (only
 * an exact multiple avoids it), not a rare edge case — worth handling
 * properly rather than accepting drift.
 */
export interface PackComponentToAllocate {
  readonly lineId: string;
  /** This component's own live unit price, ignoring the pack — the allocation weight. */
  readonly liveUnitPrice: Minor;
  /** How many of this component ONE pack contains. */
  readonly quantity: number;
}

export interface AllocatedPackComponentLine {
  readonly lineId: string;
  /** Exact per-unit share of ONE pack's flat price. */
  readonly unitPriceGross: Minor;
  /**
   * How many physical units land at this exact price — sums, across every
   * sub-line sharing a `lineId`, to that component's own `quantity`. Usually
   * the whole `quantity` in one entry; sometimes split across two.
   */
  readonly quantity: number;
}

export function allocatePackComponents(
  packPriceGross: Minor,
  components: readonly PackComponentToAllocate[],
): readonly AllocatedPackComponentLine[] {
  const weights = components.map((component) => component.quantity * component.liveUnitPrice);
  const totalShares = allocate(packPriceGross, weights);

  const result: AllocatedPackComponentLine[] = [];
  components.forEach((component, index) => {
    const totalShare = toMinor(totalShares[index] ?? 0);
    const perUnitShares = allocateEvenly(totalShare, component.quantity);

    // Group into distinct per-unit prices — usually one, at most two, per
    // `allocateEvenly`'s own remainder-distribution guarantee.
    const countByShare = new Map<Minor, number>();
    for (const share of perUnitShares) {
      countByShare.set(share, (countByShare.get(share) ?? 0) + 1);
    }
    for (const [unitPriceGross, quantity] of countByShare) {
      result.push({ lineId: component.lineId, unitPriceGross, quantity });
    }
  });

  return result;
}

/**
 * HOW MANY PACKS one stored instance holds, recovered from its rows.
 *
 * A component with its own recipe `quantity` > 1 stores
 * `component.quantity * packQuantity` units, possibly split across two rows
 * (see `allocatePackComponents`). So this reads the FIRST recipe component
 * that still has a stored line, sums that variant's row(s) and divides by the
 * recipe's own quantity for it — any component gives the same answer while
 * the recipe is unchanged. `Math.floor` fails safe (under- rather than
 * over-counts) when the recipe was edited under a live cart; nothing here is
 * the final charge, because checkout re-derives everything from the live
 * recipe independently.
 *
 * ONE implementation for `addPack`, the read path and merge-on-login: three
 * hand-rolled copies of this loop is how they start disagreeing about a pack.
 *
 * Zero means no stored line belongs to the recipe any more.
 */
export function recoverPackQuantity(
  recipe: readonly { readonly variantId: string; readonly quantity: number }[],
  storedLines: readonly { readonly variantId: string; readonly quantity: number }[],
): number {
  for (const component of recipe) {
    const storedQuantity = storedLines
      .filter((line) => line.variantId === component.variantId)
      .reduce((sum, line) => sum + line.quantity, 0);
    if (storedQuantity > 0) {
      return Math.floor(storedQuantity / component.quantity);
    }
  }
  return 0;
}

/**
 * The most packs one instance may hold with every component's line total
 * within `maxLineQuantity` — the same per-line ceiling `addPack` enforces on
 * `component.quantity * packQuantity`.
 */
export function maxPacksPerLine(
  recipe: readonly { readonly quantity: number }[],
  maxLineQuantity: number,
): number {
  return recipe.reduce(
    (max, component) => Math.min(max, Math.floor(maxLineQuantity / component.quantity)),
    maxLineQuantity,
  );
}
