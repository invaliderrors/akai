import { createProductSchema } from "@akai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CONTENT_SANITIZED_HEADER } from "./catalog-headers";
import type { AdminHttpRequest, AdminHttpResponse } from "./http";
import { translateCopyReasonOf } from "./translate-copy";

/**
 * The translation server action, exercised through a fake transport.
 *
 * WHY THE MOCKS ARE WHERE THEY ARE. `actions.ts` is `"use server"`, so it is
 * reached in production as an HTTP endpoint and reaches the API through the
 * sealed session. Standing that up in a unit test would test Next, not this
 * action — so the two seams either side of it are replaced (the session-bound
 * client, and `revalidatePath`, which needs a request scope) and everything in
 * between is the real code, including both zod parses.
 *
 * WHAT IS WORTH ASSERTING HERE, given the API validates again: the requests
 * this action DOES NOT make. A metered vendor is charged per call, so "there
 * was nothing to translate" and "the caller asked for es → es" have to be
 * answered without a round trip, and that is invisible in the response.
 */

const calls: AdminHttpRequest[] = [];
let respond: (input: AdminHttpRequest) => AdminHttpResponse = () => ({
  status: 200,
  body: { translations: [] },
});

/** A minimal, genuinely valid session — the shape `adminHttp()`'s retry logic reads. */
function fakeSession(overrides: Partial<{ refreshToken: string }> = {}) {
  return {
    accessToken: "access-1",
    accessTokenExpiresAt: "2026-07-20T10:15:00.000Z",
    refreshToken: overrides.refreshToken ?? "refresh-1",
    refreshTokenExpiresAt: "2026-08-19T10:00:00.000Z",
    sessionId: "sess-1",
    customerId: "cus-1",
    email: "admin@akai.test",
    role: "ADMIN",
    emailVerified: true,
    twoFactorEnabled: true,
  };
}

let session: ReturnType<typeof fakeSession> | null = fakeSession();
const writeSession = vi.fn<(payload: unknown) => Promise<void>>(async () => undefined);
const clearSession = vi.fn<() => Promise<void>>(async () => undefined);
const refresh = vi.fn<(context: unknown, refreshToken: string) => Promise<unknown>>();

const revalidatePath = vi.fn<(path: string) => void>();

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("../api/client", () => ({
  apiBaseUrl: () => "http://api.test",
  createApiClient: () => ({}),
}));
vi.mock("../session/server", () => ({
  getSession: async () => session,
  writeSession: (payload: unknown) => writeSession(payload),
  clearSession: () => clearSession(),
}));
vi.mock("../api/auth", () => ({
  refresh: (context: unknown, refreshToken: string) => refresh(context, refreshToken),
}));
vi.mock("./http-adapter", () => ({
  createAdminHttp: () => ({
    async request(input: AdminHttpRequest): Promise<AdminHttpResponse> {
      calls.push(input);
      return respond(input);
    },
  }),
}));

const {
  activatePartnerLoginAction,
  addVariantAction,
  adjustInventoryAction,
  createAffiliateAction,
  createAffiliateLinkAction,
  createCategoryAction,
  createProductAction,
  deleteAffiliateAction,
  deleteAffiliateLinkAction,
  deleteCategoryAction,
  deleteProductAction,
  reorderCategoriesAction,
  reorderProductsAction,
  setVariantInventoryPolicyAction,
  translateProductCopyAction,
  updateAffiliateAction,
  updateCategoryAction,
  updateProductAction,
  updateSiteSettingsAction,
  updateVariantAction,
} = await import("./actions");

const ISO = "2026-07-20T10:00:00.000Z";

/** The platform's error envelope, as the API would actually send it. */
function envelope(code: string, reason: string, status: number): AdminHttpResponse {
  return {
    status,
    body: {
      error: {
        code,
        reason,
        // Server-authored English. Nothing in this bundle may render it.
        message: "DeepL rejected the request: quota exceeded for this billing period.",
        requestId: "req_translate_1",
        timestamp: ISO,
      },
    },
  };
}

