import { describe, expect, it } from "vitest";
import { emailTemplateKeySchema, type EmailTemplateKey } from "@akai/contracts";
import { toMinor } from "@akai/money";
import { escapeHtml, renderEmail, safeUrl } from "./email.renderer";
import {
  SUPPRESSION_EXEMPT_TEMPLATE_KEYS,
  parseTemplatePayload,
  type EmailPayloadFor,
} from "./email.templates";

function eur(amount: number): { amount: ReturnType<typeof toMinor>; currency: string } {
  return { amount: toMinor(amount), currency: "EUR" };
}

const LINES: EmailPayloadFor<"order-confirmation">["lines"] = [
  {
    name: "Oversized Tee",
    variantName: "300 g",
    quantity: 2,
    unitPrice: eur(2499),
    lineTotal: eur(4998),
  },
];

/**
 * One valid payload per template key, as a mapped type — so adding a template
 * without adding a fixture is a COMPILE error. A renderer test suite that
 * silently skips a new template is worse than none: it reports green while the
 * untested template is the one in production.
 */
const FIXTURES: { [K in EmailTemplateKey]: EmailPayloadFor<K> } = {
  "verify-email": {
    firstName: "Marta",
    verifyUrl: "https://akai.shop/verify?token=abc",
    expiresInHours: 24,
  },
  "reset-password": {
    firstName: "Marta",
    resetUrl: "https://akai.shop/reset?token=abc",
    expiresInMinutes: 30,
  },
  "login-code": {
    firstName: "Marta",
    code: "204815",
    expiresInMinutes: 10,
  },
  "order-confirmation": {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    placedAt: "2026-07-20T10:00:00.000Z",
    lines: LINES,
    subtotal: eur(4998),
    discountTotal: eur(0),
    shippingTotal: eur(495),
    taxTotal: eur(951),
    grandTotal: eur(5493),
    orderUrl: "https://akai.shop/orders/AK-2026-000123",
  },
  "payment-receipt": {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    invoiceNumber: "INV-2026-000045",
    paidAt: "2026-07-20T10:05:00.000Z",
    amountPaid: eur(5493),
    cardBrand: "visa",
    cardLast4: "4242",
    invoiceUrl: "https://akai.shop/invoices/INV-2026-000045",
  },
  "payment-failed": {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    reason: "Your card was declined",
    retryUrl: "https://akai.shop/orders/AK-2026-000123/pay",
  },
  "shipping-confirmation": {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    carrier: "SEUR",
    trackingNumber: "SE123456789ES",
    trackingUrl: "https://seur.com/track/SE123456789ES",
    shippedAt: "2026-07-21T09:00:00.000Z",
    orderUrl: "https://akai.shop/orders/AK-2026-000123",
    lines: LINES,
  },
  "delivery-confirmation": {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    deliveredAt: "2026-07-22T14:00:00.000Z",
    orderUrl: "https://akai.shop/orders/AK-2026-000123",
  },
  "refund-confirmation": {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    refundAmount: eur(2499),
    reason: "Withdrawal right exercised",
    refundedAt: "2026-07-25T11:00:00.000Z",
    isPartial: true,
  },
  "order-cancelled": {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    reason: "Out of stock",
    cancelledAt: "2026-07-20T12:00:00.000Z",
  },
  "admin-new-order": {
    orderNumber: "AK-2026-000123",
    customerEmail: "marta@example.com",
    itemCount: 2,
    grandTotal: eur(5493),
    placedAt: "2026-07-20T10:00:00.000Z",
    adminUrl: "https://dashboard.akai.shop/admin/orders/AK-2026-000123",
  },
  "contact-autoreply": {
    name: "Marta",
    subject: "Question about sizing",
    referenceId: "CT-000045",
  },
  "contact-received": {
    referenceId: "CT-000045",
    name: "Marta",
    replyTo: "marta@example.com",
    subject: "Question about sizing",
    message: "Which lot is currently shipping for AK-CRE-300?",
    submittedAt: "2026-07-20T10:00:00.000Z",
  },
  "affiliate-application-autoreply": {
    name: "Marta",
    referenceId: "AF-000012",
  },
  "affiliate-application-received": {
    referenceId: "AF-000012",
    name: "Marta",
    replyTo: "marta@example.com",
    country: "ES",
    socialHandle: "@marta.recovers",
    submittedAt: "2026-07-20T10:00:00.000Z",
  },
};

const ALL_KEYS: readonly EmailTemplateKey[] = emailTemplateKeySchema.options;

