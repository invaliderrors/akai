import { describe, expect, it } from "vitest";

import {
  REVALIDATE_SIGNATURE_HEADER,
  REVALIDATE_TAG_PRODUCTS,
  affiliateApplicationSchema,
  affiliateApplicationResponseSchema,
  contactRequestSchema,
  contactResponseSchema,
  partnerLinkVisitResponseSchema,
  revalidateRequestSchema,
  siteSettingsSchema,
} from "./support";

describe("contactRequestSchema", () => {
  const submission = {
    name: "Ana García",
    email: "Ana@Example.COM",
    message: "Do you ship to the Canary Islands?",
  };

  it("lower-cases the email at the boundary, like every other email in the platform", () => {
    expect(contactRequestSchema.parse(submission).email).toBe("ana@example.com");
  });

  it("defaults the locale to Spanish and the captcha token to null", () => {
    const parsed = contactRequestSchema.parse(submission);

    expect(parsed.locale).toBe("es");
    expect(parsed.turnstileToken).toBeNull();
  });

  it("is strict — an unknown key is rejected, not silently dropped", () => {
    const result = contactRequestSchema.safeParse({ ...submission, role: "ADMIN" });

    expect(result.success).toBe(false);
  });

  it("trims and then rejects a whitespace-only message", () => {
    expect(
      contactRequestSchema.safeParse({ ...submission, message: "   " }).success,
    ).toBe(false);
  });

  it("rejects a message beyond the 5000-character ceiling", () => {
    const result = contactRequestSchema.safeParse({
      ...submission,
      message: "x".repeat(5_001),
    });

    expect(result.success).toBe(false);
  });

  it("rejects a malformed email rather than accepting an undeliverable submission", () => {
    expect(
      contactRequestSchema.safeParse({ ...submission, email: "not-an-email" }).success,
    ).toBe(false);
  });
});

describe("contactResponseSchema", () => {
  it("only admits the accepted state", () => {
    expect(contactResponseSchema.parse({ sent: true })).toEqual({ sent: true });
    expect(contactResponseSchema.safeParse({ sent: false }).success).toBe(false);
  });
});

describe("affiliateApplicationSchema", () => {
  const application = {
    name: "Ana García",
    country: "ES",
    socialHandle: "@ana.recovers",
    email: "Ana@Example.COM",
  };

  it("lower-cases the email at the boundary, like every other email in the platform", () => {
    expect(affiliateApplicationSchema.parse(application).email).toBe("ana@example.com");
  });

  it("defaults the locale to Spanish and the captcha token to null, same as the contact form", () => {
    const parsed = affiliateApplicationSchema.parse(application);

    expect(parsed.locale).toBe("es");
    expect(parsed.turnstileToken).toBeNull();
  });

  it("is strict — an unknown key is rejected, not silently dropped", () => {
    expect(
      affiliateApplicationSchema.safeParse({ ...application, role: "ADMIN" }).success,
    ).toBe(false);
  });

  it("rejects a country that is not an uppercase ISO-3166-1 alpha-2 code", () => {
    expect(affiliateApplicationSchema.safeParse({ ...application, country: "es" }).success)
      .toBe(false);
    expect(affiliateApplicationSchema.safeParse({ ...application, country: "Spain" }).success)
      .toBe(false);
  });

  it("trims and then rejects a whitespace-only name or social handle", () => {
    expect(affiliateApplicationSchema.safeParse({ ...application, name: "   " }).success)
      .toBe(false);
    expect(
      affiliateApplicationSchema.safeParse({ ...application, socialHandle: "   " }).success,
    ).toBe(false);
  });

  it("rejects a malformed email rather than accepting an undeliverable submission", () => {
    expect(
      affiliateApplicationSchema.safeParse({ ...application, email: "not-an-email" }).success,
    ).toBe(false);
  });
});

describe("affiliateApplicationResponseSchema", () => {
  it("only admits the accepted state", () => {
    expect(affiliateApplicationResponseSchema.parse({ received: true })).toEqual({
      received: true,
    });
    expect(affiliateApplicationResponseSchema.safeParse({ received: false }).success).toBe(
      false,
    );
  });
});

describe("partnerLinkVisitResponseSchema", () => {
  it("accepts a live discount code", () => {
    expect(partnerLinkVisitResponseSchema.parse({ discountCode: "AMIGO10" })).toEqual({
      discountCode: "AMIGO10",
    });
  });

  it("accepts null — a click with nothing live to auto-apply is still a valid outcome", () => {
    expect(partnerLinkVisitResponseSchema.parse({ discountCode: null })).toEqual({
      discountCode: null,
    });
  });

  it("is strict — an unknown key is rejected, not silently dropped", () => {
    expect(
      partnerLinkVisitResponseSchema.safeParse({ discountCode: "AMIGO10", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("revalidateRequestSchema", () => {
  it("accepts a bounded list of tags", () => {
    expect(revalidateRequestSchema.parse({ tags: [REVALIDATE_TAG_PRODUCTS] })).toEqual({
      tags: ["products"],
    });
  });

  it("rejects an empty tag list — an unfocused purge is not a revalidation", () => {
    expect(revalidateRequestSchema.safeParse({ tags: [] }).success).toBe(false);
  });

  it("caps the batch so one call cannot purge an unbounded surface", () => {
    const tags = Array.from({ length: 51 }, (_unused, index) => `tag-${String(index)}`);

    expect(revalidateRequestSchema.safeParse({ tags }).success).toBe(false);
  });
});

describe("REVALIDATE_SIGNATURE_HEADER", () => {
  it("is lower-case, so header lookups match on both Node and the browser", () => {
    expect(REVALIDATE_SIGNATURE_HEADER).toBe(REVALIDATE_SIGNATURE_HEADER.toLowerCase());
  });
});

describe("siteSettingsSchema", () => {
  it("accepts exactly one boolean field", () => {
    expect(siteSettingsSchema.parse({ maintenanceMode: true })).toEqual({
      maintenanceMode: true,
    });
  });

  it("rejects a missing field rather than defaulting it — a caller must state the value it read", () => {
    expect(siteSettingsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unknown field, matching every other request schema in this platform", () => {
    expect(
      siteSettingsSchema.safeParse({ maintenanceMode: true, other: "x" }).success,
    ).toBe(false);
  });
});
