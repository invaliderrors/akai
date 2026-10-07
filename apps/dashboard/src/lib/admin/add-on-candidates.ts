import type { AdminHttp } from "./http";
import { listProducts } from "./api";

/**
 * The products that may be offered as add-ons, for the picker in the form.
 *
 * ONE PLACE, because both product pages need it and the candidate shape would
 * otherwise be copied into each of them.
 *
 * FILTERED CLIENT-SIDE, deliberately. `adminProductListQuerySchema` is
 * `.strict()` and has no `listed` member, so the admin list cannot be asked for
 * add-ons; the admin list does, however, return them, which the public one does
 * not. Widening the query schema to express this would put a merchandising axis
 * into a query string for no gain — the set is small and one page covers it.
 *
 * NEVER THROWS. The create page has no failure mode today, and a picker is not
 * worth giving it one: an API blip must leave the operator able to write a
 * product, not staring at an error where a form should be.
 */
export interface AddOnCandidateRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /**
   * DRAFT add-ons are offered but flagged, and that is the point.
   *
   * The storefront serves only ACTIVE products, so attaching a draft produces a
   * page that silently shows no strip — which is exactly how this was
   * discovered. Hiding drafts from the picker would be worse: attaching an
   * add-on before publishing it is a legitimate order of work. So it is
   * offered, and labelled.
   */
  readonly status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  /**
   * The first active variant's price, for the preview's add-on card.
   *
   * The shop's card shows a price, so a preview without one would not be the
   * "exactly like the storefront" it claims to be. Null when the product has no
   * active variant — in which case the shop would not offer it either.
   */
  readonly priceGross: number | null;
  readonly currency: string | null;
  /**
   * EVERY variant, so the operator can choose which one a product page
   * pre-selects — "mini, free" rather than "tote bag, somehow".
   *
   * All of them, including inactive ones, and each carries `isActive` so the
   * picker can show a variant it will not let you choose. Filtering them out
   * here would make a variant that exists look like one that does not, and the
   * operator would go looking for it.
   */
  readonly variants: readonly AddOnCandidateVariant[];
}

/** One variant of an add-on, resolved for the picker. */
export interface AddOnCandidateVariant {
  readonly id: string;
  /** The variant's name, falling back to the SKU. */
  readonly label: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly isActive: boolean;
}

export async function loadAddOnCandidates(
  http: AdminHttp,
  excludeProductId?: string,
): Promise<readonly AddOnCandidateRow[]> {
  try {
    const page = await listProducts(http, { limit: 100, sort: "name" });

    return page.items
      .filter((product) => !product.listed)
      .filter((product) => product.id !== excludeProductId)
      .map((product) => {
        const sellable = product.variants.find((variant) => variant.isActive);
        return {
        id: product.id,
        slug: product.slug,
        status: product.status,
        priceGross: sellable?.price.gross ?? null,
        currency: sellable?.price.currency ?? null,
        variants: product.variants.map((variant) => ({
          id: variant.id,
          // The SKU stands in for an unnamed variant — always present, always unique.
          label: variant.name ?? variant.sku,
          priceGross: variant.price.gross,
          currency: variant.price.currency,
          isActive: variant.isActive,
        })),
        name: product.name,
        };
      });
  } catch {
    return [];
  }
}
