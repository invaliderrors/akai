import { createProductSchema } from "@akai/contracts";
import { toMinor } from "@akai/money";
import { describe, expect, it } from "vitest";
import { AdminApiError, type AdminHttp, type AdminHttpRequest, type AdminHttpResponse } from "./http";
import {
  activatePartnerLogin,
  addVariant,
  adjustInventory,
  createAffiliate,
  createAffiliateLink,
  createCategory,
  createDiscount,
  createProduct,
  deleteAffiliate,
  deleteAffiliateLink,
  deleteCategory,
  deleteDiscount,
  deleteProduct,
  getAffiliate,
  getDiscount,
  getOrder,
  getSiteSettings,
  listAffiliateLinks,
  listAffiliates,
  listCategories,
  listDiscounts,
  listProducts,
  reorderCategories,
  reorderProducts,
  requestRefund,
  setInventoryPolicy,
  transitionOrder,
  updateAffiliate,
  updateCategory,
  updateDiscount,
  updateProduct,
  updateSiteSettings,
  updateVariant,
} from "./api";
import {
  addVariantRequestSchema,
  createAffiliateLinkRequestSchema,
  createAffiliateRequestSchema,
  createDiscountRequestSchema,
  updateAffiliateRequestSchema,
  updateDiscountRequestSchema,
} from "./schemas";
import { CONTENT_SANITIZED_HEADER } from "./catalog-headers";

/** A minimal, genuinely valid create/update body — only the header handling is under test. */
function buildProductBody() {
  return createProductSchema.parse({
    slug: "hoodie-kumo",
    translations: [{ locale: "es", name: "Hoodie Kumo", shortDescription: "Sudadera", description: "" }],
    variants: [{ sku: "AK-HOOD-M", priceGross: 4999, currency: "EUR" }],
  });
}

/**
 * A recording fake. Deliberately hand-written rather than a mocking library:
 * the assertions below are mostly about the REQUEST the layer builds (path,
 * query, idempotency key), and a fake that records is easier to read than a
 * chain of `expect(vi.fn()).toHaveBeenCalledWith(...)`.
 */
function fakeHttp(
  responder: (input: AdminHttpRequest) => AdminHttpResponse,
): { http: AdminHttp; calls: AdminHttpRequest[] } {
  const calls: AdminHttpRequest[] = [];

  return {
    calls,
    http: {
      async request(input) {
        calls.push(input);
        return responder(input);
      },
    },
  };
}

function ok(body: unknown, headers?: Readonly<Record<string, string>>) {
  return () => ({ status: 200, body, ...(headers === undefined ? {} : { headers }) });
}

const ISO = "2026-07-20T10:00:00.000Z";

function buildVariant() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    productId: "22222222-2222-4222-8222-222222222222",
    sku: "AK-HOOD-M",
    name: { es: "M", en: "M" },
    options: { size: "10mg" },
    price: {
      currency: "EUR",
      net: 4132,
      tax: 867,
      gross: 4999,
      compareAtGross: null,
      taxRateBps: 2100,
    },
    weightGrams: 20,
    inventory: {
      variantId: "11111111-1111-4111-8111-111111111111",
      onHand: 12,
      reserved: 2,
      available: 10,
      lowStockThreshold: 5,
      allowBackorder: false,
    },
    image: null,
    isActive: true,
    version: 3,
  };
}

function buildProduct() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "hoodie-kumo",
    status: "ACTIVE",
    taxClass: "STANDARD",
    translations: [
      { locale: "es", name: "Hoodie Kumo", shortDescription: "Sudadera", description: "..." },
    ],
    variants: [buildVariant()],
    media: [],
    categories: [],
    restrictedCountries: [],
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };
}

