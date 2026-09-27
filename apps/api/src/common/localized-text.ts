import { z } from "zod";
import { localeSchema, type Locale } from "@akai/contracts";

/**
 * Per-locale display text, and the one way to resolve it server-side.
 *
 * WHY IT EXISTS. Every user-facing name in the model is a locale-keyed record —
 * `category.name`, `product_variant.name`, `media_asset.alt` and now
 * `shipping_rate.name`. The storefront resolves those through one shared
 * function (`apps/storefront/src/lib/catalog/view.ts`), but the API had no
 * equivalent, because until shipping it never had to render one: the catalog
 * ships the whole record to the client and lets it choose.
 *
 * Shipping is different. The chosen method's name is STAMPED ONTO THE ORDER
 * (`order.shippingMethodName`), and from there it is inherited by the
 * confirmation email and the invoice. That copy has to be resolved once, at
 * order time, in the customer's locale — an order is immutable and must keep
 * reproducing the words the customer actually agreed to, not re-resolve them
 * against whatever locale happens to be reading the invoice years later.
 *
 * So: the wire keeps the record (the client picks), and this module exists for
 * the one place that has to freeze a single string.
 */

/**
 * A locale-keyed record as it is validated coming OUT of a Json column.
 *
 * Deliberately partial — a store may legitimately have Spanish copy before the
 * English is written, and refusing to read such a row would take a catalogue
 * page down over a translation gap.
 */
export const localizedTextSchema = z.record(localeSchema, z.string());

export type LocalizedText = Readonly<Partial<Record<Locale, string>>>;

/**
 * The locale the fallback chain lands on when the active one has no copy.
 *
 * Spanish, because it is the storefront's default locale and the language the
 * catalogue is authored in. Duplicated as a constant here rather than imported
 * from `@akai/i18n`: that library is `scope:shared` front-end routing, and the
 * API has no business depending on Next.js locale routing to name a parcel.
 */
const FALLBACK_LOCALE: Locale = "es";

/**
 * Narrow a Prisma Json value to a locale record, degrading to `{}`.
 *
 * The same deliberate asymmetry `product.mapper.ts` documents: a bad request
 * body must fail loudly, but one malformed row must not 500 every shopper. A
 * rate whose name will not parse resolves to "no name in any locale", and
 * `selectShippingOptions` then refuses to offer it — the rate becomes
 * unbuyable rather than unnamed, which is the safe direction to fail.
 *
 * Takes `unknown` rather than `Prisma.JsonValue` so this module does not pull a
 * Prisma type into files that have no other reason to know about the database.
 */
export function narrowLocalizedText(value: unknown): LocalizedText {
  const parsed = localizedTextSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/**
 * Resolve a record to one string: active locale → Spanish → any locale present.
 *
 * The last step is what separates this from the storefront's `pickLocaleText`,
 * which stops at the default and lets the caller fall back to a slug or an SKU.
 * A shipping method has no slug and no SKU, so "any name we have" beats a blank
 * line on an invoice. `null` therefore means the record is genuinely empty.
 */
export function pickLocalizedText(text: LocalizedText, locale: Locale): string | null {
  return text[locale] ?? text[FALLBACK_LOCALE] ?? firstValue(text);
}

/** Whether any locale has copy at all. The selector's "is this nameable" test. */
export function hasLocalizedText(text: LocalizedText): boolean {
  return firstValue(text) !== null;
}

function firstValue(text: LocalizedText): string | null {
  for (const value of Object.values(text)) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}
