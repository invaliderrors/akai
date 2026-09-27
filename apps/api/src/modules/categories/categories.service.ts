import { Inject, Injectable } from "@nestjs/common";
import type { CategoryListItem, CategoryListResponse, Locale } from "@akai/contracts";

import { mapCategory } from "./category.mapper";
import {
  CATEGORIES_REPOSITORY,
  type CategoriesRepository,
} from "./categories.repository";

/**
 * Public category navigation.
 *
 * WHAT WAS MISSING: `GET /v1/products?category=<slug>` already filtered
 * correctly, so the catalog could FILTER by category the whole time — what no
 * client could do was DISCOVER which categories exist. The storefront's home
 * page category chips and the catalog's filter pills both derive their options
 * from a category list, so both rendered empty with no error anywhere.
 *
 * Deliberately thin. The interesting decision — what "a product a shopper can
 * see" means — lives in the repository's SQL next to the predicate it must match,
 * not spread across a service that would have to re-derive it.
 */
@Injectable()
export class CategoriesService {
  constructor(
    @Inject(CATEGORIES_REPOSITORY)
    private readonly repository: CategoriesRepository,
  ) {}

  /**
   * Every visible category, in navigation order.
   *
   * EMPTY CATEGORIES ARE RETURNED. Filtering them out server-side would make the
   * navigation flicker as stock and publication state move, and would deny the
   * storefront a distinction it may want to draw (grey out vs. omit). The count
   * is in the payload; the presentation decision belongs to the presenter.
   *
   * NOT PAGINATED, and not for want of a cursor: a store's category tree is tens
   * of rows and is rendered whole in a nav. Paginating it would force every
   * consumer to loop to build the only thing any of them ever needs.
   *
   * `locale` breaks TIES ONLY. The operator's explicit `sortOrder` always wins —
   * a merchandiser who put "Bundles" last meant it, in every language. Within an
   * equal sortOrder the order falls back to the localised name, so a nav is
   * alphabetical in the language the visitor is reading rather than alphabetical
   * in Spanish for everyone. Sorting purely by name would silently discard the
   * merchandising decision; ignoring locale entirely would leave English
   * visitors with a list ordered by Spanish words.
   */
  async list(locale: Locale): Promise<CategoryListResponse> {
    const rows = await this.repository.listVisible();
    const items = rows.map((row) => mapCategory(row, row.productCount));

    return { items: [...items].sort(byOrderThenName(locale)) };
  }
}

/** Explicit order first, then the localised name, then slug as a final tiebreak. */
function byOrderThenName(
  locale: Locale,
): (a: CategoryListItem, b: CategoryListItem) => number {
  return (a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    // Falling back to the slug keeps the comparison total even for a category
    // with no translation in this locale, so the order is deterministic across
    // replicas rather than dependent on the row order the database returned.
    const left = a.name[locale] ?? a.slug;
    const right = b.name[locale] ?? b.slug;
    return left.localeCompare(right, locale);
  };
}
