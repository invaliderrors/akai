import { localeSchema, type Locale } from "@akai/contracts";

/**
 * The storefront's locale routing rule, declared ONCE.
 *
 * WHY THIS LIVES IN A SHARED LIB AND NOT IN THE STOREFRONT. Two processes have
 * to agree on what a storefront URL looks like: the storefront, which serves it,
 * and the API, which mints the Wompi `redirect-url` a paying customer is sent
 * back to. When the rule was implicit in `apps/storefront/src/i18n/routing.ts`
 * the API guessed, and guessed wrong — it built
 * `${STOREFRONT_URL}/checkout/processing` with no locale segment at all, a shape
 * no English order should ever receive. Nothing failed at compile time, because
 * a URL is a string. It fails in the browser, after the money has moved, which
 * is the worst possible place to discover it.
 *
 * So the rule is data now, imported by both sides. Change the prefix mode here
 * and both the middleware and the return URL follow in the same commit; there is
 * no second copy left behind to drift.
 *
 * The locale VOCABULARY is not redeclared here — `@akai/contracts` owns it, and
 * a second enum would be exactly the duplication this module exists to remove.
 */

/** The locales the storefront serves, in `defineRouting` order. */
export const STOREFRONT_LOCALES: readonly Locale[] = localeSchema.options;

/** Spanish is the default and therefore the UNPREFIXED locale. */
export const DEFAULT_STOREFRONT_LOCALE: Locale = "es";

/**
 * `as-needed`: the default locale is served at `/`, every other locale at
 * `/<locale>`. This constant is fed straight to `defineRouting`, so it cannot
 * disagree with the middleware.
 */
export const STOREFRONT_LOCALE_PREFIX = "as-needed" as const;

/** Narrowing for values arriving from a URL segment, a header or a form. */
export function isStorefrontLocale(value: string): value is Locale {
  return localeSchema.safeParse(value).success;
}

/**
 * The path a given locale actually serves `pathname` at.
 *
 * THIS FUNCTION *IS* THE `as-needed` RULE. Under it the default locale is
 * unprefixed, so `localePathname("es", "/checkout/processing")` is
 * `/checkout/processing` and NOT `/es/checkout/processing`. The prefixed form is
 * not a 404 — next-intl's middleware redirects it — but it costs a redirect hop
 * on the one page a customer reaches with their card already charged, and it
 * quietly asserts a URL shape the app never generates for itself.
 *
 * If `STOREFRONT_LOCALE_PREFIX` ever becomes `always`, this function changes
 * with it and every caller is corrected at once.
 */
export function localePathname(locale: Locale, pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;

  return locale === DEFAULT_STOREFRONT_LOCALE
    ? normalized
    : `/${locale}${normalized}`;
}

/**
 * An absolute storefront URL, locale-correct and query-encoded.
 *
 * `query` goes through `URLSearchParams`, so an order number containing a
 * character that means something in a query string cannot break out of its
 * parameter — the reason this is not a template literal at the call site.
 */
export function storefrontUrl(
  origin: string,
  locale: Locale,
  pathname: string,
  query: Readonly<Record<string, string>> = {},
): string {
  // A trailing slash on the configured origin would otherwise produce a double
  // slash, which some proxies normalise and some serve as a distinct path.
  const base = origin.replace(/\/+$/, "");
  const url = new URL(`${base}${localePathname(locale, pathname)}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}
