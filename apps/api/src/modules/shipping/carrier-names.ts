/**
 * Sendcloud carrier code → the name a customer reads under a shipping method
 * ("InPost · 1–2 días").
 *
 * A closed table rather than Sendcloud's own `carrier.name` ("InPost Spain"):
 * the quote endpoint must not make a vendor call per request, and the vendor's
 * name is written for merchants. An unknown code renders NO carrier line
 * (null) rather than the raw code — `ups` in a checkout reads like a bug.
 * Brand names, so the same in every locale.
 */
const CARRIER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  inpost_es: "InPost",
  ups: "UPS",
  correos: "Correos",
  correos_express: "Correos Express",
  seur: "SEUR",
  gls_es: "GLS",
  dhl: "DHL",
  dhl_express: "DHL Express",
  dpd: "DPD",
  mondial_relay: "Mondial Relay",
  ctt: "CTT",
};

export function carrierDisplayName(carrierCode: string | null): string | null {
  if (carrierCode === null) {
    return null;
  }
  return CARRIER_DISPLAY_NAMES[carrierCode] ?? null;
}
