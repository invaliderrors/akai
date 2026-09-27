import type {
  Locale,
  MediaAsset,
  ProductTranslation,
  PublicProduct,
  PublicProductVariant,
} from "@akai/contracts";
import { DEFAULT_STOREFRONT_LOCALE } from "@akai/i18n";
import { formatMoney } from "@akai/money";

/**
 * Locale-keyed values are resolved HERE and nowhere else: active locale, then
 * the default locale, then whatever exists.
 */
export function pickLocaleText(
  values: Readonly<Partial<Record<Locale, string>>> | null,
  locale: Locale,
): string | null {
  if (values === null) return null;
  return values[locale] ?? values[DEFAULT_STOREFRONT_LOCALE] ?? Object.values(values)[0] ?? null;
}

export function pickTranslation(product: PublicProduct, locale: Locale): ProductTranslation | undefined {
  return (
    product.translations.find((entry) => entry.locale === locale) ??
    product.translations.find((entry) => entry.locale === DEFAULT_STOREFRONT_LOCALE) ??
    product.translations.at(0)
  );
}

export function productName(product: PublicProduct, locale: Locale): string {
  return pickTranslation(product, locale)?.name ?? product.slug;
}

export function primaryMedia(product: PublicProduct): MediaAsset | undefined {
  return [...product.media].sort((a, b) => a.sortOrder - b.sortOrder).at(0);
}

export function isSellable(variant: PublicProductVariant): boolean {
  return variant.isActive && (variant.inventory.available > 0 || variant.inventory.allowBackorder);
}

/** The cheapest active variant's price — what a product card shows as "from". */
export function displayPrice(product: PublicProduct, locale: Locale): string | null {
  const cheapest = product.variants
    .filter((variant) => variant.isActive)
    .sort((a, b) => a.price.gross - b.price.gross)
    .at(0);
  return cheapest === undefined ? null : formatMoney(cheapest.price.gross, cheapest.price.currency, locale);
}
