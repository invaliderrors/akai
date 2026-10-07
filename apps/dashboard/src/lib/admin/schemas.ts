import { z } from "zod";
import {
  adminCustomerSchema,
  adminOrderSummarySchema,
  createVariantSchema,
  currencyCodeSchema,
  discountTypeSchema,
  idSchema,
  isoDateTimeSchema,
  nonNegativeMinorSchema,
  orderSchema,
  paginatedSchema,
  priceTierSchema,
  productSchema,
  refundSchema,
  slugSchema,
  type CurrencyCode,
  type DiscountType,
} from "@akai/contracts";

/**
 * Response and request schemas for the admin surface.
 *
 * Everything the API RETURNS is parsed against a schema before a component sees
 * it. The API is a separately-deployable service, so its output is external
 * input to this app — the same rule that governs a provider webhook governs it.
 *
 * WHERE THESE COME FROM. Response shapes reuse @akai/contracts verbatim
 * (`productSchema`, `orderSchema`, `adminCustomerSchema`, …) so a drift between
 * what the API serialises and what the dashboard renders is a parse failure with
 * a field path, not a blank cell. A handful of REQUEST shapes have no home in
 * contracts yet — the API declares them in
 * `apps/api/src/modules/catalog/dto/catalog.dto.ts` and
 * `apps/api/src/modules/orders/dto/orders.dto.ts`, which a `scope:web` project
 * may not import (Nx boundary, by design). They are mirrored below, written to
 * be deleted the day they move into libs/contracts. Flagged in followUps.
 */

// ---------------------------------------------------------------------------
// Products — read
// ---------------------------------------------------------------------------

export const paginatedProductsSchema = paginatedSchema(productSchema);
export type PaginatedProducts = z.infer<typeof paginatedProductsSchema>;

// `adminOrderSummarySchema`: the admin list also carries each order's newest
// shipment.
export const paginatedOrdersSchema = paginatedSchema(adminOrderSummarySchema);
export const paginatedCustomersSchema = paginatedSchema(adminCustomerSchema);

export { orderSchema, productSchema, adminCustomerSchema, refundSchema };

// ---------------------------------------------------------------------------
// Products — write
// ---------------------------------------------------------------------------

/**
 * Mirrors the API's `updateVariantSchema`.
 *
 * `version` is REQUIRED, exactly as it is server-side. Making it optional in the
 * form would let an admin silently opt out of optimistic concurrency: two
 * operators editing the same variant would last-write-win and one price change
 * would vanish with no error shown to the person whose edit was lost.
 *
 * `priceGross` is the only price input. Net and tax are DERIVED server-side via
 * @akai/money's splitGross, so the `net + tax = gross` CHECK constraint cannot
 * be violated by anything this form sends.
 */