/** A minimal, genuinely valid bare `ProductVariant`, as `addVariant`/`updateVariant` return it. */
function variantBody() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    productId: "22222222-2222-4222-8222-222222222222",
    sku: "AK-BPC-10",
    name: null,
    options: {},
    price: {
      currency: "EUR",
      net: 4132,
      tax: 867,
      gross: 4999,
      compareAtGross: null,
      taxRateBps: 2100,
    },
    weightGrams: null,
    inventory: {
      variantId: "11111111-1111-4111-8111-111111111111",
      onHand: 0,
      reserved: 0,
      available: 0,
      lowStockThreshold: 5,
      allowBackorder: false,
    },
    batch: null,
    image: null,
    isActive: true,
    version: 0,
  };
}

/** A minimal, genuinely valid product resource, as the API would return it. */
function productBody() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "bpc-157",
    status: "ACTIVE",
    taxClass: "STANDARD",
    translations: [
      { locale: "es", name: "BPC-157", shortDescription: "Péptido", description: "" },
    ],
    variants: [variantBody()],
    media: [],
    categories: [],
    restrictedCountries: [],
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };
}

/** A minimal, genuinely valid create/update input — only the header handling is under test. */
function productInput() {
  return createProductSchema.parse({
    slug: "bpc-157",
    translations: [{ locale: "es", name: "BPC-157", shortDescription: "Péptido", description: "" }],
    variants: [{ sku: "AK-BPC-10", priceGross: 4999, currency: "EUR" }],
  });
}

beforeEach(() => {
  // Braced. An arrow body returning `calls.length = 0` would hand Vitest a
  // number, but the habit is what matters: a hook that RETURNS a function is
  // registered as a teardown. See the note in product-form.test.tsx.
  calls.length = 0;
  respond = () => ({ status: 200, body: { translations: [] } });
  session = fakeSession();
  writeSession.mockReset();
  clearSession.mockReset();
  refresh.mockReset();
  revalidatePath.mockReset();
});