describe("listProducts", () => {
  it("parses the paginated envelope and preserves branded money", () => {
    // The regression this pins: `z.ZodType<T>` (Input defaulting to Output)
    // silently infers from the input side for any schema with a .transform(),
    // which every money field has. The value below must arrive as an integer
    // number of minor units, not as a float and not re-derived.
    const { http } = fakeHttp(
      ok({ items: [buildProduct()], nextCursor: null, hasMore: false }),
    );

    return listProducts(http, {}).then((page) => {
      const product = page.items[0];
      expect(product).toBeDefined();
      const variant = product?.variants[0];
      expect(variant?.price.gross).toBe(4999);
      expect(variant?.price.net).toBe(4132);
      // net + tax === gross is a DB CHECK constraint; assert the wire agrees.
      expect((variant?.price.net ?? 0) + (variant?.price.tax ?? 0)).toBe(
        variant?.price.gross,
      );
    });
  });

  it("omits absent filters from the query rather than sending undefined", async () => {
    const { http, calls } = fakeHttp(
      ok({ items: [], nextCursor: null, hasMore: false }),
    );

    await listProducts(http, { status: "DRAFT", search: "hoodie" });

    expect(calls[0]?.query).toMatchObject({ status: "DRAFT", search: "hoodie" });
    expect(calls[0]?.query?.cursor).toBeUndefined();
  });

  it("throws a typed error carrying the API's code, not just a status", async () => {
    const { http } = fakeHttp(() => ({
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Admin role required",
          requestId: "req-1",
          timestamp: ISO,
        },
      },
    }));

    await expect(listProducts(http, {})).rejects.toBeInstanceOf(AdminApiError);
    await expect(listProducts(http, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      requestId: "req-1",
    });
  });

  /**
   * `code` is a platform-wide enum and therefore cannot separate failures that
   * share one. Every discount refusal is a VALIDATION_FAILED; `reason` is what
   * lets an admin screen say which of the six it was, and it has to survive
   * `toApiError` to be of any use.
   */
  it("keeps the envelope's domain reason on the thrown error", async () => {
    const { http } = fakeHttp(() => ({
      status: 400,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "That discount code has expired.",
          reason: "EXPIRED",
          requestId: "req-4",
          timestamp: ISO,
        },
      },
    }));

    await expect(listProducts(http, {})).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "EXPIRED",
    });
  });

  it("leaves reason null when the envelope carries none", async () => {
    const { http } = fakeHttp(() => ({
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Admin role required",
          requestId: "req-5",
          timestamp: ISO,
        },
      },
    }));

    await expect(listProducts(http, {})).rejects.toMatchObject({ reason: null });
  });

  it("reports a contract mismatch instead of rendering undefined", async () => {
    // A field the API renamed must fail HERE, with a path, rather than three
    // components deep as an empty price cell.
    const { http } = fakeHttp(ok({ items: [{ id: "not-a-product" }], hasMore: false }));

    await expect(listProducts(http, {})).rejects.toMatchObject({
      code: "UNPARSEABLE_RESPONSE",
    });
  });
});

/**
 * `createProduct`/`updateProduct` — the sanitisation-warning header.
 *
 * Before this, `CONTENT_SANITIZED_HEADER` reached the dashboard's transport
 * layer and was dropped there: the API already told the client when it
 * rewrote a pasted description, and nothing above `apiRequest` ever read it.
 */
describe("createProduct", () => {
  it("reports no sanitized locale when the header is absent", async () => {
    const { http } = fakeHttp(ok(buildProduct()));

    const result = await createProduct(http, buildProductBody());

    expect(result.sanitizedLocales).toEqual([]);
    expect(result.product.id).toBe(buildProduct().id);
  });

  it("surfaces every locale the API's sanitiser rewrote", async () => {
    const { http } = fakeHttp(ok(buildProduct(), { [CONTENT_SANITIZED_HEADER]: "es,en" }));

    const result = await createProduct(http, buildProductBody());

    expect(result.sanitizedLocales).toEqual(["es", "en"]);
  });
});

describe("updateProduct", () => {
  it("surfaces the sanitized locale on an update too", async () => {
    const { http } = fakeHttp(ok(buildProduct(), { [CONTENT_SANITIZED_HEADER]: "es" }));

    const result = await updateProduct(http, buildProduct().id, buildProductBody());

    expect(result.sanitizedLocales).toEqual(["es"]);
  });
});

/**
 * `addVariant`/`updateVariant`/`setInventoryPolicy` — the calls the edit page
 * never made before this. `updateVariant` in particular used to parse its
 * response against `productSchema`, a mismatch with what the API's own
 * `PATCH variants/:variantId` actually returns (a bare `ProductVariant`) that
 * went uncaught only because nothing called it — these pin the CORRECT shape.
 */
