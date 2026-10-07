import { Injectable } from "@nestjs/common";
import { Prisma } from "@akai/db";
import { z } from "zod";

import { PrismaService } from "../prisma/prisma.service";

/**
 * The categories read seam.
 *
 * A port so `CategoriesService`'s ordering and mapping are unit-testable against
 * an in-memory double, matching CART_REPOSITORY and SHIPPING_REPOSITORY. The
 * Prisma adapter below stays a single query with no branching worth hiding a bug
 * in.
 */
export interface CategoryWithCount {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly sortOrder: number;
  /** Products a SHOPPER would see under this category. See the SQL below. */
  readonly productCount: number;
}

export interface CategoriesRepository {
  listVisible(): Promise<readonly CategoryWithCount[]>;
}

export const CATEGORIES_REPOSITORY = Symbol("CATEGORIES_REPOSITORY");

/**
 * `$queryRaw` returns `unknown` rows. Parsed, not cast — a renamed column would
 * otherwise surface as `undefined` behind a `string` static type. `coerce`
 * absorbs the driver returning COUNT() as a bigint rather than a number, which
 * it does, and which `JSON.stringify` then throws on.
 */
const rowsSchema = z.array(
  z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    sortOrder: z.coerce.number().int(),
    productCount: z.coerce.number().int().min(0),
  }),
);

@Injectable()
export class PrismaCategoriesRepository implements CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every non-deleted category, with the count of products a shopper can
   * actually reach through it.
   *
   * THE COUNT PREDICATE MUST MATCH `product-query.ts`'s public filters exactly —
   * active status, not soft-deleted, at least one active non-deleted variant. A
   * count computed under looser rules is worse than no count: the nav promises
   * "Recovery (4)" and the listing behind it shows two, which reads as a broken
   * store rather than as a stale number.
   *
   * Raw SQL rather than Prisma's `_count`, because `_count` cannot express a
   * filter on a nested to-many relation (the variant condition) and would count
   * every join row including draft products.
   */
  async listVisible(): Promise<readonly CategoryWithCount[]> {
    const rows: unknown = await this.prisma.$queryRaw(Prisma.sql`
      SELECT
        c.id                       AS "id",
        c.slug                     AS "slug",
        c.name                     AS "name",
        c."sortOrder"              AS "sortOrder",
        COALESCE(counted.total, 0) AS "productCount"
      FROM "category" c
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total
        FROM "product_category" pc
        JOIN "product" p ON p.id = pc."productId"
        WHERE pc."categoryId" = c.id
          AND p."deletedAt" IS NULL
          AND p.status = 'ACTIVE'::"ProductStatus"
          AND EXISTS (
            SELECT 1 FROM "product_variant" v
            WHERE v."productId" = p.id
              AND v."deletedAt" IS NULL
              AND v."isActive" = TRUE
          )
      ) counted ON TRUE
      WHERE c."deletedAt" IS NULL
      ORDER BY c."sortOrder" ASC, c.slug ASC
    `);

    const parsed = rowsSchema.safeParse(rows);
    if (!parsed.success) {
      throw new Error("Category listing returned an unexpected row shape.");
    }

    // Rebuilt field by field rather than returned wholesale, so a future column
    // added to the SELECT does not silently reach the caller.
    return parsed.data.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      sortOrder: row.sortOrder,
      productCount: row.productCount,
    }));
  }
}
