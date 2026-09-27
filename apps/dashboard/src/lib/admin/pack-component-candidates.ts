import type { AdminHttp } from "./http";
import { listProducts } from "./api";

/**
 * The products that may be pinned as a pack's components, for the picker in
 * the form.
 *
 * UNLIKE `loadAddOnCandidates`, NOT FILTERED TO UNLISTED PRODUCTS — a pack's
 * components are ordinary catalogue products, exactly the ones a shopper would
 * otherwise buy individually. The only exclusions are the pack itself (it
 * cannot be its own component — the server enforces this too, but naming it
 * here keeps it out of the list rather than out of a 400 after ticking it) and
 * every OTHER pack: a pack's own variant is never sold (see `ProductKind`'s
 * doc comment), so pinning one as a component would let an "add pack to cart"
 * silently try to add a non-purchasable line. Nothing server-side forbids this
 * today, so the picker is the one place it is actually kept from happening.
 *
 * NEVER THROWS, same reasoning as `loadAddOnCandidates`: an API blip should
 * leave an operator able to write a product, not staring at an error where a
 * picker should be.
 */
export interface PackComponentCandidateRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  /** The first active variant's price, for the running total hint. Null when none. */
  readonly priceGross: number | null;
  readonly currency: string | null;
  /** Every variant, active or not — same reasoning as `AddOnCandidateRow.variants`. */
  readonly variants: readonly PackComponentCandidateVariant[];
}

/** One variant of a candidate, resolved for the picker. */
export interface PackComponentCandidateVariant {
  readonly id: string;
  readonly label: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly isActive: boolean;
}

export async function loadPackComponentCandidates(
  http: AdminHttp,
  locale: "es" | "en",
  excludePackProductId?: string,
): Promise<readonly PackComponentCandidateRow[]> {
  try {
    const page = await listProducts(http, { limit: 100, sort: "name", locale });

    return page.items
      .filter((product) => product.kind !== "PACK")
      .filter((product) => product.id !== excludePackProductId)
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
            label:
              variant.name?.[locale] ??
              variant.name?.es ??
              variant.name?.en ??
              variant.sku,
            priceGross: variant.price.gross,
            currency: variant.price.currency,
            isActive: variant.isActive,
          })),
          name:
            product.translations.find((translation) => translation.locale === locale)
              ?.name ??
            product.translations[0]?.name ??
            product.slug,
        };
      });
  } catch {
    return [];
  }
}