describe("addVariant", () => {
  it("posts to the product's own variants collection and parses a bare variant back", async () => {
    const { http, calls } = fakeHttp(ok(buildVariant()));

    const variant = await addVariant(
      http,
      "22222222-2222-4222-8222-222222222222",
      addVariantRequestSchema.parse({ sku: "AK-HOOD-M", priceGross: 4999, currency: "EUR" }),
    );

    expect(calls[0]?.path).toBe(
      "/admin/products/22222222-2222-4222-8222-222222222222/variants",
    );
    expect(variant.sku).toBe("AK-HOOD-M");
    expect(variant.price.gross).toBe(4999);
  });
});

describe("updateVariant", () => {
  it("parses the response as a bare ProductVariant, not a whole Product", async () => {
    // The regression this pins: this function used to parse against
    // `productSchema`, which a bare `ProductVariant` body does not satisfy —
    // it has no `variants`, `translations`, or `media` of its own.
    const { http, calls } = fakeHttp(ok(buildVariant()));

    const variant = await updateVariant(http, buildVariant().id, {
      version: 3,
      priceGross: toMinor(5999),
    });

    expect(calls[0]?.path).toBe(
      "/admin/products/variants/11111111-1111-4111-8111-111111111111",
    );
    expect(variant.id).toBe(buildVariant().id);
  });

  it("surfaces a stale version as CONFLICT, not a generic failure", async () => {
    const { http } = fakeHttp(() => ({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "Variant was modified by another write; refetch and retry",
          requestId: "req-9",
          timestamp: ISO,
        },
      },
    }));

    await expect(
      updateVariant(http, buildVariant().id, { version: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("reorderProducts", () => {
  it("PUTs the whole ordered id list and parses back a count", async () => {
    const { http, calls } = fakeHttp(ok({ reordered: 2 }));

    const result = await reorderProducts(http, ["p-2", "p-1"]);

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.path).toBe("/admin/products/reorder");
    expect(calls[0]?.body).toEqual({ productIds: ["p-2", "p-1"] });
    expect(result).toEqual({ reordered: 2 });
  });
});

describe("listCategories", () => {
  it("GETs the admin category list and parses the response", async () => {
    const { http, calls } = fakeHttp(
      ok({
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "recuperacion",
            name: { es: "Recuperación", en: "Recovery" },
            sortOrder: 0,
            productCount: 4,
          },
        ],
      }),
    );

    const result = await listCategories(http);

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/admin/categories");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.productCount).toBe(4);
  });
});

describe("createCategory", () => {
  it("POSTs the slug and both locale names, and parses back the category", async () => {
    const { http, calls } = fakeHttp(
      ok({
        id: "11111111-1111-4111-8111-111111111111",
        slug: "sudaderas",
        name: { es: "Sudaderas", en: "Hoodies" },
        sortOrder: 4,
      }),
    );

    const result = await createCategory(http, {
      slug: "sudaderas",
      name: { es: "Sudaderas", en: "Hoodies" },
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/categories");
    expect(calls[0]?.body).toEqual({
      slug: "sudaderas",
      name: { es: "Sudaderas", en: "Hoodies" },
    });
    expect(result.sortOrder).toBe(4);
  });
});

describe("updateCategory", () => {
  it("PATCHes the named category with the new name only", async () => {
    const { http, calls } = fakeHttp(
      ok({
        id: "11111111-1111-4111-8111-111111111111",
        slug: "recuperacion",
        name: { es: "Recuperación total", en: "Full recovery" },
        sortOrder: 0,
      }),
    );

    const result = await updateCategory(http, "11111111-1111-4111-8111-111111111111", {
      name: { es: "Recuperación total", en: "Full recovery" },
    });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/admin/categories/11111111-1111-4111-8111-111111111111");
    expect(calls[0]?.body).toEqual({ name: { es: "Recuperación total", en: "Full recovery" } });
    expect(result.name).toEqual({ es: "Recuperación total", en: "Full recovery" });
  });
});

describe("reorderCategories", () => {
  it("PUTs the whole ordered id list and parses back a count", async () => {
    const { http, calls } = fakeHttp(ok({ reordered: 2 }));

    const result = await reorderCategories(http, ["c-2", "c-1"]);

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.path).toBe("/admin/categories/reorder");
    expect(calls[0]?.body).toEqual({ categoryIds: ["c-2", "c-1"] });
    expect(result).toEqual({ reordered: 2 });
  });
});

describe("deleteCategory", () => {
  it("DELETEs the named category, accepting a 204 with no body", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 204, body: null }));

    await expect(
      deleteCategory(http, "11111111-1111-4111-8111-111111111111"),
    ).resolves.toBeUndefined();

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/admin/categories/11111111-1111-4111-8111-111111111111");
  });
});

