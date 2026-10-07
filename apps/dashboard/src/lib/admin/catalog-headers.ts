/**
 * Header the API sets when it stored something OTHER than what an operator
 * submitted — see `CONTENT_SANITIZED_HEADER`'s own doc comment in
 * `apps/api/src/modules/catalog/catalog.constants.ts` for the full reasoning
 * (why a header rather than the body, why not a 400).
 *
 * DUPLICATED, NOT IMPORTED — same reasoning as `CART_TOKEN_HEADER`: a header
 * NAME is a wire-format detail shared across the Nx module boundary between
 * `scope:server` and `scope:web`, and the two apps may not import from each
 * other or from a shared `scope:server` module.
 *
 * The value is a comma-separated list of the field names the sanitiser
 * rewrote on this write — today only `description`.
 */
export const CONTENT_SANITIZED_HEADER = "x-content-sanitized";

/** The header's token for a rewritten product description. */
const DESCRIPTION_TOKEN = "description";

/**
 * Whether the API rewrote the product description on this write.
 *
 * Parsed token by token rather than compared whole: this is external input off
 * the wire like any other, and an unrecognised token (a field a future API
 * sanitises that this dashboard build does not yet know) is ignored rather than
 * mistaken for the description. Absent or empty means nothing was rewritten.
 */
export function parseDescriptionSanitized(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  const raw = headers?.[CONTENT_SANITIZED_HEADER];
  if (raw === undefined || raw === "") {
    return false;
  }

  return raw.split(",").some((token) => token.trim() === DESCRIPTION_TOKEN);
}