export const updateVariantRequestSchema = z
  .object({
    version: z.number().int().min(0),
    sku: z.string().min(1).max(64).optional(),
    name: z.string().max(120).nullable().optional(),
    options: z.record(z.string().max(40), z.string().max(80)).optional(),
    priceGross: nonNegativeMinorSchema.optional(),
    compareAtGross: nonNegativeMinorSchema.nullable().optional(),
    taxRateBps: z.number().int().min(0).max(10_000).optional(),
    weightGrams: z.number().int().positive().nullable().optional(),
    /**
     * FULL REPLACEMENT when present, absent leaves them alone — matching the
     * API's own `updateVariantSchema` exactly. This was missing here: the two
     * schemas had drifted, and a caller sending tiers on an update would have
     * been rejected by THIS mirror before ever reaching the API's own (correct)
     * one.
     */
    priceTiers: z.array(priceTierSchema).max(10).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateVariantRequest = z.infer<typeof updateVariantRequestSchema>;

/** Adding a variant to an existing product reuses the contract's create shape. */
export const addVariantRequestSchema = createVariantSchema;
export type AddVariantRequest = z.infer<typeof addVariantRequestSchema>;

/**
 * Mirrors the API's `adjustInventorySchema`.
 *
 * The delta is SIGNED and the reason is MANDATORY, both enforced here so the
 * admin is told before the round trip. A zero delta is rejected because it
 * writes an append-only ledger row that asserts nothing.
 *
 * `expectedOnHand` is the count the delta was computed from; the API refuses
 * the write as STOCK_CHANGED if the stored count has moved since.
 */
export const adjustInventoryRequestSchema = z
  .object({
    delta: z
      .number()
      .int()
      .refine((value) => value !== 0, "Adjustment must not be zero"),
    reason: z.string().min(3).max(500),
    expectedOnHand: z.number().int().min(0).optional(),
  })
  .strict();

export type AdjustInventoryRequest = z.infer<typeof adjustInventoryRequestSchema>;

export const setInventoryPolicyRequestSchema = z
  .object({
    lowStockThreshold: z.number().int().min(0).optional(),
    allowBackorder: z.boolean().optional(),
  })
  .strict();

export type SetInventoryPolicyRequest = z.infer<typeof setInventoryPolicyRequestSchema>;

/**
 * Mirrors the API's `addMediaSchema`, INCLUDING its protocol allowlist.
 *
 * `z.string().url()` alone is not enough and this is not theoretical: it
 * delegates to the WHATWG parser, which accepts `javascript:alert(1)` and
 * `data:text/html,…` as valid URLs. Rendered into an `<img src>`, that is stored
 * XSS whose only prerequisite is an admin-authenticated write — and a
 * compromised staff account is exactly where that starts. Duplicating the guard
 * client-side is defence in depth, not a substitute for the server's.
 */
const httpUrlSchema = z
  .string()
  .url()
  .max(1024)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "URL must use http or https");

export const addMediaRequestSchema = z
  .object({
    objectKey: z.string().min(1).max(512),
    url: httpUrlSchema,
    alt: z.string().max(300).default(""),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sortOrder: z.number().int().min(0).default(0),
    /**
     * Set to attach the asset to ONE variant; omit for a product-gallery image.
     *
     * The API verifies the variant actually belongs to the product in the path
     * and answers NOT_FOUND when it does not — this mirror carries the field so
     * the request is well-formed, never so the client can be trusted about it.
     */
    variantId: idSchema.optional(),
  })
  .strict();

export type AddMediaRequest = z.infer<typeof addMediaRequestSchema>;

/** Full replacement, not a patch — ordering is part of the value being set. */
export const setCategoriesRequestSchema = z
  .object({ categoryIds: z.array(idSchema).max(50) })
  .strict();

// ---------------------------------------------------------------------------
// Orders — write
// ---------------------------------------------------------------------------

/**
 * Mirrors the API's `adminTransitionOrderSchema`.
 *
 * Deliberately accepts the FULL OrderStatus enum, exactly as the server schema
 * does. The narrower "what may an operator assign" rule lives in
 * `order-status.ts` and is enforced server-side by `assertAdminMayAssign`.
 * Encoding it twice — once as a validation schema, once as the dropdown's option
 * list — would put the same rule in two places with no test tying them together.
 */
export const transitionOrderRequestSchema = z
  .object({
    status: orderSchema.shape.status,
    note: z.string().max(1000).optional(),
  })
  .strict();

export type TransitionOrderRequest = z.infer<typeof transitionOrderRequestSchema>;

/**
 * Mirrors the API's `createRefundRequestSchema`: a refund the operator has
 * ALREADY made in the Wompi dashboard, being recorded.
 *
 * `amount` omitted means "the full remaining refundable balance", resolved
 * SERVER-SIDE. That is both the common case and the one an operator is most
 * likely to mistype — and the server bounds any supplied amount by
 * `grandTotal - refundedTotal` regardless of what this form sends.
 */
export const createRefundRequestSchema = z
  .object({
    amount: z.number().int().min(1).optional(),
    reason: refundSchema.shape.reason,
    note: z.string().max(1000).optional(),
    /** The refund's reference in the Wompi dashboard, when the operator has one. */
    providerRefundId: z.string().trim().min(1).max(128).optional(),
    restockVariantIds: z.array(idSchema).default([]),
  })
  .strict();

export type CreateRefundRequest = z.infer<typeof createRefundRequestSchema>;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Aggregate money is `z.number().int()`, NOT `nonNegativeMinorSchema`.
 *
 * This mirrors a decision made deliberately in the API's metrics service and it
 * is worth restating. `Minor` is capped at MINOR_MAX (€20M) because it models a
 * single transactional amount, and minting one above the cap THROWS. A
 * platform-lifetime revenue sum legitimately exceeds €20M, so parsing it as
 * `Minor` would make the dashboard start crashing on a successful business.
 * These figures are display-only and never feed a charge.
 */
const aggregateMinorSchema = z.number().int();

export const revenueSummarySchema = z
  .object({
    grossTotal: aggregateMinorSchema,
    refundedTotal: aggregateMinorSchema,
    /** gross - refunded. The figure that matches the bank. */
    netTotal: aggregateMinorSchema,
    orderCount: z.number().int().min(0),
    averageOrderValue: aggregateMinorSchema,
    currency: z.string().length(3),
    from: z.string(),
    to: z.string(),
  })
  .strict();

export type RevenueSummary = z.infer<typeof revenueSummarySchema>;

export const statusCountSchema = z
  .object({ status: z.string(), count: z.number().int().min(0) })
  .strict();

export const metricsOverviewSchema = z
  .object({
    revenue: revenueSummarySchema,
    /**
     * `ordersByStatus`, matching what the API sends. It was `statusCounts` here
     * and the schema is `.strict()`, so `getMetricsOverview` threw on EVERY call
     * — invisible until now because no page had ever called it.
     */
    ordersByStatus: z.array(statusCountSchema),
  })
  .strict();

export type MetricsOverview = z.infer<typeof metricsOverviewSchema>;

export const topProductSchema = z
  .object({
    sku: z.string(),
    productName: z.string(),
    unitsSold: z.number().int().min(0),
    revenueGross: aggregateMinorSchema,
  })
  .strict();

export type TopProduct = z.infer<typeof topProductSchema>;

export const lowStockVariantSchema = z
  .object({
    variantId: z.string(),
    sku: z.string(),
    onHand: z.number().int(),
    reserved: z.number().int(),
    available: z.number().int(),
    lowStockThreshold: z.number().int(),
  })
  .strict();

export type LowStockVariant = z.infer<typeof lowStockVariantSchema>;

export const recentOrderSchema = z
  .object({
    orderNumber: z.string(),
    status: z.string(),
    grandTotal: aggregateMinorSchema,
    currency: z.string().length(3),
    placedAt: z.string(),
    customerId: z.string().nullable(),
  })
  .strict();

export type RecentOrder = z.infer<typeof recentOrderSchema>;

/**
 * How many of the customers who bought IN the window have ordered before —
 * lifetime, not just in this window. Mirrors the API's `RepeatCustomerRate`.
 */
export const repeatCustomerRateSchema = z
  .object({
    customersInWindow: z.number().int().min(0),
    repeatCustomers: z.number().int().min(0),
    /** `repeatCustomers / customersInWindow`, already rounded. 0 when nobody ordered. */
    repeatRate: z.number().min(0).max(1),
  })
  .strict();

export type RepeatCustomerRate = z.infer<typeof repeatCustomerRateSchema>;

/**
 * `returnsSummary` and `emailDeliverySummary` share this exact shape on the
 * API side — a status histogram plus its total — so it is defined once and
 * given two names at the boundary, one per endpoint, rather than duplicated.
 */
const statusBreakdownSchema = z
  .object({ byStatus: z.array(statusCountSchema), total: z.number().int().min(0) })
  .strict();

export const returnsSummarySchema = statusBreakdownSchema;
export type ReturnsSummary = z.infer<typeof returnsSummarySchema>;

export const emailDeliverySummarySchema = statusBreakdownSchema;
export type EmailDeliverySummary = z.infer<typeof emailDeliverySummarySchema>;

export const dailyRevenuePointSchema = z
  .object({
    /** UTC midnight of the day this point summarises, as an ISO string. */
    day: z.string(),
    grossTotal: aggregateMinorSchema,
  })
  .strict();

export type DailyRevenuePoint = z.infer<typeof dailyRevenuePointSchema>;

// ---------------------------------------------------------------------------
// Re-exports the pages consume, so a page imports from ONE module.
// ---------------------------------------------------------------------------

export {
  createVariantSchema,
  currencyCodeSchema,
  discountTypeSchema,
  idSchema,
  isoDateTimeSchema,
  slugSchema,
};

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

/**
 * The store's base currency, defined ONCE.
 *
 * `currencyCodeSchema.parse` rather than `"COP" as CurrencyCode`: the cast
 * asserts the brand, this earns it, and the schema is the thing that would catch
 * a typo the day someone changes this line. A discount whose `currency` is null
 * applies in any currency, so this is only the exponent used to parse an amount
 * the operator types — never a claim about what the coupon is restricted to.
 *
 * TODO (followUps): belongs in a settings endpoint alongside the product form's
 * identical assumption, which still spells it as a cast in
 * `admin/products/new/page.tsx`.
 */
export const DEFAULT_CURRENCY: CurrencyCode = currencyCodeSchema.parse("COP");

/**
 * The admin view of one discount code, mirroring the API's `AdminDiscount`
 * interface in `apps/api/src/modules/discounts/discount-admin.dto.ts`.
 *
 * `value` is OVERLOADED BY TYPE and that is the single most important fact about
 * this shape: PERCENTAGE stores BASIS POINTS (1000 = 10%), FIXED_AMOUNT stores
 * MINOR UNITS, FREE_SHIPPING ignores it entirely. Nothing in the type system can
 * express that, so every read of `value` in this slice is preceded by a check of
 * `type`, and the form converts through `money-input.ts` in both directions.
 *
 * `minimumSubtotal` is parsed as a branded `Minor` so it can be handed straight
 * to `formatMoney`; `value` deliberately is NOT, because two thirds of the time
 * it is not money at all and branding it would invite exactly the confusion the
 * brand exists to prevent.
 */
export const adminDiscountSchema = z
  .object({
    id: idSchema,
    code: z.string().min(1).max(64),
    type: discountTypeSchema,
    value: z.number().int(),
    minimumSubtotal: nonNegativeMinorSchema.nullable(),
    currency: currencyCodeSchema.nullable(),
    maxRedemptions: z.number().int().nullable(),
    maxRedemptionsPerCustomer: z.number().int().nullable(),
    timesRedeemed: z.number().int(),
    /** null when the code is uncapped; otherwise how many redemptions remain. */
    remainingRedemptions: z.number().int().nullable(),
    stackable: z.boolean(),
    startsAt: isoDateTimeSchema.nullable(),
    endsAt: isoDateTimeSchema.nullable(),
    /** The affiliate this coupon currently belongs to, or null — §14. */
    affiliateId: idSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    deletedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type AdminDiscount = z.infer<typeof adminDiscountSchema>;

export const paginatedDiscountsSchema = paginatedSchema(adminDiscountSchema);
export type PaginatedDiscounts = z.infer<typeof paginatedDiscountsSchema>;

/**
 * A percentage discount is capped at 100% so a code can never over-refund.
 * Lifted verbatim from the API's `assertValueInRange` — the same rule, stated at
 * the outermost of the three places that enforce it (form, API, database).
 */
function assertDiscountValueInRange(
  data: { readonly type: DiscountType; readonly value: number | undefined },
  ctx: z.RefinementCtx,
): void {
  if (data.value !== undefined && data.type === "PERCENTAGE" && data.value > 10_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "A percentage discount may not exceed 10000 basis points (100%).",
    });
  }
}

/**
 * Mirrors the API's `createDiscountSchema`, `.strict()` and refinement included.
 *
 * Mirrored rather than imported because `apps/api/**` is `scope:server` and a
 * `scope:web` project may not depend on it (Nx boundary, by design) — the same
 * situation as the catalog and order request shapes above, and written to be
 * deleted the day discounts move into libs/contracts. Flagged in followUps.
 */
export const createDiscountRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    type: discountTypeSchema,
    value: z.number().int().min(0),
    minimumSubtotal: nonNegativeMinorSchema.nullable().default(null),
    currency: currencyCodeSchema.nullable().default(null),
    maxRedemptions: z.number().int().positive().nullable().default(null),
    maxRedemptionsPerCustomer: z.number().int().positive().nullable().default(null),
    stackable: z.boolean().default(false),
    startsAt: isoDateTimeSchema.nullable().default(null),
    endsAt: isoDateTimeSchema.nullable().default(null),
    /** Which affiliate this coupon belongs to, if any — §14. */
    affiliateId: idSchema.nullable().default(null),
  })
  .strict()
  .superRefine(assertDiscountValueInRange);