describe("getSiteSettings", () => {
  it("GETs the public site-settings endpoint, not an /admin/ path", async () => {
    const { http, calls } = fakeHttp(ok({ maintenanceMode: true }));

    const result = await getSiteSettings(http);

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/site-settings");
    expect(result).toEqual({ maintenanceMode: true });
  });
});

describe("updateSiteSettings", () => {
  it("PATCHes the admin endpoint with the new value", async () => {
    const { http, calls } = fakeHttp(ok({ maintenanceMode: true }));

    const result = await updateSiteSettings(http, { maintenanceMode: true });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/admin/site-settings");
    expect(calls[0]?.body).toEqual({ maintenanceMode: true });
    expect(result).toEqual({ maintenanceMode: true });
  });

  it("round-trips false as well as true — turning maintenance off is a real write", async () => {
    const { http, calls } = fakeHttp(ok({ maintenanceMode: false }));

    await updateSiteSettings(http, { maintenanceMode: false });

    expect(calls[0]?.body).toEqual({ maintenanceMode: false });
  });
});

describe("setInventoryPolicy", () => {
  it("PUTs to the policy endpoint and parses the returned inventory item", async () => {
    const { http, calls } = fakeHttp(
      ok({
        variantId: "11111111-1111-4111-8111-111111111111",
        onHand: 12,
        reserved: 2,
        available: 10,
        lowStockThreshold: 10,
        allowBackorder: true,
      }),
    );

    const item = await setInventoryPolicy(http, "11111111-1111-4111-8111-111111111111", {
      lowStockThreshold: 10,
      allowBackorder: true,
    });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.path).toBe(
      "/admin/products/variants/11111111-1111-4111-8111-111111111111/inventory/policy",
    );
    expect(item.lowStockThreshold).toBe(10);
    expect(item.allowBackorder).toBe(true);
  });
});

