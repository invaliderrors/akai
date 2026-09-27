import { localeSchema, type Locale } from "@akai/contracts";

/**
 * Header the API sets when it stored something OTHER than what an operator
 * submitted — see `CONTENT_SANITIZED_HEADER`'s own doc comment in
 * `apps/api/src/modules/catalog/catalog.constants.ts` for the full reasoning
 * (why a header rather than the body, why not a 400).
 *
 * DUPLICATED, NOT IMPORTED — same reasoning as `CART_TOKEN_HEADER`
 * (`apps/storefront/src/lib/api/cart-token.ts`): a header NAME is a wire-format
 * detail shared across the Nx module boundary between `scope:server` and
 * `scope:web`, and the two apps may not import from each other or from a
 * shared `scope:server` module.
 *
 * The value is a comma-separated list of `Locale` codes whose `description`
 * the sanitiser rewrote on this write.
 */
export const CONTENT_SANITIZED_HEADER = "x-content-sanitized";

/**
 * Parses the header's value into the locales it actually names.
 *
 * Validated against `localeSchema` rather than split-and-trusted: this is
 * external input off the wire like any other, and an unrecognised token
 * (a future locale the API knows about and this dashboard build does not yet)
 * is dropped rather than surfacing as a raw string an operator cannot read.
 * Absent or empty means nothing was rewritten.
 */
export function parseSanitizedLocales(
  headers: Readonly<Record<string, string>> | undefined,
): readonly Locale[] {
  const raw = headers?.[CONTENT_SANITIZED_HEADER];
  if (raw === undefined || raw === "") {
    return [];
  }

  return raw
    .split(",")
    .map((token) => localeSchema.safeParse(token.trim()))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
}
