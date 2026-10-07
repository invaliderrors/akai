import type { InventoryRow } from "@akai/contracts";

/**
 * Pure display logic for the stock list.
 *
 * It lives outside the route module for the same reason the coupon list's does:
 * `page.tsx` reaches `createServerApiClient` → `lib/session/server.ts`, which
 * throws if it is ever pulled into client code. That guard is correct, and it
 * also makes anything defined beside it untestable from jsdom.
 *
 * TONES ARE NOT HERE ANY MORE. `StockState` is still DECLARED here, beside the
 * resolver that derives it, but the tone it badges with lives in `lib/status`
 * under the `stock` domain. One consequence is worth stating where the resolver
 * is read: `out` is `attention` there, not the `danger` this file used to give
 * it — the loudest treatment the product can draw, and one of only two places
 * it is spent. The ROW rail that goes with it is gated on the PRODUCT being
 * ACTIVE by the pages, because an `InventoryRow` carries no product status and
 * an archived product at zero is nobody's problem.
 */

/**
 * What an operator needs to know at a glance, derived rather than stored.
 *
 * UNTRACKED IS FIRST AND IS NOT A STOCK LEVEL. A variant with no inventory record
 * shows zero everywhere, which reads as "sold out" — but sold out is fixed by
 * restocking and this is fixed by creating the record. Ranking it above the
 * numeric states is what stops the two being confused.
 */
export type StockState = "untracked" | "out" | "low" | "backorder" | "ok";

export function resolveStockState(row: InventoryRow): StockState {
  if (!row.tracked) {
    return "untracked";
  }
  if (row.available <= 0) {
    // Checked BEFORE backorder: a backorder-enabled variant at zero is still
    // sellable, but an operator scanning for problems should see the zero.
    return row.allowBackorder ? "backorder" : "out";
  }
  if (row.available <= row.lowStockThreshold && !row.allowBackorder) {
    return "low";
  }
  return "ok";
}

/**
 * `searchParams` values are `string | string[] | undefined`. A repeated query
 * key arrives as an ARRAY, and passing that straight into a query string
 * serialises as "a,b" — which the API then rejects as one malformed value.
 */
export function single(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
