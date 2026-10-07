import { createHash } from "node:crypto";

import { toMinor } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import {
  CHECKOUT_EXPIRY_MS,
  WOMPI_LEGAL_ID_TYPE,
  buildWompiCheckoutUrl,
  wompiIntegritySignature,
  wompiReference,
  type WompiCheckoutInput,
} from "./wompi-checkout";

function input(overrides: Partial<WompiCheckoutInput> = {}): WompiCheckoutInput {
  return {
    checkoutUrl: "https://checkout.wompi.co/p/",
    publicKey: "pub_test_abc",
    integritySecret: "test_integrity_secret",
    reference: "AK-2026-000123-1",
    amountInCents: toMinor(8_900_000),
    currency: "COP",
    expiresAt: new Date("2026-10-06T12:25:00.000Z"),
    redirectUrl: "https://akai.shop/checkout/processing?order=AK-2026-000123",
    vatInCents: toMinor(1_421_008),
    customer: {
      email: "ana@example.com",
      fullName: "Ana García",
      phoneNumber: "3001234567",
      legalId: "1020304050",
      legalIdType: "CC",
    },
    shipping: {
      name: "Ana García",
      addressLine1: "Calle 10 # 43-21",
      addressLine2: "Apto 501",
      city: "Medellín",
      region: "Antioquia",
      country: "CO",
      phoneNumber: "3001234567",
      postalCode: "050021",
    },
    ...overrides,
  };
}

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("wompiIntegritySignature", () => {
  it("reproduces Wompi's documented vector (no expiration)", () => {
    // docs.wompi.co, "Widget & Checkout Web": the concatenation
    // "sk8-438k4-xmxm392-sn2m2490000COPprod_integrity_Z5mM…" hashes to this.
    expect(
      wompiIntegritySignature({
        reference: "sk8-438k4-xmxm392-sn2m2",
        amountInCents: toMinor(490_000),
        currency: "COP",
        expirationTime: null,
        integritySecret: "prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6",
      }),
    ).toBe("37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5");
  });

  it("puts the expiration between the currency and the secret", () => {
    const expected = createHash("sha256")
      .update("AK-2026-000123-18900000COP2026-10-06T12:25:00.000Zsecret")
      .digest("hex");

    expect(
      wompiIntegritySignature({
        reference: "AK-2026-000123-1",
        amountInCents: toMinor(8_900_000),
        currency: "COP",
        expirationTime: "2026-10-06T12:25:00.000Z",
        integritySecret: "secret",
      }),
    ).toBe(expected);
  });

  it("changes when the amount changes — the point of signing it", () => {
    const base = {
      reference: "AK-2026-000123-1",
      currency: "COP",
      expirationTime: null,
      integritySecret: "secret",
    };
    expect(wompiIntegritySignature({ ...base, amountInCents: toMinor(100) })).not.toBe(
      wompiIntegritySignature({ ...base, amountInCents: toMinor(101) }),
    );
  });
});

describe("wompiReference", () => {
  it("is the order number plus the attempt", () => {
    expect(wompiReference("AK-2026-000123", 1)).toBe("AK-2026-000123-1");
    expect(wompiReference("AK-2026-000123", 12)).toBe("AK-2026-000123-12");
  });

  it("refuses a non-positive or fractional attempt", () => {
    expect(() => wompiReference("AK-2026-000123", 0)).toThrow(RangeError);
    expect(() => wompiReference("AK-2026-000123", 1.5)).toThrow(RangeError);
  });
});