describe("deleteProduct", () => {
  it("accepts a 204 with no body", async () => {
    const { http } = fakeHttp(() => ({ status: 204, body: null }));
    await expect(deleteProduct(http, "22222222-2222-4222-8222-222222222222")).resolves
      .toBeUndefined();
  });

  it("still surfaces a 403 rather than silently reporting success", async () => {
    // A swallowed 403 renders as a successful delete and the operator only finds
    // out on the next page load — with the product still there.
    const { http } = fakeHttp(() => ({
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "nope",
          requestId: "req-2",
          timestamp: ISO,
        },
      },
    }));

    await expect(
      deleteProduct(http, "22222222-2222-4222-8222-222222222222"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("requestRefund", () => {
  it("sends the caller's idempotency key on this money-creating POST", async () => {
    // Spec §9: the key must come from the CALLER so a retry of the same user
    // action reuses it. Generating one inside the function would make every
    // retry a fresh non-idempotent request — worse than having no key.
    const { http, calls } = fakeHttp(
      ok({
        id: "33333333-3333-4333-8333-333333333333",
        paymentId: "44444444-4444-4444-8444-444444444444",
        orderId: "55555555-5555-4555-8555-555555555555",
        status: "PENDING",
        reason: "REQUESTED_BY_CUSTOMER",
        amount: 2500,
        currency: "EUR",
        providerRefundId: null,
        note: null,
        createdAt: ISO,
        completedAt: null,
      }),
    );

    await requestRefund(
      http,
      "AK-2026-000123",
      { reason: "REQUESTED_BY_CUSTOMER", restockVariantIds: [] },
      "idem-key-abc",
    );

    expect(calls[0]?.idempotencyKey).toBe("idem-key-abc");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/orders/AK-2026-000123/refunds");
  });

  it("omits amount entirely when refunding the full balance", async () => {
    const { http, calls } = fakeHttp(
      ok({
        id: "33333333-3333-4333-8333-333333333333",
        paymentId: "44444444-4444-4444-8444-444444444444",
        orderId: "55555555-5555-4555-8555-555555555555",
        status: "PENDING",
        reason: "DAMAGED",
        amount: 5000,
        currency: "EUR",
        providerRefundId: null,
        note: null,
        createdAt: ISO,
        completedAt: null,
      }),
    );

    await requestRefund(
      http,
      "AK-2026-000123",
      { reason: "DAMAGED", restockVariantIds: [] },
      "idem-key-def",
    );

    // An omitted amount means "the full remaining refundable balance, resolved
    // server-side". Sending an explicit 0 or null would mean something else.
    expect(calls[0]?.body).not.toHaveProperty("amount");
  });
});

describe("transitionOrder", () => {
  it("PATCHes the status route with the chosen status", async () => {
    const { http, calls } = fakeHttp(() => ({
      status: 409,
      body: {
        error: {
          code: "ILLEGAL_STATE_TRANSITION",
          message: "Illegal order status transition PAID -> DELIVERED",
          requestId: "req-3",
          timestamp: ISO,
        },
      },
    }));

    // The server remains the enforcement point; the dashboard's dropdown is only
    // a rendering decision. A 409 must surface as one, with its code intact.
    await expect(
      transitionOrder(http, "AK-2026-000123", { status: "DELIVERED" }),
    ).rejects.toMatchObject({ code: "ILLEGAL_STATE_TRANSITION" });

    expect(calls[0]?.path).toBe("/admin/orders/AK-2026-000123/status");
    expect(calls[0]?.method).toBe("PATCH");
  });
});

describe("adjustInventory", () => {
  it("posts a signed delta with its mandatory reason", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 204, body: null }));

    await adjustInventory(http, "11111111-1111-4111-8111-111111111111", {
      delta: -3,
      reason: "Damaged in transit",
    });

    expect(calls[0]?.body).toEqual({ delta: -3, reason: "Damaged in transit" });
  });
});

describe("getOrder", () => {
  it("parses an order and keeps its money integral", async () => {
    const { http } = fakeHttp(
      ok({
        id: "55555555-5555-4555-8555-555555555555",
        orderNumber: "AK-2026-000123",
        customerId: null,
        email: "buyer@example.com",
        status: "PAID",
        locale: "es",
        currency: "COP",
        items: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            variantId: "11111111-1111-4111-8111-111111111111",
            productName: "Hoodie Kumo",
            variantName: "M",
            sku: "AK-HOOD-M",
            imageUrl: null,
            quantity: 2,
            unitPriceNet: 4132,
            unitPriceGross: 4999,
            lineDiscount: 0,
            taxRateBps: 2100,
            taxAmount: 1734,
            lineTotalNet: 8264,
            lineTotalGross: 9998,
            packProductId: null,
            packInstanceId: null,
          },
        ],
        subtotal: 9998,
        discountTotal: 0,
        shippingTotal: 500,
        taxTotal: 1734,
        grandTotal: 10498,
        refundedTotal: 0,
        shippingAddress: buildAddress(),
        billingAddress: buildAddress(),
        invoiceNumber: "INV-2026-000045",
        documentType: "CC",
        documentNumber: "1020304050",
        shippingMethodName: "Envío nacional",
        shipments: [],
        shippingRateId: null,
        events: [],
        placedAt: ISO,
        paidAt: ISO,
        cancelledAt: null,
        updatedAt: ISO,
        version: 1,
      }),
    );

    const order = await getOrder(http, "AK-2026-000123");

    expect(order.grandTotal).toBe(10498);
    expect(Number.isInteger(order.grandTotal)).toBe(true);
    expect(order.items[0]?.lineTotalGross).toBe(9998);
  });
});

