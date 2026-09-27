import { z } from "zod";
import { localeSchema, type Category, type CategoryListItem } from "@akai/contracts";

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

/**
 * Per-locale JSON blobs are external data — parsed, never cast.
 *
 * Keyed on `z.string()` and filtered afterwards rather than on `localeSchema`
 * directly, and the difference is behavioural, not stylistic: a record keyed on
 * an enum REJECTS the whole object when it meets an unknown key, so one row
 * carrying a legacy `fr` name would degrade every name on that category to `{}`
 * — losing the Spanish and English copy that is perfectly valid. Filtering
 * instead keeps the locales we serve and drops the rest.
 */
const rawTextSchema = z.record(z.string(), z.string());

const SUPPORTED_LOCALES = localeSchema.options;

/** The row shape this mapper needs, declared structurally rather than imported. */
export interface CategoryRow {
  readonly id: string;
  readonly slug: string;
  readonly name: unknown;
  readonly sortOrder: number;
}

/**
 * Map one row, with the shopper-visible product count supplied by the caller.
 *
 * The count is a parameter rather than a field on the row because it is the
 * result of a filtered aggregate (active, non-deleted, at least one purchasable
 * variant) that the repository computes in SQL. Passing it in keeps this
 * function pure and keeps the definition of "visible" in exactly one place.
 *
 * A malformed `name` JSON degrades to `{}` rather than throwing, matching
 * `product.mapper.ts`: one bad row must not take down the whole navigation for
 * every visitor, because the admin UI that could fix it is served by the same
 * failing query.
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
    name: narrowLocalisedText(row.name),
    sortOrder: row.sortOrder,
  };
}

/** Keep the locales the store serves; drop anything else without failing. */
function narrowLocalisedText(value: unknown): CategoryListItem["name"] {
  const parsed = rawTextSchema.safeParse(value);
  if (!parsed.success) {
    return {};
  }

  const narrowed: Partial<Record<(typeof SUPPORTED_LOCALES)[number], string>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    const text = parsed.data[locale];
    if (text !== undefined) {
      narrowed[locale] = text;
    }
  }
  return narrowed;
}
