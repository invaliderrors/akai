import { describe, expect, it } from "vitest";
import {
  ERROR_STATUS,
  errorCodeSchema,
  errorEnvelopeSchema,
  stockShortageSchema,
  emailSchema,
  paginatedSchema,
  paginationQuerySchema,
  slugSchema,
} from "./common";
import {
  ORDER_STATUS_TRANSITIONS,
  discountFailureReasonSchema,
  orderStatusSchema,
} from "./enums";
import { addCartItemSchema, createCheckoutSessionSchema } from "./commerce";
import { createAddressSchema, loginResponseSchema } from "./identity";
import { z } from "zod";

describe("common primitives", () => {
  it("lower-cases emails at the boundary so identity matches the citext column", () => {
    expect(emailSchema.parse("Ana.Garcia@Example.COM")).toBe("ana.garcia@example.com");
  });

  it("enforces lowercase kebab slugs", () => {
    expect(slugSchema.safeParse("bpc-157-10mg").success).toBe(true);
    expect(slugSchema.safeParse("BPC_157").success).toBe(false);
    expect(slugSchema.safeParse("trailing-").success).toBe(false);
  });

  it("defaults and caps pagination limits", () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(24);
    expect(paginationQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
    // Query strings arrive as strings; coercion must handle that.
    expect(paginationQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it("builds a paginated envelope around any item schema", () => {
    const schema = paginatedSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({
      items: [{ id: "a" }],
      nextCursor: null,
      hasMore: false,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).toBeNull();
  });
});

describe("error envelope", () => {
  it("accepts a well-formed error", () => {
    const result = errorEnvelopeSchema.safeParse({
      error: {
        code: "NOT_FOUND",
        message: "Order not found",
        requestId: "req_123",
        timestamp: "2026-07-20T10:00:00.000Z",
      },
    });
    expect(result.success).toBe(true);
  });

  /**
   * `reason` is a domain sub-code — the only thing that separates the six ways
   * a discount code can be refused, all of which are VALIDATION_FAILED. These
   * three cases pin the contract it has to satisfy: OPTIONAL (older services
   * and every module that attaches none keep parsing), ACCEPTED when present,
   * and no loosening of `.strict()` in the process — a `reason` that let an
   * unknown key ride along beside it would defeat the whitelist the envelope
   * relies on.
   */
  it("accepts an envelope with no reason — the field is additive", () => {
    const result = errorEnvelopeSchema.safeParse({
      error: {
        code: "VALIDATION_FAILED",
        message: "That discount code is not valid.",
        requestId: "req_123",
        timestamp: "2026-07-20T10:00:00.000Z",
      },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.error.reason).toBeUndefined();
  });

  it("carries a domain reason so one code can express several failures", () => {
    const result = errorEnvelopeSchema.safeParse({
      error: {
        code: "VALIDATION_FAILED",
        message: "Your basket does not meet the minimum for that discount code.",
        reason: "BELOW_MINIMUM",
        requestId: "req_123",
        timestamp: "2026-07-20T10:00:00.000Z",
      },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.error.reason).toBe("BELOW_MINIMUM");
    // A reason is an identifier, never prose: the cap is what keeps it one.
    expect(
      errorEnvelopeSchema.safeParse({
        error: {
          code: "VALIDATION_FAILED",
          message: "no",
          reason: "X".repeat(65),
          requestId: "r",
          timestamp: "2026-07-20T10:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });

  /**
   * `shortage` names WHICH variant ran short and how many are left, so a pack
   * refusal can say "RETA: only 3 left" in the client's own language instead
   * of a generic sold-out sentence. Optional and strict, like `reason`.
   */
  it("carries an optional, strictly-shaped stock shortage", () => {
    const base = {
      code: "OUT_OF_STOCK",
      message: "RETA: only 3 units are available",
      requestId: "r",
      timestamp: "2026-07-20T10:00:00.000Z",
    };
    const shortage = { variantId: "20000000-0000-4000-8000-000000000002", availableQuantity: 3 };

    const parsed = errorEnvelopeSchema.safeParse({ error: { ...base, shortage } });
    expect(parsed.success && parsed.data.error.shortage).toEqual(shortage);
    expect(stockShortageSchema.safeParse(shortage).success).toBe(true);

    expect(errorEnvelopeSchema.safeParse({ error: base }).success).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse({ error: { ...base, shortage: { ...shortage, name: "RETA" } } }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ error: { ...base, shortage: { ...shortage, availableQuantity: -1 } } })
        .success,
    ).toBe(false);
  });

  it("still rejects an unknown key — the envelope stays a whitelist", () => {
    const result = errorEnvelopeSchema.safeParse({
      error: {
        code: "VALIDATION_FAILED",
        message: "no",
        reason: "EXPIRED",
        stack: "at Object.<anonymous> (/srv/api/dist/main.js:1:1)",
        requestId: "r",
        timestamp: "2026-07-20T10:00:00.000Z",
      },
    });
    expect(result.success).toBe(false);
  });

  it("pins every discount failure reason the API may emit", () => {
    // The API's DiscountError imports this union; a member added on one side
    // only would ship a reason no client can branch on.
    expect(discountFailureReasonSchema.options).toEqual([
      "INVALID_CODE",
      "NOT_ACTIVE",
      "EXPIRED",
      "CURRENCY_MISMATCH",
      "BELOW_MINIMUM",
      "USAGE_LIMIT_REACHED",
    ]);
  });

  it("rejects an unknown error code", () => {
    const result = errorEnvelopeSchema.safeParse({
      error: {
        code: "TEAPOT",
        message: "no",
        requestId: "r",
        timestamp: "2026-07-20T10:00:00.000Z",
      },
    });
    expect(result.success).toBe(false);
  });

  it("maps every error code to an HTTP status — no code may be unmapped", () => {
    for (const code of errorCodeSchema.options) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("order state machine table", () => {
  it("covers every status", () => {
    for (const status of orderStatusSchema.options) {
      expect(ORDER_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("only ever targets real statuses", () => {
    const valid = new Set<string>(orderStatusSchema.options);
    for (const targets of Object.values(ORDER_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(valid.has(target)).toBe(true);
      }
    }
  });

  it("keeps CANCELLED, REFUNDED and FAILED terminal", () => {
    expect(ORDER_STATUS_TRANSITIONS.CANCELLED).toHaveLength(0);
    expect(ORDER_STATUS_TRANSITIONS.REFUNDED).toHaveLength(0);
    expect(ORDER_STATUS_TRANSITIONS.FAILED).toHaveLength(0);
  });

  it("does not allow a cancelled order to become paid", () => {
    expect(ORDER_STATUS_TRANSITIONS.CANCELLED).not.toContain("PAID");
  });
});

describe("request schemas are strict", () => {
  it("rejects unknown keys on a cart mutation", () => {
    const result = addCartItemSchema.safeParse({
      variantId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      quantity: 2,
      unitPrice: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys on an address create", () => {
    const result = createAddressSchema.safeParse({
      firstName: "Ana",
      lastName: "García",
      company: null,
      line1: "Calle Mayor 1",
      line2: null,
      city: "Madrid",
      region: null,
      postalCode: "28013",
      countryCode: "ES",
      phone: null,
      type: "SHIPPING",
      role: "ADMIN",
    });
    expect(result.success).toBe(false);
  });

  it("gives the checkout request NO amount field — totals are server-computed only", () => {
    const keys = Object.keys(createCheckoutSessionSchema.shape);
    for (const forbidden of ["amount", "total", "grandTotal", "price"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("gives the login response NO token field — tokens never reach the browser", () => {
    const keys = Object.keys(loginResponseSchema.shape);
    for (const forbidden of ["accessToken", "refreshToken", "token"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