function buildAddress() {
  return {
    firstName: "Ana",
    lastName: "García",
    company: null,
    line1: "Calle 10 # 43-21",
    line2: null,
    city: "Medellín",
    region: "Antioquia",
    postalCode: null,
    countryCode: "CO",
    phone: null,
  };
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

const DISCOUNT_ID = "77777777-7777-4777-8777-777777777777";

function buildDiscount(overrides: Record<string, unknown> = {}) {
  return {
    id: DISCOUNT_ID,
    code: "SAVE10",
    type: "PERCENTAGE",
    // BASIS POINTS. 1000 is 10%, not €10.00 and not 1000%.
    value: 1000,
    minimumSubtotal: 5000,
    currency: "EUR",
    maxRedemptions: 100,
    maxRedemptionsPerCustomer: 1,
    timesRedeemed: 4,
    remainingRedemptions: 96,
    stackable: false,
    startsAt: null,
    endsAt: null,
    affiliateId: null,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    ...overrides,
  };
}

describe("listDiscounts", () => {
  it("parses the paginated envelope and keeps the overloaded value integral", async () => {
    const { http } = fakeHttp(
      ok({ items: [buildDiscount()], nextCursor: null, hasMore: false }),
    );

    const page = await listDiscounts(http, {});
    const discount = page.items[0];

    // `value` is basis points here. If it ever arrives as 10 (a percent) or
    // 10.0 (a float), a coupon is off by two orders of magnitude — so the wire
    // value is asserted exactly, not merely "truthy".
    expect(discount?.value).toBe(1000);
    expect(Number.isInteger(discount?.value)).toBe(true);
    // minimumSubtotal IS money and is branded, so it must survive parseOrThrow
    // as the same integer number of minor units.
    expect(discount?.minimumSubtotal).toBe(5000);
  });

  it("sends includeDeleted and omits an absent cursor", async () => {
    const { http, calls } = fakeHttp(
      ok({ items: [], nextCursor: null, hasMore: false }),
    );

    await listDiscounts(http, { includeDeleted: true, limit: 25 });

    expect(calls[0]?.path).toBe("/admin/discounts");
    expect(calls[0]?.query).toMatchObject({ includeDeleted: true, limit: 25 });
    expect(calls[0]?.query?.cursor).toBeUndefined();
  });

  it("reports a contract mismatch rather than rendering a blank usage cell", async () => {
    // `remainingRedemptions` is what the usage column reads. A response missing
    // it must fail HERE, with a path, not three components deep as an empty td.
    const incomplete = buildDiscount();
    delete (incomplete as Record<string, unknown>)["remainingRedemptions"];

    const { http } = fakeHttp(
      ok({ items: [incomplete], nextCursor: null, hasMore: false }),
    );

    await expect(listDiscounts(http, {})).rejects.toMatchObject({
      code: "UNPARSEABLE_RESPONSE",
    });
  });
});

describe("getDiscount", () => {
  it("reads one code by id", async () => {
    const { http, calls } = fakeHttp(ok(buildDiscount()));

    const discount = await getDiscount(http, DISCOUNT_ID);

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe(`/admin/discounts/${DISCOUNT_ID}`);
    expect(discount.code).toBe("SAVE10");
  });

  it("throws a typed NOT_FOUND the page can branch on", async () => {
    // The [id] page keys its notFound() on this CODE rather than on the status,
    // so the code has to survive the round trip.
    const { http } = fakeHttp(() => ({
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: "Discount not found",
          requestId: "req-10",
          timestamp: ISO,
        },
      },
    }));

    await expect(getDiscount(http, DISCOUNT_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});

describe("createDiscount", () => {
  it("POSTs the mirrored body with no idempotency key", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 201, body: buildDiscount() }));

    const body = createDiscountRequestSchema.parse({
      code: "SAVE10",
      type: "PERCENTAGE",
      value: 1000,
    });

    await createDiscount(http, body);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/discounts");
    // Deliberately absent: this POST creates no money, and the unique `code`
    // column already makes a double submission safe with a clearer 409.
    expect(calls[0]?.idempotencyKey).toBeUndefined();
    expect(calls[0]?.body).toMatchObject({
      code: "SAVE10",
      type: "PERCENTAGE",
      value: 1000,
      // The schema's defaults are applied before the request leaves, so the API
      // never has to guess what an omitted nullable meant.
      minimumSubtotal: null,
      currency: null,
      stackable: false,
    });
  });

  it("surfaces a duplicate code as CONFLICT, not as a bare message", async () => {
    // This is the case the editor branches on to say "that code is taken". If
    // the code were lost here, the only thing left to render would be the API's
    // English — which is exactly what the closed-enum rule forbids.
    const { http } = fakeHttp(() => ({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "A discount with code SAVE10 already exists.",
          requestId: "req-11",
          timestamp: ISO,
        },
      },
    }));

    const body = createDiscountRequestSchema.parse({
      code: "SAVE10",
      type: "PERCENTAGE",
      value: 1000,
    });

    await expect(createDiscount(http, body)).rejects.toBeInstanceOf(AdminApiError);
    await expect(createDiscount(http, body)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });
});

