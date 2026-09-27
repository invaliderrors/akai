import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  inventoryRowSchema,
  type InventoryListQuery,
  type InventoryRow,
  type Paginated,
} from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import { escapeLikePattern } from "../catalog/product-query";

/**
 * The admin inventory list — a READ surface over data the catalogue already owns.
 *
 * IT DELIBERATELY DOES NOT MUTATE STOCK. `ProductInventoryService` in the catalog
 * module already implements `adjust`, `setPolicy`, reserve/commit/release and the
 * expiry sweep, all with the conditional-UPDATE guards that make them safe under
 * concurrency, and all already exposed at
 * `/v1/admin/products/variants/:variantId/inventory{,/adjust,/policy}`. A second
 * write path here would be a second place to get those guards wrong.
 *
 * (The InventoryModule docstring claims to OWN atomic decrement and reservations.
 * It does not — they live in `catalog/product-inventory.service.ts` and are
 * tested there. Left as-is rather than moved: relocating the reservation engine
 * is a change to the checkout hot path, not a side effect of adding a list.)
 *
 * THE LEFT JOIN IS THE POINT. Joining `inventory_item` INNER — which every other
 * inventory query does — silently drops variants that have no row, and those are
 * exactly the ones an operator needs to see: no row means no stock, no possible
 * reservation, and a variant that cannot be bought while looking perfectly normal
 * in the catalogue.
 */

/** Raw rows arrive as `unknown` and are parsed, never cast. */
const rowSchema = inventoryRowSchema;

@Injectable()
export class AdminInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InventoryListQuery): Promise<Paginated<InventoryRow>> {
    // Over-fetch by one to learn whether another page exists without a COUNT.
    const fetchLimit = query.limit + 1;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`pv."deletedAt" IS NULL`,
      Prisma.sql`p."deletedAt" IS NULL`,
    ];

    if (query.cursor !== undefined) {
      // Keyset, not OFFSET: rows shift under concurrent writes and an operator
      // paging through a restock queue would see items skipped or repeated.
      conditions.push(Prisma.sql`pv."sku" > ${query.cursor}`);
    }

    if (query.search !== undefined) {
      const pattern = `%${escapeLikePattern(query.search.trim())}%`;
      conditions.push(
        Prisma.sql`(pv."sku" ILIKE ${pattern} OR pt_active."name" ILIKE ${pattern} OR pt_fallback."name" ILIKE ${pattern})`,
      );
    }

    switch (query.filter) {
      case "low":
        // Backorder-enabled variants are excluded: they are sellable at zero, so
        // listing them as "needs restocking" is noise that hides the real ones.
        conditions.push(
          Prisma.sql`ii."variantId" IS NOT NULL AND ii."allowBackorder" = false AND (ii."onHand" - ii."reserved") <= ii."lowStockThreshold"`,
        );
        break;
      case "out":
        conditions.push(
          Prisma.sql`ii."variantId" IS NOT NULL AND (ii."onHand" - ii."reserved") <= 0`,
        );
        break;
      case "untracked":
        conditions.push(Prisma.sql`ii."variantId" IS NULL`);
        break;
      case "all":
        break;
    }

    const where = Prisma.join(conditions, " AND ");

    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT
        pv."id"                                             AS "variantId",
        pv."sku"                                            AS "sku",
        p."id"                                              AS "productId",
        p."slug"                                            AS "productSlug",
        COALESCE(pt_active."name", pt_fallback."name")       AS "productName",
        (ii."variantId" IS NOT NULL)                         AS "tracked",
        COALESCE(ii."onHand", 0)                             AS "onHand",
        COALESCE(ii."reserved", 0)                           AS "reserved",
        COALESCE(ii."onHand" - ii."reserved", 0)             AS "available",
        COALESCE(ii."lowStockThreshold", 0)                  AS "lowStockThreshold",
        COALESCE(ii."allowBackorder", false)                 AS "allowBackorder"
      FROM "product_variant" pv
      JOIN "product" p ON p."id" = pv."productId"
      LEFT JOIN "inventory_item" ii ON ii."variantId" = pv."id"
      LEFT JOIN "product_translation" pt_active
        ON pt_active."productId" = p."id" AND pt_active."locale" = ${query.locale}::"Locale"
      LEFT JOIN "product_translation" pt_fallback
        ON pt_fallback."productId" = p."id" AND pt_fallback."locale" = 'es'
      WHERE ${where}
      ORDER BY pv."sku" ASC
      LIMIT ${fetchLimit}
    `);

    const parsed = z.array(rowSchema).parse(rows);
    const hasMore = parsed.length > query.limit;
    const items = hasMore ? parsed.slice(0, query.limit) : parsed;
    const last = items.at(-1);

    return {
      items,
      hasMore,
      nextCursor: hasMore && last !== undefined ? last.sku : null,
    };
  }
}
