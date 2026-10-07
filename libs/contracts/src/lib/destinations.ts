/**
 * Where the store ships TO, and the free-shipping figure the storefront
 * advertises — the two shipping facts more than one app has to agree on.
 *
 * Akai sells in COLOMBIA ONLY. The list lives here rather than in a web app
 * because three readers need it: the checkout (which fixes the country rather
 * than offering a selector), the dashboard's zone editor and the API's zone and
 * address validation. A zone may only claim a country from this list, and an
 * address may only name one, so a checkout can never be offered a destination
 * the store does not serve.
 *
 * It is a list of countries we are WILLING to serve: a country only becomes a
 * real destination when a shipping zone covers it (the quote answers
 * `destinationServed: false` otherwise).
 */
export const DESTINATION_COUNTRY_CODES = ["CO"] as const;

export type DestinationCountryCode = (typeof DESTINATION_COUNTRY_CODES)[number];

/** The one country the checkout fixes. */
export const STORE_COUNTRY_CODE: DestinationCountryCode = "CO";

const DESTINATION_SET: ReadonlySet<string> = new Set(DESTINATION_COUNTRY_CODES);

export function isDestinationCountry(code: string): code is DestinationCountryCode {
  return DESTINATION_SET.has(code);
}

/**
 * The free-shipping threshold the storefront's COPY states ("Envío gratis en
 * pedidos desde $ 300.000"), in integer minor units (centavos): $300.000 COP.
 *
 * Not what checkout applies — that is each rate's own `freeOverSubtotal`,
 * editable by staff. It is what the marketing copy PROMISES, so the zones
 * editor warns when an active rate's threshold differs from it. The API's seed
 * constant (`FREE_SHIPPING_THRESHOLD_MINOR`) is pinned to this by a test in the
 * admin-shipping module.
 */
export const ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR = 30_000_000;
