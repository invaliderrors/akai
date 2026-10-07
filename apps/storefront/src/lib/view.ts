import type { MediaAsset, PublicProduct, PublicProductVariant } from "@akai/contracts";
import { formatMoney } from "@akai/money";

/** Presentation helpers over the public catalogue shapes. */

export function primaryMedia(product: PublicProduct): MediaAsset | undefined {
  return [...product.media].sort((a, b) => a.sortOrder - b.sortOrder).at(0);
}

/** An image's alt text, falling back to the product name when none was written. */
export function mediaAlt(media: MediaAsset, productName: string): string {
  return media.alt.trim() === "" ? productName : media.alt;
}

/** A variant's label: its name, else its options ("M · Negro"), else its SKU. */
export function variantLabel(variant: PublicProductVariant): string {
  if (variant.name !== null && variant.name.trim() !== "") return variant.name;
  return Object.values(variant.options).join(" · ") || variant.sku;
}

export function isSellable(variant: PublicProductVariant): boolean {
  return variant.isActive && (variant.inventory.available > 0 || variant.inventory.allowBackorder);
}

/** The cheapest active variant's price — what a product card shows as "from". */
export function displayPrice(product: PublicProduct): string | null {
  const cheapest = product.variants
    .filter((variant) => variant.isActive)
    .sort((a, b) => a.price.gross - b.price.gross)
    .at(0);
  return cheapest === undefined ? null : formatMoney(cheapest.price.gross, cheapest.price.currency);
}