describe("renderEmail — coverage", () => {
  it("renders every template with a non-empty subject and body", () => {
    for (const key of ALL_KEYS) {
      // Re-parse the fixture so the test also proves each fixture is a VALID
      // payload, not merely one that happens to typecheck.
      const payload = parseTemplatePayload(key, FIXTURES[key]);
      const rendered = renderEmail(key, payload);

      expect(rendered.subject.length, `${key} subject`).toBeGreaterThan(0);
      expect(rendered.html, `${key} html`).toContain("<html");
      expect(rendered.text.length, `${key} text`).toBeGreaterThan(0);
      expect(rendered.html).not.toContain("undefined");
      expect(rendered.text).not.toContain("undefined");
    }
  });

  it("writes the customer-facing copy in Spanish", () => {
    const subject = (key: EmailTemplateKey): string =>
      renderEmail(key, parseTemplatePayload(key, FIXTURES[key])).subject;

    expect(subject("verify-email")).toBe("Confirma tu correo electrónico");
    expect(subject("reset-password")).toBe("Restablecer tu contraseña");
    expect(subject("order-confirmation")).toContain("Pedido confirmado");
    expect(subject("shipping-confirmation")).toContain("está en camino");
    expect(subject("order-cancelled")).toContain("cancelado");
  });

  it("opens and closes every mail with the brand wordmark, in both HTML and text", () => {
    for (const key of ALL_KEYS) {
      const payload = parseTemplatePayload(key, FIXTURES[key]);
      const rendered = renderEmail(key, payload);
      expect(rendered.html, `${key} html`).toContain("AKAI");
      expect(rendered.text, `${key} text`).toContain("AKAI");
    }
  });

  it("uses no background color anywhere — the literal ask behind this redesign", () => {
    // The CTA button's solid accent fill is the one deliberate exception —
    // see the doc comment on the `button` case in blockToHtml for why a
    // button that doesn't look pressable isn't a button. Guarded separately
    // below by asserting the accent background appears exactly once per
    // render (the button, and nothing else).
    for (const key of ALL_KEYS) {
      const payload = parseTemplatePayload(key, FIXTURES[key]);
      const html = renderEmail(key, payload).html;
      const backgroundDeclarations = html.match(/background(-color)?\s*:/g) ?? [];
      const accentFills = html.match(/background:#2b2fd9/g) ?? [];
      expect(backgroundDeclarations.length, `${key} background declarations`).toBe(
        accentFills.length,
      );
    }
  });

  it("declares the store locale on <html>", () => {
    const payload = parseTemplatePayload("verify-email", FIXTURES["verify-email"]);
    expect(renderEmail("verify-email", payload).html).toContain('lang="es-CO"');
  });
});

describe("renderEmail — money", () => {
  it("formats money in es-CO from integer minor units", () => {
    const payload = parseTemplatePayload(
      "order-confirmation",
      FIXTURES["order-confirmation"],
    );

    const text = renderEmail("order-confirmation", payload).text;

    // 5493 minor units, never 54.93 floats, and a decimal COMMA.
    expect(text).toContain("54,93");
    expect(text).not.toContain("5493");
  });

  it("never renders a raw minor-unit integer to the customer", () => {
    const payload = parseTemplatePayload(
      "payment-receipt",
      FIXTURES["payment-receipt"],
    );
    const text = renderEmail("payment-receipt", payload).text;

    expect(text).toContain("54,93");
    expect(text).not.toMatch(/\b5493\b/);
  });
});

describe("renderEmail — dates", () => {
  it("prints dates in Spanish, in Colombian time", () => {
    // 03:00 UTC on the 21st is still the evening of the 20th in Bogotá
    // (UTC-5); a UTC-pinned formatter would print the wrong day.
    const payload = parseTemplatePayload("order-confirmation", {
      ...FIXTURES["order-confirmation"],
      placedAt: "2026-07-21T03:00:00.000Z",
    });

    const text = renderEmail("order-confirmation", payload).text;

    expect(text).toContain("20 de julio de 2026");
  });
});

describe("renderEmail — escaping is structural", () => {
  it("escapes customer-controlled text instead of emitting markup", () => {
    const payload = parseTemplatePayload("order-confirmation", {
      ...FIXTURES["order-confirmation"],
      firstName: '<script>alert("xss")</script>',
    });

    const html = renderEmail("order-confirmation", payload).html;

    // The attack string must survive as TEXT, never as an element.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a product name coming from the catalog", () => {
    const payload = parseTemplatePayload("order-confirmation", {
      ...FIXTURES["order-confirmation"],
      lines: [
        {
          name: '"><img src=x onerror=alert(1)>',
          quantity: 1,
          unitPrice: eur(100),
          lineTotal: eur(100),
        },
      ],
    });

    const html = renderEmail("order-confirmation", payload).html;

    // The property is "no ELEMENT and no ATTRIBUTE was created", not "the
    // string onerror= is absent". `onerror=` surviving as escaped body text is
    // inert — asserting on the substring alone would be a test that fails for
    // the wrong reason and passes for the wrong reason.
    expect(html).not.toContain("<img");
    expect(html).not.toContain('"><img');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // The closing quote of the preceding attribute cannot be reached.
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("escapes quotes so an attribute cannot be broken out of", () => {
    expect(escapeHtml('" onmouseover="steal()')).not.toContain('"');
    expect(escapeHtml("'")).toBe("&#39;");
    expect(escapeHtml("&")).toBe("&amp;");
  });

  it("escapes the ampersand FIRST, so escapes are not double-encoded wrongly", () => {
    // A naive ordering turns "<" into "&lt;" and then the "&" into "&amp;lt;".
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("safeUrl", () => {
  it("neutralises non-http(s) schemes", () => {
    // z.string().url() is backed by new URL(), which ACCEPTS these. The
    // renderer is the second line of defence, and this is what it defends.
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("#");
    expect(safeUrl("file:///etc/passwd")).toBe("#");
    expect(safeUrl("not a url at all")).toBe("#");
  });

  it("passes http and https through unchanged", () => {
    expect(safeUrl("https://akai.shop/orders/1")).toBe("https://akai.shop/orders/1");
    expect(safeUrl("http://localhost:3000/verify")).toBe("http://localhost:3000/verify");
  });
});

describe("renderEmail — shipping without tracking", () => {
  /**
   * A parcel can genuinely ship untracked, and `shipment.trackingNumber` is
   * nullable precisely because of that. A REQUIRED trackingUrl would fail the
   * payload schema, and a payload that fails its schema DEAD-LETTERS — so the
   * customer would hear nothing at all about the exact shipments that are
   * hardest to chase. Optional tracking plus a mandatory order link means the
   * mail always sends and always has one working button.
   */
  const untracked: EmailPayloadFor<"shipping-confirmation"> = {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    carrier: "Correos",
    shippedAt: "2026-07-21T09:00:00.000Z",
    orderUrl: "https://akai.shop/orders/AK-2026-000123",
    lines: LINES,
  };

  it("renders with no tracking number and no tracking url", () => {
    const payload = parseTemplatePayload("shipping-confirmation", untracked);
    const rendered = renderEmail("shipping-confirmation", payload);

    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.text).not.toContain("undefined");
    expect(rendered.html).not.toContain("undefined");
    // The button falls back to the order page rather than vanishing.
    expect(rendered.text).toContain("https://akai.shop/orders/AK-2026-000123");
    expect(rendered.text).toContain("Correos");
  });

  it("still shows the tracking number when there is one", () => {
    const payload = parseTemplatePayload(
      "shipping-confirmation",
      FIXTURES["shipping-confirmation"],
    );
    const text = renderEmail("shipping-confirmation", payload).text;
    expect(text).toContain("SE123456789ES");
    expect(text).toContain("https://seur.com/track/SE123456789ES");
  });
});

describe("renderEmail — login-code", () => {
  it("renders the code itself", () => {
    const payload = parseTemplatePayload("login-code", FIXTURES["login-code"]);
    const rendered = renderEmail("login-code", payload);
    expect(rendered.text).toContain("204815");
    expect(rendered.html).toContain("204815");
    expect(rendered.text).toContain("10");
  });

  it("carries NO link a phisher could repoint and no session material", () => {
    // A sign-in mail is the single most phished message a store sends. This one
    // deliberately has no button: the code is typed into the tab the customer
    // already has open, so there is nothing in the mail to click.
    const payload = parseTemplatePayload("login-code", FIXTURES["login-code"]);
    const html = renderEmail("login-code", payload).html;
    expect(html).not.toContain("<a href");
  });

  it("is exempt from suppression, because a code is the only way back in", () => {
    // `passwordHash` is nullable: code-only accounts are real, and a six-month
    // old bounce entry must not lock one of them out permanently.
    expect(SUPPRESSION_EXEMPT_TEMPLATE_KEYS.has("login-code")).toBe(true);
  });
});
