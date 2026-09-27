import {
  createRefundSchema,
  idSchema,
  refundReasonSchema,
  nonNegativeMinorSchema,
} from "@akai/contracts";
import { z } from "zod";

/**
 * Request DTOs for the payments module.
 *
 * zod, not class-validator (spec §7): the idiomatic `@IsString() name!: string`
 * needs a definite-assignment `!` on every field, which is indistinguishable
 * from the banned non-null assertion. Every schema here is `.strict()`, which is
 * `whitelist` + `forbidNonWhitelisted` in one — an unknown key is rejected, not
 * stripped, so nothing can be smuggled toward a Prisma `data:` spread.
 *
 * THE RULE THAT MATTERS MOST IN THIS FILE: no request schema carries the amount
 * to be CHARGED. `startCheckoutSchema` takes an order id and nothing else; the
 * total is read from the order row server-side. A client-supplied charge amount
 * is the number-one vulnerability in custom checkouts (spec §13).
 */

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Note the shape: an identifier, and no money whatsoever. There is deliberately
 * no `amount`, `currency`, `total` or `lineItems` field to tamper with — the
 * schema is `.strict()`, so sending one is a 400 rather than a silent strip.
 */
export const startCheckoutSchema = z
  .object({
    orderId: idSchema,
  })
  .strict();

export type StartCheckoutRequest = z.infer<typeof startCheckoutSchema>;

export const startCheckoutResponseSchema = z
  .object({
    orderNumber: z.string(),
    checkoutUrl: z.string().url(),
  })
  .strict();

export type StartCheckoutResponse = z.infer<typeof startCheckoutResponseSchema>;

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Derived from the shared `createRefundSchema` rather than redeclared: the
 * order id travels in the URL path, so it is omitted from the body.
 *
 * `amount` IS accepted here, and that is not a contradiction of the rule above.
 * A partial refund is a legitimate operator decision, and it is bounded
 * server-side by the remaining refundable balance
 * (`grandTotal - refundedTotal`), computed from the order row. The client
 * proposes; the server disposes. `RefundExceedsRefundableError` is the test that
 * pins it.
 */
export const refundRequestSchema = createRefundSchema.omit({ orderId: true });

export type RefundRequest = z.infer<typeof refundRequestSchema>;

export const refundResponseSchema = z
  .object({
    /**
     * NULLABLE, and that is not defensive padding. `payments.refund` is declared
     * `Promise<unknown>` by the SDK — no typed refund id exists to read, and the
     * real response shape is unconfirmed until spike gate S3 captures one. The
     * refund is recorded either way, because the money moved regardless of what
     * the response body looked like; reporting `null` is honest about not
     * knowing the provider's id, whereas inventing a placeholder string would
     * put an unusable value into an operator's hands.
     */
    refundId: z.string().nullable(),
    orderNumber: z.string(),
    amount: nonNegativeMinorSchema,
    currency: z.string().length(3),
    reason: refundReasonSchema,
    /** Remaining refundable balance AFTER this refund. */
    remainingRefundable: nonNegativeMinorSchema,
  })
  .strict();

export type RefundResponse = z.infer<typeof refundResponseSchema>;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const orderNumberParamSchema = z
  .string()
  .regex(/^AK-\d{4}-\d{6}$/, "Expected an order number of the form AK-2026-000123");

export const orderIdParamSchema = idSchema;

// ---------------------------------------------------------------------------
// Catalog sync
// ---------------------------------------------------------------------------

export const syncProductSchema = z
  .object({
    productId: idSchema,
  })
  .strict();

export type SyncProductRequest = z.infer<typeof syncProductSchema>;
