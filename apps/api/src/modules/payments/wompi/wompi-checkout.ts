import { createHash } from "node:crypto";

import type { IdentityDocumentType, Minor } from "@akai/contracts";

/**
 * Wompi WEB CHECKOUT, as pure functions.
 *
 * Akai does not call Wompi to open a checkout: Web Checkout is a GET to
 * `https://checkout.wompi.co/p/` whose query string carries the amount and an
 * INTEGRITY SIGNATURE over it. Building that URL server-side, from the order's
 * own recomputed total, is what makes "our API is the source of truth for the
 * amount" true: the browser is handed a URL it cannot alter without breaking the
 * signature, and the settlement check compares what Wompi reports against the
 * same total again.
 *
 * Pure (no clock, no config, no I/O) so the signature and the parameter set are
 * unit-testable against Wompi's own documented vector.
 *
 * Reference: https://docs.wompi.co/docs/colombia/widget-checkout-web/
 */

/** The only currency Wompi Colombia settles, and the only one Akai sells in. */
export const WOMPI_CURRENCY = "COP";

/** Colombia's dialling prefix, sent beside the 10-digit mobile we store. */
export const COLOMBIA_PHONE_PREFIX = "+57";

/**
 * How long a checkout URL stays payable.
 *
 * 25 MINUTES, DELIBERATELY SHORTER than the 30-minute stock reservation
 * (`RESERVATION_TTL_SECONDS` in checkout.service.ts). Reservations are taken
 * just before the URL is minted, so a link that outlived them would let a
 * shopper pay for stock the expiry sweep has already handed back — the sale
 * would settle but the stock decrement could no longer be guaranteed. Five
 * minutes of margin covers the redirect and Wompi's own processing.
 */
export const CHECKOUT_EXPIRY_MS = 25 * 60 * 1000;

/**
 * Wompi's `legal-id-type` vocabulary, per its docs: CC, CE, NIT, PP, TI, DNI,
 * RG, OTHER. Total over our closed `IdentityDocumentType`, so a new document
 * type is a compile error here rather than a value Wompi rejects.
 *
 * PPT (Permiso por Protección Temporal) HAS NO WOMPI CODE in the documented
 * list, so it maps to OTHER — the conservative choice: the number still
 * travels, and nothing is asserted that Wompi did not document. WOMPI-VERIFY
 * against a sandbox PSE payment made with a PPT.
 */
export const WOMPI_LEGAL_ID_TYPE: Readonly<Record<IdentityDocumentType, string>> = {
  CC: "CC",
  CE: "CE",
  NIT: "NIT",
  PP: "PP",
  TI: "TI",
  PPT: "OTHER",
};

/**
 * The integrity signature Wompi requires on a Web Checkout.
 *
 *   sha256hex(reference + amountInCents + currency + expirationTime + secret)
 *
 * with `expirationTime` omitted from the concatenation when the checkout has
 * none. Plain SHA-256 over the concatenation, NOT an HMAC — the secret is part
 * of the hashed material.
 */
export function wompiIntegritySignature(input: {
  readonly reference: string;
  readonly amountInCents: Minor;
  readonly currency: string;
  readonly expirationTime: string | null;
  readonly integritySecret: string;
}): string {
  const material =
    `${input.reference}${String(input.amountInCents)}${input.currency}` +
    `${input.expirationTime ?? ""}${input.integritySecret}`;

  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * The per-attempt reference: `<orderNumber>-<attempt>`, e.g. `AK-2026-000123-1`.
 *
 * UNIQUE PER ATTEMPT, never reused. Wompi treats the reference as the payment's
 * identity, so a retried checkout (or a staff re-issue) must not reuse the old
 * one — `attempt` is one more than the attempts already recorded, counted under
 * the order row lock. Alphanumerics and hyphens only, as Wompi recommends.
 */
export function wompiReference(orderNumber: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`A checkout attempt number must be a positive integer; got ${attempt}`);
  }
  return `${orderNumber}-${String(attempt)}`;
}

export interface WompiCheckoutCustomer {
  readonly email: string;
  readonly fullName: string;
  /** 10-digit Colombian mobile without +57, or null when the order has none. */
  readonly phoneNumber: string | null;
  readonly legalId: string;
  readonly legalIdType: IdentityDocumentType;
}

export interface WompiCheckoutShipping {
  readonly name: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  /** The departamento. */
  readonly region: string;
  /** ISO-3166 alpha-2. Always CO today. */
  readonly country: string;
  readonly phoneNumber: string;
  readonly postalCode: string | null;
}

export interface WompiCheckoutInput {
  /** `https://checkout.wompi.co/p/`, from the resolved config. */
  readonly checkoutUrl: string;
  readonly publicKey: string;
  readonly integritySecret: string;
  readonly reference: string;
  /** OUR grand total, in centavos — Wompi's `amount-in-cents` is the same unit. */
  readonly amountInCents: Minor;
  readonly currency: typeof WOMPI_CURRENCY;
  readonly expiresAt: Date;
  /** The storefront processing page. Wompi appends `?id=<transactionId>`. */
  readonly redirectUrl: string;
  /** IVA contained in the amount (prices are IVA-inclusive). Omitted when zero. */
  readonly vatInCents: Minor;
  readonly customer: WompiCheckoutCustomer;
  readonly shipping: WompiCheckoutShipping | null;
}

/**
 * The Web Checkout URL.
 *
 * The query is form-encoded (`URLSearchParams`), which percent-encodes the `:`
 * in names such as `signature:integrity` — exactly what a browser submitting
 * Wompi's documented `<form method="GET">` sends.
 */
export function buildWompiCheckoutUrl(input: WompiCheckoutInput): string {
  const expirationTime = input.expiresAt.toISOString();
  const params = new URLSearchParams();

  params.set("public-key", input.publicKey);
  params.set("currency", input.currency);
  params.set("amount-in-cents", String(input.amountInCents));
  params.set("reference", input.reference);
  params.set(
    "signature:integrity",
    wompiIntegritySignature({
      reference: input.reference,
      amountInCents: input.amountInCents,
      currency: input.currency,
      expirationTime,
      integritySecret: input.integritySecret,
    }),
  );
  params.set("redirect-url", input.redirectUrl);
  params.set("expiration-time", expirationTime);

  if (input.vatInCents > 0) {
    params.set("tax-in-cents:vat", String(input.vatInCents));
  }

  params.set("customer-data:email", input.customer.email);
  params.set("customer-data:full-name", input.customer.fullName);
  if (input.customer.phoneNumber !== null) {
    params.set("customer-data:phone-number", input.customer.phoneNumber);
    params.set("customer-data:phone-number-prefix", COLOMBIA_PHONE_PREFIX);
  }
  params.set("customer-data:legal-id", input.customer.legalId);
  params.set("customer-data:legal-id-type", WOMPI_LEGAL_ID_TYPE[input.customer.legalIdType]);

  if (input.shipping !== null) {
    params.set("shipping-address:address-line-1", input.shipping.addressLine1);
    if (input.shipping.addressLine2 !== null) {
      params.set("shipping-address:address-line-2", input.shipping.addressLine2);
    }
    params.set("shipping-address:country", input.shipping.country);
    params.set("shipping-address:city", input.shipping.city);
    params.set("shipping-address:phone-number", input.shipping.phoneNumber);
    params.set("shipping-address:region", input.shipping.region);
    params.set("shipping-address:name", input.shipping.name);
    if (input.shipping.postalCode !== null) {
      params.set("shipping-address:postal-code", input.shipping.postalCode);
    }
  }

  return `${input.checkoutUrl}?${params.toString()}`;
}
