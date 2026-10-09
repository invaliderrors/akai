import type { MediaAsset, PublicProduct, PublicProductVariant } from "@akai/contracts";
import { formatMoney } from "@akai/money";

/** Presentation helpers over the public catalogue shapes. */

/** The gallery in display order. */
export function sortedMedia(product: PublicProduct): MediaAsset[] {
  return [...product.media].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function primaryMedia(product: PublicProduct): MediaAsset | undefined {
  return sortedMedia(product).at(0);
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

export interface SizeOption {
  readonly label: string;
  /** The variant a tap on this size adds: the first sellable one in that size. Null when it is sold out. */
  readonly variantId: string | null;
}

/** One entry per distinct `size` option, in variant order. Variants without a size are skipped. */
export function sizeOptions(product: PublicProduct): SizeOption[] {
  const sizes = new Map<string, string | null>();
  for (const variant of product.variants) {
    const size = variant.options["size"];
    if (!variant.isActive || size === undefined) continue;
    if (!sizes.has(size)) sizes.set(size, null);
    if (sizes.get(size) === null && isSellable(variant)) sizes.set(size, variant.id);
  }
  return [...sizes].map(([label, variantId]) => ({ label, variantId }));
}

/** The swatch for each Spanish colour word a `color` option may hold. */
const SWATCHES: Readonly<Record<string, string>> = {
  negro: "var(--color-ink)",
  blanco: "var(--color-paper)",
  crema: "var(--color-paper)",
  rojo: "var(--color-akai)",
  gris: "var(--color-stone)",
  azul: "navy",
  verde: "olive",
  beige: "tan",
  cafe: "sienna",
  marron: "sienna",
};

/** Swatch colours for the distinct `color` options. Colours without a known swatch are left out. */
export function colorSwatches(product: PublicProduct): string[] {
  const swatches = new Set<string>();
  for (const variant of product.variants) {
    const color = variant.options["color"];
    if (!variant.isActive || color === undefined) continue;
    const word = color
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
    const swatch = SWATCHES[word];
    if (swatch !== undefined) swatches.add(swatch);
  }
  return [...swatches];
}

export type ProductBadge = "soldOut" | "low" | "limited" | "new" | null;

export interface BadgeRules {
  /** At or under this many units across every sellable variant (and no backorder): LOW STOCK. */
  readonly lowStockThreshold: number;
  /** Products in this category are LIMITED. */
  readonly limitedCategorySlug: string;
  /** Products created this recently are NEW. */
  readonly newForMs: number;
  readonly now: number;
}

/** The one badge a product card shows, most urgent first. */
export function productBadge(product: PublicProduct, rules: BadgeRules): ProductBadge {
  const sellable = product.variants.filter(isSellable);
  if (sellable.length === 0) return "soldOut";
  const backorder = sellable.some((variant) => variant.inventory.allowBackorder);
  const units = sellable.reduce((sum, variant) => sum + variant.inventory.available, 0);
  if (!backorder && units <= rules.lowStockThreshold) return "low";
  if (product.categories.some((category) => category.slug === rules.limitedCategorySlug)) return "limited";
  if (rules.now - Date.parse(product.createdAt) <= rules.newForMs) return "new";
  return null;
}

/** The product's first category, as the small type line under its name. */
export function categoryLabel(product: PublicProduct): string | null {
  return [...product.categories].sort((a, b) => a.sortOrder - b.sortOrder).at(0)?.name ?? null;
}

/** The cheapest active variant's price. */
export function cheapestPrice(product: PublicProduct): PublicProductVariant["price"] | null {
  return (
    product.variants
      .filter((variant) => variant.isActive)
      .map((variant) => variant.price)
      .sort((a, b) => a.gross - b.gross)
      .at(0) ?? null
  );
}

/** The cheapest active variant's price — what a product card shows as "from". */
export function displayPrice(product: PublicProduct): string | null {
  const cheapest = cheapestPrice(product);
  return cheapest === null ? null : formatMoney(cheapest.gross, cheapest.currency);
}