export type CreateDiscountRequest = z.infer<typeof createDiscountRequestSchema>;

/**
 * Mirrors the API's `updateDiscountSchema`.
 *
 * `code` is ABSENT, exactly as it is server-side: the code is the coupon's
 * identity and the string customers type, so renaming it in place would silently
 * invalidate every printed card and every affiliate link carrying the old one.
 * Every other field is individually optional — an omitted field is untouched, an
 * explicit `null` clears a nullable one.
 */
export const updateDiscountRequestSchema = z
  .object({
    type: discountTypeSchema.optional(),
    value: z.number().int().min(0).optional(),
    minimumSubtotal: nonNegativeMinorSchema.nullable().optional(),
    currency: currencyCodeSchema.nullable().optional(),
    maxRedemptions: z.number().int().positive().nullable().optional(),
    maxRedemptionsPerCustomer: z.number().int().positive().nullable().optional(),
    stackable: z.boolean().optional(),
    startsAt: isoDateTimeSchema.nullable().optional(),
    endsAt: isoDateTimeSchema.nullable().optional(),
    /** Assign, reassign or clear (`null`) this coupon's affiliate — §14. */
    affiliateId: idSchema.nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.type !== undefined) {
      assertDiscountValueInRange({ type: data.type, value: data.value }, ctx);
    }
  });

