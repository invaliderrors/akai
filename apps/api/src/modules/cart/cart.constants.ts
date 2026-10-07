/**
 * Cart module constants.
 *
 * These are exported rather than inlined because three different places need to
 * agree on them — the service, the DTO schemas and the tests — and a per-line
 * maximum that drifts between the validator and the merge policy is exactly how
 * a merge quietly produces a 300-unit line that no add-to-cart call could.
 */

/**
 * Per-line quantity ceiling. Mirrors `cartItemSchema.quantity.max(99)` in
 * @akai/contracts; the contracts schema is the wire-level authority and this
 * constant is the server-side enforcement of the same number.
 *
 * It is also the cap applied by the merge-on-login policy (spec §13:
 * "quantity-sum, capped at the per-line max").
 */
export const MAX_LINE_QUANTITY = 99;

/**
 * How long a cart survives without activity.
 *
 * Every mutation pushes this forward, so the window is "since last touched",
 * not "since created" — otherwise a customer filling a large basket over an
 * afternoon would watch it evaporate mid-session.
 */
export const CART_TTL_DAYS = 30;

export const CART_TTL_MS = CART_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Header carrying the opaque anonymous-cart token.
 *
 * A header rather than a body field so the same value is presented uniformly on
 * GET and DELETE, and so it never lands in a URL — a token in a query string
 * leaks into access logs and Referer headers (the same reasoning that moved the
 * revalidation secret off the query string in spec §13).
 */
export const CART_TOKEN_HEADER = "x-cart-token";

/**
 * Raw token size. 32 bytes = 256 bits of entropy, base64url-encoded to 43
 * characters. This token is a bearer credential for a cart, so it is sized like
 * one rather than like a session id.
 */
export const CART_TOKEN_BYTES = 32;

/** Length of the base64url encoding of CART_TOKEN_BYTES bytes, unpadded. */
export const CART_TOKEN_ENCODED_LENGTH = 43;

/**
 * Currency a newly created cart is denominated in.
 *
 * The store sells in Colombian pesos, but the schema is not COP-only (`currency` is a column
 * on cart, cart_item and product_variant), so this is the DEFAULT, not an
 * assumption baked into the arithmetic. A cart never mixes currencies: adding a
 * variant priced in another currency is rejected rather than silently converted,
 * because an implicit FX conversion in a cart is an unauditable exchange rate.
 *
 * INTEGRATION: should move to validated config once a currency/region setting
 * exists in libs/config. See followUps.
 */
export const DEFAULT_CART_CURRENCY = "COP";

/**
 * Locale a cart is presented in when the caller names none.
 *
 * Matches the storefront's default route (next-intl serves `es` at `/`). It is a
 * FALLBACK, not a fixed setting: every cart route accepts `?locale=`, and the
 * repository resolves display names against it. The previous behaviour — Spanish
 * pinned inside the Prisma adapter with no request-level override — meant an
 * English shopper's basket was labelled in Spanish and no client could ask
 * otherwise, which made a translation defect unfixable from the storefront.
 */
export const DEFAULT_CART_LOCALE = "es";
