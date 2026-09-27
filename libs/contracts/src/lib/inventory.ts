import { z } from "zod";
import { idSchema, localeSchema, paginatedSchema } from "./common";

/**
 * The admin inventory list.
 *
 * WHY A LIST EXISTS AT ALL when per-variant inventory is already served by
 * `/admin/products/variants/:variantId/inventory`: an operator asking "what am I
 * about to run out of" cannot answer it one variant at a time, and the single
 * most important row is the one that does NOT have an inventory record.
 *
 * A variant with no `inventory_item` row has no stock, cannot be reserved and is
 * therefore unsellable — and it is invisible in every other surface, because
 * every other query joins inventory INNER and the row simply drops out. This list
 * LEFT JOINs precisely so those variants appear, flagged `tracked: false`.
 */

export const inventoryRowSchema = z
  .object({
    variantId: idSchema,
    sku: z.string().min(1),
    productId: idSchema,
    productSlug: z.string().min(1),
    /**
     * Locale-resolved product name. Null only when a product carries NO
     * translation in any locale, which is a data defect worth seeing rather than
     * hiding behind the slug.
     */
    productName: z.string().nullable(),
    /**
     * False when no `inventory_item` row exists. The counts below are then all
     * zero, which is not a lie — the variant genuinely cannot be sold — but the
     * flag is what tells an operator it is a MISSING RECORD rather than a
     * sold-out one, because the fix is different.
     */
    tracked: z.boolean(),
    onHand: z.number().int(),
    /** Held by live checkout reservations; not available, not yet sold. */
    reserved: z.number().int(),
    /** `onHand - reserved`. Derived in SQL, never stored — see the Prisma model. */
    available: z.number().int(),
    lowStockThreshold: z.number().int(),
    allowBackorder: z.boolean(),
  })
  .strict();

export type InventoryRow = z.infer<typeof inventoryRowSchema>;

export const paginatedInventorySchema = paginatedSchema(inventoryRowSchema);
export type PaginatedInventory = z.infer<typeof paginatedInventorySchema>;

/** Which slice of the catalogue the operator is looking at. */
export const inventoryFilterSchema = z.enum([
  "all",
  /** available <= threshold, and backorder is off. The restock queue. */
  "low",
  /** available <= 0. Already unsellable. */
  "out",
  /** No inventory_item row at all — a setup defect, not a stock level. */
  "untracked",
]);

export type InventoryFilter = z.infer<typeof inventoryFilterSchema>;

export const inventoryListQuerySchema = z
  .object({
    /**
     * Keyset cursor, and it is a SKU rather than a uuid: the list is ordered by
     * sku (the only thing an operator can scan), and `sku` is UNIQUE on
     * product_variant, so it is a valid stable key on its own.
     */
    cursor: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    filter: inventoryFilterSchema.default("all"),
    /** Substring match against sku and the translated product name. */
    search: z.string().min(1).max(120).optional(),
    locale: localeSchema.default("es"),
  })
  .strict();

export type InventoryListQuery = z.infer<typeof inventoryListQuerySchema>;

/**
 * Why a manual stock adjustment was refused.
 *
 * A SUB-CODE carried as the error envelope's `reason`, not an ErrorCode:
 * `errorCodeSchema` is closed and exhausted by `Record<ErrorCode, …>` maps in
 * both web apps, and the coarse codes these ride on are already right —
 * `CONFLICT` for a stale count, `OUT_OF_STOCK` for a write-down the stock cannot
 * absorb. What the codes cannot do is tell the operator WHICH, and the two need
 * different actions: reload and re-count, versus release or wait out the
 * reservations.
 *
 * Declared here, once, so the API's `CatalogError` and the dashboard's message
 * map cannot drift apart. Parsed by the client, never rendered.
 */
export const inventoryAdjustFailureReasonSchema = z.enum([
  /**
   * The request carried `expectedOnHand` and the stored count no longer matches
   * it — an order or another operator moved it after the page was rendered.
   * The delta was computed against a number that is no longer true. CONFLICT.
   */
  "STOCK_CHANGED",
  /** `onHand + delta` would fall below what live checkouts hold. OUT_OF_STOCK. */
  "BELOW_RESERVED",
  /**
   * The variant had no inventory row yet and the first adjustment is negative,
   * so the row it would create starts below zero. OUT_OF_STOCK.
   */
  "NEGATIVE_STOCK",
]);

export type InventoryAdjustFailureReason = z.infer<typeof inventoryAdjustFailureReasonSchema>;
