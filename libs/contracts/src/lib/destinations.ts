/**
 * Where the store ships TO, and the free-shipping figure the storefront
 * advertises — the two shipping facts more than one app has to agree on.
 *
 * `DESTINATION_COUNTRY_CODES` WAS STOREFRONT-LOCAL (`lib/countries.ts`, the
 * checkout's country selector). The shipping-zone editor (spec
 * `2026-09-24-sendcloud-shipping.md` §7a) needs the SAME list twice more — the
 * dashboard's country picker and the API's zone validation — and a web app's
 * source is out of reach of both (`scope:web` → `scope:server` is a boundary
 * error, and one Next app cannot import another). So the list moved here,
 * unchanged, and the storefront re-exports it: one list, three readers.
 *
 * It is a list of countries we are WILLING to serve, not the ones we do: a
 * country only becomes a real destination when a shipping zone covers it
 * (the quote answers `destinationServed: false` otherwise). A zone may only
 * claim a country from this list, so a checkout can never be offered a
 * destination its own country selector does not list.
 */
export const DESTINATION_COUNTRY_CODES = [
  "ES",
  "PT",
  "FR",
  "DE",
  "IT",
  "NL",
  "BE",
  "IE",
  "AT",
  "DK",
  "FI",
  "SE",
  "PL",
  "CZ",
  "SK",
  "SI",
  "HR",
  "HU",
  "RO",
  "BG",
  "GR",
  "EE",
  "LV",
  "LT",
  "LU",
  "MT",
  "CY",
  "NO",
  "IS",
  "LI",
  "CH",
  "GB",
] as const;

export type DestinationCountryCode = (typeof DESTINATION_COUNTRY_CODES)[number];

const DESTINATION_SET: ReadonlySet<string> = new Set(DESTINATION_COUNTRY_CODES);

export function isDestinationCountry(code: string): code is DestinationCountryCode {
  return DESTINATION_SET.has(code);
}

/**
 * The free-shipping threshold the storefront's COPY states ("Envío gratis en
 * pedidos superiores a 250 €"), in integer minor units.
 *
 * Not what checkout applies — that is each rate's own `freeOverSubtotal`, now
 * editable by staff. It is what the marketing copy PROMISES, so the zones
 * editor warns when an active rate's threshold differs from it (spec §7a). The
 * API's seed constant (`FREE_SHIPPING_THRESHOLD_MINOR`) is pinned to this by a
 * test in the admin-shipping module.
 */
export const ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR = 25_000;