describe("translateProductCopyAction", () => {
  it("translates the fields that have text and returns the rest blank", async () => {
    respond = () => ({
      status: 200,
      body: {
        translations: [
          { key: "name", text: "BPC-157" },
          { key: "shortDescription", text: "Peptide" },
        ],
      },
    });

    const result = await translateProductCopyAction({
      from: "es",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "Péptido", description: "" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      name: "BPC-157",
      shortDescription: "Peptide",
      // Not sent, so not translated, so blank — never the Spanish source text.
      description: "",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/translations");
    expect(calls[0]?.body).toEqual({
      source: "es",
      target: "en",
      texts: [
        { key: "name", text: "BPC-157" },
        { key: "shortDescription", text: "Péptido" },
      ],
    });
  });

  it("answers an empty source without spending a request", async () => {
    const result = await translateProductCopyAction({
      from: "es",
      to: "en",
      copy: { name: "", shortDescription: "   ", description: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(translateCopyReasonOf(result.reason)).toBe("EMPTY_SOURCE");
    expect(calls).toHaveLength(0);
  });

  it("refuses a same-locale request without spending a request", async () => {
    const result = await translateProductCopyAction({
      from: "en",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "", description: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION_FAILED");
    expect(calls).toHaveLength(0);
  });

  it("refuses a body carrying a field nobody declared", async () => {
    const result = await translateProductCopyAction({
      from: "es",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "", description: "" },
      saveImmediately: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION_FAILED");
    expect(calls).toHaveLength(0);
  });

  it("carries the envelope's reason out, and leaves the vendor's prose behind", async () => {
    respond = () => envelope("CONFLICT", "QUOTA_EXCEEDED", 409);

    const result = await translateProductCopyAction({
      from: "es",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "", description: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The coarse code cannot separate "no key" from "quota gone" from "vendor
    // down" — all three are CONFLICT. The reason is what the operator's sentence
    // is chosen by.
    expect(result.code).toBe("CONFLICT");
    expect(translateCopyReasonOf(result.reason)).toBe("QUOTA_EXCEEDED");
  });

  it("keeps a reason it does not recognise off the operator's screen", async () => {
    respond = () => envelope("CONFLICT", "VENDOR_ON_FIRE", 409);

    const result = await translateProductCopyAction({
      from: "es",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "", description: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `null` sends the caller to the coarse code's sentence, which is exactly
    // what a dashboard older than its API should do.
    expect(translateCopyReasonOf(result.reason)).toBeNull();
  });

  it("does not degrade an unreadable response into empty copy", async () => {
    // A 200 whose body is not the contract's shape. Writing blanks over the
    // other locale's copy would be the destructive answer.
    respond = () => ({ status: 200, body: { translated: "yes" } });

    const result = await translateProductCopyAction({
      from: "es",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "", description: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNPARSEABLE_RESPONSE");
  });
});

/**
 * `createProductAction`/`updateProductAction` — propagating the sanitisation
 * warning out of `api.ts` and into what the form actually reads.
 */
describe("adjustInventoryAction", () => {
  const VARIANT = "11111111-1111-4111-8111-111111111111";

  it("forwards the expected on-hand count with the delta", async () => {
    respond = () => ({ status: 200, body: {} });

    const result = await adjustInventoryAction(VARIANT, {
      delta: 8,
      reason: "STOCK_COUNT",
      expectedOnHand: 29,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/admin/products/variants/${VARIANT}/inventory/adjust`);
    expect(calls[0]?.body).toEqual({ delta: 8, reason: "STOCK_COUNT", expectedOnHand: 29 });
  });

  it("revalidates the inventory list as well as the products it came from", async () => {
    // The inventory page now carries its own Adjust action, so a list that is
    // not revalidated would redraw the old count straight after a successful
    // write — and the next adjust from it would be refused as STOCK_CHANGED.
    respond = () => ({ status: 200, body: {} });

    await adjustInventoryAction(VARIANT, { delta: 8, reason: "STOCK_COUNT" });

    const paths = revalidatePath.mock.calls.map(([path]) => path);
    expect(paths).toContain("/admin/inventory");
    expect(paths).toContain("/admin/products");
  });

  it("carries the domain reason out of a refused adjustment", async () => {
    respond = () => envelope("CONFLICT", "STOCK_CHANGED", 409);

    const result = await adjustInventoryAction(VARIANT, {
      delta: 8,
      reason: "STOCK_COUNT",
      expectedOnHand: 29,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CONFLICT");
    expect(result.reason).toBe("STOCK_CHANGED");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a negative expectedOnHand before making a request", async () => {
    const result = await adjustInventoryAction(VARIANT, {
      delta: 8,
      reason: "STOCK_COUNT",
      expectedOnHand: -1,
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("createProductAction", () => {
  it("reports no sanitized locale on an ordinary save", async () => {
    respond = () => ({ status: 201, body: productBody() });

    const result = await createProductAction(productInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sanitizedLocales).toEqual([]);
  });

  it("surfaces the locales the API's sanitiser rewrote", async () => {
    respond = () => ({
      status: 201,
      body: productBody(),
      headers: { [CONTENT_SANITIZED_HEADER]: "es" },
    });

    const result = await createProductAction(productInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sanitizedLocales).toEqual(["es"]);
  });
});

describe("updateProductAction", () => {
  it("surfaces the locales the API's sanitiser rewrote on an update too", async () => {
    respond = () => ({
      status: 200,
      body: productBody(),
      headers: { [CONTENT_SANITIZED_HEADER]: "es,en" },
    });

    const result = await updateProductAction(productBody().id, productInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sanitizedLocales).toEqual(["es", "en"]);
  });
});

describe("reorderProductsAction", () => {
  it("PUTs the whole order and reports the count back", async () => {
    respond = () => ({ status: 200, body: { reordered: 3 } });

    const result = await reorderProductsAction(["p-3", "p-1", "p-2"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ reordered: 3 });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.path).toBe("/admin/products/reorder");
    expect(calls[0]?.body).toEqual({ productIds: ["p-3", "p-1", "p-2"] });
  });
});

describe("createCategoryAction", () => {
  it("POSTs the slug and both locale names, and reports the created category", async () => {
    respond = () => ({
      status: 201,
      body: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "peptidos",
        name: { es: "Péptidos", en: "Peptides" },
        sortOrder: 4,
      },
    });

    const result = await createCategoryAction({
      slug: "peptidos",
      name: { es: "Péptidos", en: "Peptides" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.slug).toBe("peptidos");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/categories");
  });
});

describe("updateCategoryAction", () => {
  it("PATCHes the named category with the new name", async () => {
    respond = () => ({
      status: 200,
      body: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "recuperacion",
        name: { es: "Recuperación total", en: "Full recovery" },
        sortOrder: 0,
      },
    });

    const result = await updateCategoryAction("11111111-1111-4111-8111-111111111111", {
      name: { es: "Recuperación total", en: "Full recovery" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toEqual({ es: "Recuperación total", en: "Full recovery" });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/admin/categories/11111111-1111-4111-8111-111111111111");
  });
});

describe("reorderCategoriesAction", () => {
  it("PUTs the whole order and reports the count back", async () => {
    respond = () => ({ status: 200, body: { reordered: 2 } });

    const result = await reorderCategoriesAction(["c-2", "c-1"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ reordered: 2 });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.path).toBe("/admin/categories/reorder");
    expect(calls[0]?.body).toEqual({ categoryIds: ["c-2", "c-1"] });
  });
});

describe("deleteCategoryAction", () => {
  it("DELETEs the named category", async () => {
    respond = () => ({ status: 204, body: null });

    const result = await deleteCategoryAction("11111111-1111-4111-8111-111111111111");

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/admin/categories/11111111-1111-4111-8111-111111111111");
  });

  it("surfaces a still-assigned conflict rather than pretending the delete happened", async () => {
    respond = () => envelope("CONFLICT", "CATEGORY_STILL_ASSIGNED", 409);

    const result = await deleteCategoryAction("11111111-1111-4111-8111-111111111111");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CONFLICT");
  });
});

describe("updateSiteSettingsAction", () => {
  it("PATCHes the admin endpoint and reports the saved value back", async () => {
    respond = () => ({ status: 200, body: { maintenanceMode: true } });

    const result = await updateSiteSettingsAction({ maintenanceMode: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ maintenanceMode: true });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/admin/site-settings");
    expect(calls[0]?.body).toEqual({ maintenanceMode: true });
  });

  it("surfaces a failure rather than pretending the toggle saved", async () => {
    respond = () => envelope("FORBIDDEN", "NOT_ADMIN", 403);

    const result = await updateSiteSettingsAction({ maintenanceMode: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FORBIDDEN");
  });
});

const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";

/** A minimal, genuinely valid affiliate row, as the API would send it back. */
function affiliateBody(overrides: Record<string, unknown> = {}) {
  return {
    id: AFFILIATE_ID,
    name: "Ana",
    country: "ES",
    socialHandle: "@ana",
    email: "ana@example.com",
    discountCodes: [],
    redemptionCount: 0,
    revenueMinor: 0,
    hasLogin: false,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    ...overrides,
  };
}

describe("createAffiliateAction", () => {
  it("POSTs and reports the id back", async () => {
    respond = () => ({ status: 201, body: affiliateBody() });

    const result = await createAffiliateAction({
      name: "Ana",
      country: "ES",
      socialHandle: "@ana",
      email: "ana@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ id: AFFILIATE_ID });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/affiliates");
  });

  it("rejects a malformed input before ever making a request", async () => {
    const result = await createAffiliateAction({
      name: "Ana",
      country: "ES",
      socialHandle: "@ana",
      email: "not-an-email",
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("updateAffiliateAction", () => {
  it("PATCHes the affiliate route and reports the id back", async () => {
    respond = () => ({ status: 200, body: affiliateBody({ name: "Ana María" }) });

    const result = await updateAffiliateAction(AFFILIATE_ID, { name: "Ana María" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ id: AFFILIATE_ID });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}`);
  });
});

describe("deleteAffiliateAction", () => {
  it("DELETEs the affiliate route", async () => {
    respond = () => ({ status: 204, body: null });

    const result = await deleteAffiliateAction(AFFILIATE_ID);

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}`);
  });

  it("surfaces a forbidden rather than pretending the archive happened", async () => {
    respond = () => envelope("FORBIDDEN", "NOT_ADMIN", 403);

    const result = await deleteAffiliateAction(AFFILIATE_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FORBIDDEN");
  });
});

describe("activatePartnerLoginAction", () => {
  it("POSTs the activate-login route and reports the status back", async () => {
    respond = () => ({ status: 201, body: { active: true, email: "ana@example.com" } });

    const result = await activatePartnerLoginAction(AFFILIATE_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ active: true, email: "ana@example.com" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}/activate-login`);
  });

  it("surfaces a conflict rather than pretending the login activated", async () => {
    respond = () => envelope("CONFLICT", "EMAIL_TAKEN", 409);

    const result = await activatePartnerLoginAction(AFFILIATE_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CONFLICT");
  });
});

const LINK_ID = "77777777-7777-4777-8777-777777777777";

describe("createAffiliateLinkAction", () => {
  it("POSTs the affiliate-scoped links route and reports the link back", async () => {
    respond = () => ({
      status: 201,
      body: {
        id: LINK_ID,
        affiliateId: AFFILIATE_ID,
        slug: "ana-recovers",
        clickCount: 0,
        createdAt: ISO,
        deletedAt: null,
      },
    });

    const result = await createAffiliateLinkAction(AFFILIATE_ID, { slug: "ana-recovers" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.slug).toBe("ana-recovers");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}/links`);
    expect(calls[0]?.body).toEqual({ slug: "ana-recovers" });
  });

  it("rejects a malformed slug before ever making a request", async () => {
    const result = await createAffiliateLinkAction(AFFILIATE_ID, { slug: "Not A Slug!" });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a conflict for a reserved or duplicate slug", async () => {
    respond = () => envelope("CONFLICT", "RESERVED_SLUG", 409);

    const result = await createAffiliateLinkAction(AFFILIATE_ID, { slug: "checkout" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CONFLICT");
  });
});

describe("deleteAffiliateLinkAction", () => {
  it("DELETEs the affiliate-scoped link route", async () => {
    respond = () => ({ status: 204, body: null });

    const result = await deleteAffiliateLinkAction(AFFILIATE_ID, LINK_ID);

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}/links/${LINK_ID}`);
  });

  it("surfaces a not-found rather than pretending the delete happened", async () => {
    respond = () => envelope("NOT_FOUND", "LINK_NOT_FOUND", 404);

    const result = await deleteAffiliateLinkAction(AFFILIATE_ID, LINK_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_FOUND");
  });
});

/**
 * The three variant-write actions behind the product-edit save path. Each is
 * parsed from `unknown` internally — a server action is a public endpoint
 * with a generated name — so the input here is a plain object, not something
 * pre-validated by a schema the test imports.
 */
describe("addVariantAction", () => {
  it("creates the variant and hands back the id/sku pair for photo matching", async () => {
    respond = () => ({ status: 201, body: variantBody() });

    const result = await addVariantAction("22222222-2222-4222-8222-222222222222", {
      sku: "AK-BPC-10",
      priceGross: 4999,
      currency: "EUR",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ id: variantBody().id, sku: "AK-BPC-10" });
    expect(calls[0]?.path).toBe(
      "/admin/products/22222222-2222-4222-8222-222222222222/variants",
    );
  });

  it("rejects a malformed input before ever making a request", async () => {
    const result = await addVariantAction("22222222-2222-4222-8222-222222222222", {
      sku: "",
      priceGross: 4999,
      currency: "EUR",
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("updateVariantAction", () => {
  it("sends the patch and reports success without leaking the variant back", async () => {
    respond = () => ({ status: 200, body: variantBody() });

    const result = await updateVariantAction(variantBody().id, {
      version: 0,
      priceGross: 5999,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
    expect(calls[0]?.path).toBe(
      `/admin/products/variants/${variantBody().id}`,
    );
  });

  it("surfaces a stale version as CONFLICT rather than a generic failure", async () => {
    respond = () => envelope("CONFLICT", "STALE_VERSION", 409);

    const result = await updateVariantAction(variantBody().id, {
      version: 0,
      priceGross: 5999,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CONFLICT");
  });
});

describe("setVariantInventoryPolicyAction", () => {
  it("PUTs the policy and reports success", async () => {
    respond = () => ({
      status: 200,
      body: {
        variantId: variantBody().id,
        onHand: 12,
        reserved: 2,
        available: 10,
        lowStockThreshold: 10,
        allowBackorder: true,
      },
    });

    const result = await setVariantInventoryPolicyAction(variantBody().id, {
      lowStockThreshold: 10,
      allowBackorder: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
    expect(calls[0]?.path).toBe(
      `/admin/products/variants/${variantBody().id}/inventory/policy`,
    );
  });
});

/**
 * §3's fix: `adminHttp()`'s own retry-on-401, shared by every action above.
 * Exercised through `deleteProductAction` — a plain vehicle with nothing else
 * to configure — but this is testing `adminHttp()` itself, not that action.
 */
describe("adminHttp — retry-on-401", () => {
  it("retries the exact same request once after a transparent refresh, and the caller sees success", async () => {
    let attempt = 0;
    respond = () => {
      attempt += 1;
      return attempt === 1
        ? { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Expired", requestId: "r1", timestamp: ISO } } }
        : { status: 200, body: null };
    };
    refresh.mockResolvedValue({
      ok: true,
      data: {
        tokens: {
          accessToken: "access-2",
          accessTokenExpiresAt: "2026-07-20T10:30:00.000Z",
          refreshToken: "refresh-2",
          refreshTokenExpiresAt: "2026-08-19T10:00:00.000Z",
          sessionId: "sess-1",
        },
      },
    });

    const result = await deleteProductAction("22222222-2222-4222-8222-222222222222");

    expect(result.ok).toBe(true);
    // Exactly two requests reached the transport: the one that 401ed, and the
    // one retry — both to the SAME path.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe(calls[1]?.path);
    expect(refresh).toHaveBeenCalledWith(expect.anything(), "refresh-1");
    // The rotated pair was persisted — a second action in the same session
    // must not have to repeat this refresh.
    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "access-2", refreshToken: "refresh-2" }),
    );
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("gives up after one retry and surfaces the original 401 when refresh itself fails", async () => {
    respond = () => ({
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "Expired", requestId: "r1", timestamp: ISO } },
    });
    refresh.mockResolvedValue({
      ok: false,
      code: "UNAUTHENTICATED",
      reason: null,
      message: "Refresh token expired",
    });

    const result = await deleteProductAction("22222222-2222-4222-8222-222222222222");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNAUTHENTICATED");
    // No retry attempted: refreshing failed, so a second request would only
    // 401 again — one wasted round trip for no benefit.
    expect(calls).toHaveLength(1);
    // The dead cookie is cleared so the NEXT navigation does not bounce
    // sign-in → page → sign-in forever.
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("never calls refresh at all when the request already succeeded", async () => {
    // The overwhelmingly common case, pinned so the retry machinery costs
    // nothing when there is nothing to retry.
    respond = () => ({ status: 200, body: null });

    const result = await deleteProductAction("22222222-2222-4222-8222-222222222222");

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not attempt a refresh at all with no session — there is no refresh token to spend", async () => {
    session = null;
    respond = () => ({
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "Expired", requestId: "r1", timestamp: ISO } },
    });

    const result = await deleteProductAction("22222222-2222-4222-8222-222222222222");

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