export type UpdateDiscountRequest = z.infer<typeof updateDiscountRequestSchema>;

/**
 * Mirrors the API's `AdminAffiliate` — §14 of
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`. Same
 * "mirrored, not imported" reasoning as every other admin shape in this
 * file.
 */
export const adminAffiliateSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(200),
    country: z.string().length(2),
    socialHandle: z.string().min(1).max(200),
    email: z.string().email(),
    discountCodes: z.array(z.string()),
    redemptionCount: z.number().int().min(0),
    revenueMinor: z.number().int().min(0),
    hasLogin: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    deletedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type AdminAffiliate = z.infer<typeof adminAffiliateSchema>;

/** Mirrors the API's `PartnerLoginStatus` — the response from activating (or re-notifying) a partner login. */
export const partnerLoginStatusSchema = z
  .object({
    active: z.boolean(),
    email: z.string().email(),
  })
  .strict();

export type PartnerLoginStatus = z.infer<typeof partnerLoginStatusSchema>;

/**
 * Mirrors the API's `AdminAffiliateLink`. `clickCount` is a live count, never
 * a stored figure — see `AffiliateLinksService`'s own doc comment.
 */
export const adminAffiliateLinkSchema = z
  .object({
    id: idSchema,
    affiliateId: idSchema,
    slug: z.string().min(2).max(80),
    clickCount: z.number().int().min(0),
    createdAt: isoDateTimeSchema,
    deletedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type AdminAffiliateLink = z.infer<typeof adminAffiliateLinkSchema>;

/** Mirrors the API's `createAffiliateLinkSchema`. */
export const createAffiliateLinkRequestSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  })
  .strict();

export type CreateAffiliateLinkRequest = z.infer<typeof createAffiliateLinkRequestSchema>;

export const paginatedAffiliatesSchema = paginatedSchema(adminAffiliateSchema);
export type PaginatedAffiliates = z.infer<typeof paginatedAffiliatesSchema>;

/** Mirrors the API's `createAffiliateSchema`. */
export const createAffiliateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    country: z.string().length(2),
    socialHandle: z.string().trim().min(1).max(200),
    email: z.string().trim().email(),
  })
  .strict();

export type CreateAffiliateRequest = z.infer<typeof createAffiliateRequestSchema>;

/** Mirrors the API's `updateAffiliateSchema` — every field individually optional. */
export const updateAffiliateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    country: z.string().length(2).optional(),
    socialHandle: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().optional(),
  })
  .strict();

export type UpdateAffiliateRequest = z.infer<typeof updateAffiliateRequestSchema>;