describe("buildWompiCheckoutUrl", () => {
  it("targets Web Checkout with the required parameters", () => {
    const url = buildWompiCheckoutUrl(input());
    const params = query(url);

    expect(url.startsWith("https://checkout.wompi.co/p/?")).toBe(true);
    expect(params.get("public-key")).toBe("pub_test_abc");
    expect(params.get("currency")).toBe("COP");
    expect(params.get("amount-in-cents")).toBe("8900000");
    expect(params.get("reference")).toBe("AK-2026-000123-1");
    expect(params.get("redirect-url")).toBe(
      "https://akai.shop/checkout/processing?order=AK-2026-000123",
    );
    expect(params.get("expiration-time")).toBe("2026-10-06T12:25:00.000Z");
  });

  it("signs exactly the amount, reference and expiration it sends", () => {
    const params = query(buildWompiCheckoutUrl(input()));

    expect(params.get("signature:integrity")).toBe(
      wompiIntegritySignature({
        reference: "AK-2026-000123-1",
        amountInCents: toMinor(8_900_000),
        currency: "COP",
        expirationTime: "2026-10-06T12:25:00.000Z",
        integritySecret: "test_integrity_secret",
      }),
    );
  });

  it("never puts the integrity secret on the URL", () => {
    expect(buildWompiCheckoutUrl(input())).not.toContain("test_integrity_secret");
  });

  it("percent-encodes the colon in parameter names, as a GET form would", () => {
    expect(buildWompiCheckoutUrl(input())).toContain("signature%3Aintegrity=");
  });

  it("declares the IVA contained in the total, and omits it when there is none", () => {
    expect(query(buildWompiCheckoutUrl(input())).get("tax-in-cents:vat")).toBe("1421008");
    expect(
      query(buildWompiCheckoutUrl(input({ vatInCents: toMinor(0) }))).has("tax-in-cents:vat"),
    ).toBe(false);
  });

  it("pre-fills the payer from the order, with the +57 prefix beside the mobile", () => {
    const params = query(buildWompiCheckoutUrl(input()));

    expect(params.get("customer-data:email")).toBe("ana@example.com");
    expect(params.get("customer-data:full-name")).toBe("Ana García");
    expect(params.get("customer-data:phone-number")).toBe("3001234567");
    expect(params.get("customer-data:phone-number-prefix")).toBe("+57");
    expect(params.get("customer-data:legal-id")).toBe("1020304050");
    expect(params.get("customer-data:legal-id-type")).toBe("CC");
  });

  it("omits the phone pair when the order has no phone", () => {
    const params = query(
      buildWompiCheckoutUrl(
        input({
          customer: { ...input().customer, phoneNumber: null },
        }),
      ),
    );
    expect(params.has("customer-data:phone-number")).toBe(false);
    expect(params.has("customer-data:phone-number-prefix")).toBe(false);
  });

  it("maps every identity document type, PPT conservatively to OTHER", () => {
    expect(WOMPI_LEGAL_ID_TYPE).toEqual({
      CC: "CC",
      CE: "CE",
      NIT: "NIT",
      PP: "PP",
      TI: "TI",
      PPT: "OTHER",
    });
    const params = query(
      buildWompiCheckoutUrl(
        input({ customer: { ...input().customer, legalIdType: "PPT", legalId: "ABC123" } }),
      ),
    );
    expect(params.get("customer-data:legal-id-type")).toBe("OTHER");
  });

  it("sends the shipping snapshot, skipping absent optional lines", () => {
    const full = query(buildWompiCheckoutUrl(input()));
    expect(full.get("shipping-address:address-line-1")).toBe("Calle 10 # 43-21");
    expect(full.get("shipping-address:address-line-2")).toBe("Apto 501");
    expect(full.get("shipping-address:country")).toBe("CO");
    expect(full.get("shipping-address:city")).toBe("Medellín");
    expect(full.get("shipping-address:region")).toBe("Antioquia");
    expect(full.get("shipping-address:name")).toBe("Ana García");
    expect(full.get("shipping-address:phone-number")).toBe("3001234567");
    expect(full.get("shipping-address:postal-code")).toBe("050021");

    const shipping = input().shipping;
    if (shipping === null) throw new Error("fixture");
    const sparse = query(
      buildWompiCheckoutUrl(
        input({ shipping: { ...shipping, addressLine2: null, postalCode: null } }),
      ),
    );
    expect(sparse.has("shipping-address:address-line-2")).toBe(false);
    expect(sparse.has("shipping-address:postal-code")).toBe(false);

    const none = query(buildWompiCheckoutUrl(input({ shipping: null })));
    expect([...none.keys()].some((key) => key.startsWith("shipping-address:"))).toBe(false);
  });
});

describe("CHECKOUT_EXPIRY_MS", () => {
  it("expires the link before the 30-minute stock reservation does", () => {
    expect(CHECKOUT_EXPIRY_MS).toBeLessThan(30 * 60 * 1000);
    expect(CHECKOUT_EXPIRY_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });
});
