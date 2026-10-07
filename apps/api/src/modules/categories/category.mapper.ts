import type { Category, CategoryListItem } from "@akai/contracts";

/**
 * Prisma `category` row → the public list shape.
 *
 * Separate from `product.mapper.ts`'s `mapCategory` on purpose, and the
 * difference is not cosmetic: that one maps a category as it appears NESTED IN A
 * PRODUCT, where `sortOrder` is the product's position within the category. This
 * one maps a category in its own right, where `sortOrder` is the category's
 * position in the navigation. Same column name, two different meanings; merging
 * them would produce a nav that reorders itself depending on which product was
 * read last.
 */

/** The row shape this mapper needs, declared structurally rather than imported. */
export interface CategoryRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly sortOrder: number;
}

/**
 * Map one row, with the shopper-visible product count supplied by the caller.
 *
 * The count is a parameter rather than a field on the row because it is the
 * result of a filtered aggregate (active, non-deleted, at least one purchasable
 * variant) that the repository computes in SQL. Passing it in keeps this
 * function pure and keeps the definition of "visible" in exactly one place.
 */
export function mapCategory(row: CategoryRow, productCount: number): CategoryListItem {
  return { ...mapCategoryEntity(row), productCount };
}

/**
 * Map one row to the bare entity — no product count.
 *
 * Used by the admin category CRUD writes (`ProductsService.createCategory` and
 * its siblings in `apps/api/src/modules/catalog/`), which hand back the
 * category itself, not a navigation listing. A write has no count to report —
 * computing one would mean a second aggregate query for a number every caller
 * already knows is unchanged (create) or irrelevant (rename).
 */
export function mapCategoryEntity(row: CategoryRow): Category {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sortOrder: row.sortOrder,
  };
}