describe("updateDiscount", () => {
  it("PATCHes without ever sending the code", async () => {
    const { http, calls } = fakeHttp(
      ok(buildDiscount({ type: "FIXED_AMOUNT", value: 500 })),
    );

    const body = updateDiscountRequestSchema.parse({
      type: "FIXED_AMOUNT",
      value: 500,
      stackable: true,
    });

    await updateDiscount(http, DISCOUNT_ID, body);

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe(`/admin/discounts/${DISCOUNT_ID}`);
    // The code is the coupon's identity and the string on every printed card;
    // the update schema has no such key and the request must not grow one.
    expect(calls[0]?.body).not.toHaveProperty("code");
    expect(calls[0]?.body).toEqual({ type: "FIXED_AMOUNT", value: 500, stackable: true });
  });
});

describe("deleteDiscount", () => {
  it("accepts a 204 with no body", async () => {
    const { http } = fakeHttp(() => ({ status: 204, body: null }));
    await expect(deleteDiscount(http, DISCOUNT_ID)).resolves.toBeUndefined();
  });

  it("still surfaces a 403 rather than silently reporting success", async () => {
    // A swallowed 403 renders as a successful archive and the coupon keeps being
    // redeemable until someone notices.
    const { http } = fakeHttp(() => ({
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Admin role required",
          requestId: "req-12",
          timestamp: ISO,
        },
      },
    }));

    await expect(deleteDiscount(http, DISCOUNT_ID)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

// ---------------------------------------------------------------------------
// Affiliates — §14 of docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md.
// ---------------------------------------------------------------------------

const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";

function buildAffiliate(overrides: Record<string, unknown> = {}) {
  return {
    id: AFFILIATE_ID,
    name: "Ana",
    country: "ES",
    socialHandle: "@ana",
    email: "ana@example.com",
    discountCodes: ["SAVE10"],
    redemptionCount: 3,
    revenueMinor: 14997,
    hasLogin: false,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    ...overrides,
  };
}

describe("listAffiliates", () => {
  it("parses the paginated envelope, including the derived stats", async () => {
    const { http } = fakeHttp(
      ok({ items: [buildAffiliate()], nextCursor: null, hasMore: false }),
    );

    const page = await listAffiliates(http, {});
    const affiliate = page.items[0];

    expect(affiliate?.discountCodes).toEqual(["SAVE10"]);
    expect(affiliate?.redemptionCount).toBe(3);
    expect(affiliate?.revenueMinor).toBe(14997);
  });

  it("sends includeDeleted and omits an absent cursor", async () => {
    const { http, calls } = fakeHttp(
      ok({ items: [], nextCursor: null, hasMore: false }),
    );

    await listAffiliates(http, { includeDeleted: true, limit: 25 });

    expect(calls[0]?.path).toBe("/admin/affiliates");
    expect(calls[0]?.query).toMatchObject({ includeDeleted: true, limit: 25 });
    expect(calls[0]?.query?.cursor).toBeUndefined();
  });

  it("reports a contract mismatch rather than rendering a blank row", async () => {
    const incomplete = buildAffiliate();
    delete (incomplete as Record<string, unknown>)["revenueMinor"];

    const { http } = fakeHttp(
      ok({ items: [incomplete], nextCursor: null, hasMore: false }),
    );

    await expect(listAffiliates(http, {})).rejects.toMatchObject({
      code: "UNPARSEABLE_RESPONSE",
    });
  });
});

describe("getAffiliate", () => {
  it("reads one affiliate by id", async () => {
    const { http, calls } = fakeHttp(ok(buildAffiliate()));

    const affiliate = await getAffiliate(http, AFFILIATE_ID);

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}`);
    expect(affiliate.name).toBe("Ana");
  });

  it("throws a typed NOT_FOUND the page can branch on", async () => {
    const { http } = fakeHttp(() => ({
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: "Affiliate not found",
          requestId: "req-20",
          timestamp: ISO,
        },
      },
    }));

    await expect(getAffiliate(http, AFFILIATE_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});

describe("createAffiliate", () => {
  it("POSTs the mirrored body", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 201, body: buildAffiliate() }));

    const body = createAffiliateRequestSchema.parse({
      name: "Ana",
      country: "ES",
      socialHandle: "@ana",
      email: "ana@example.com",
    });

    await createAffiliate(http, body);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/affiliates");
    expect(calls[0]?.body).toEqual({
      name: "Ana",
      country: "ES",
      socialHandle: "@ana",
      email: "ana@example.com",
    });
  });
});

describe("updateAffiliate", () => {
  it("PATCHes the given fields", async () => {
    const { http, calls } = fakeHttp(ok(buildAffiliate({ name: "Ana María" })));

    const body = updateAffiliateRequestSchema.parse({ name: "Ana María" });

    await updateAffiliate(http, AFFILIATE_ID, body);

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}`);
    expect(calls[0]?.body).toEqual({ name: "Ana María" });
  });
});

describe("deleteAffiliate", () => {
  it("accepts a 204 with no body", async () => {
    const { http } = fakeHttp(() => ({ status: 204, body: null }));
    await expect(deleteAffiliate(http, AFFILIATE_ID)).resolves.toBeUndefined();
  });

  it("still surfaces a 403 rather than silently reporting success", async () => {
    const { http } = fakeHttp(() => ({
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Admin role required",
          requestId: "req-21",
          timestamp: ISO,
        },
      },
    }));

    await expect(deleteAffiliate(http, AFFILIATE_ID)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("activatePartnerLogin", () => {
  it("POSTs to the affiliate's activate-login route and parses the status", async () => {
    const { http, calls } = fakeHttp(ok({ active: true, email: "ana@example.com" }));

    const status = await activatePartnerLogin(http, AFFILIATE_ID);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}/activate-login`);
    expect(status).toEqual({ active: true, email: "ana@example.com" });
  });

  it("surfaces a CONFLICT rather than treating it as success", async () => {
    const { http } = fakeHttp(() => ({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "Email already in use",
          requestId: "req-31",
          timestamp: ISO,
        },
      },
    }));

    await expect(activatePartnerLogin(http, AFFILIATE_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

const LINK_ID = "77777777-7777-4777-8777-777777777777";

function buildLink(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    affiliateId: AFFILIATE_ID,
    slug: "ana-recovers",
    clickCount: 5,
    createdAt: ISO,
    deletedAt: null,
    ...overrides,
  };
}

describe("listAffiliateLinks", () => {
  it("GETs the affiliate's links and parses the click counts", async () => {
    const { http, calls } = fakeHttp(ok([buildLink()]));

    const links = await listAffiliateLinks(http, AFFILIATE_ID);

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}/links`);
    expect(links).toHaveLength(1);
    expect(links[0]?.clickCount).toBe(5);
  });
});

describe("createAffiliateLink", () => {
  it("POSTs the mirrored slug body", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 201, body: buildLink() }));

    const body = createAffiliateLinkRequestSchema.parse({ slug: "ana-recovers" });
    await createAffiliateLink(http, AFFILIATE_ID, body);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}/links`);
    expect(calls[0]?.body).toEqual({ slug: "ana-recovers" });
  });

  it("surfaces a CONFLICT for a reserved or duplicate slug", async () => {
    const { http } = fakeHttp(() => ({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "reserved",
          requestId: "req-32",
          timestamp: ISO,
        },
      },
    }));

    await expect(
      createAffiliateLink(http, AFFILIATE_ID, { slug: "checkout" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("deleteAffiliateLink", () => {
  it("DELETEs the affiliate-scoped link route and accepts a 204 with no body", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 204, body: null }));

    await expect(deleteAffiliateLink(http, AFFILIATE_ID, LINK_ID)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe(`/admin/affiliates/${AFFILIATE_ID}/links/${LINK_ID}`);
  });

  it("still surfaces a 404 rather than silently reporting success", async () => {
    const { http } = fakeHttp(() => ({
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: "Affiliate link not found",
          requestId: "req-33",
          timestamp: ISO,
        },
      },
    }));

    await expect(deleteAffiliateLink(http, AFFILIATE_ID, LINK_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
