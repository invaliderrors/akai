import { idSchema } from "@akai/contracts";
import { z } from "zod";

/**
 * Request DTOs for the payments module.
 *
 * zod, not class-validator: the idiomatic `@IsString() name!: string` needs a
 * definite-assignment `!` on every field, which is indistinguishable from the
 * banned non-null assertion. Every schema here is `.strict()` — an unknown key
 * is rejected, not stripped.
 *
 * THE RULE THAT MATTERS MOST IN THIS FILE: no request schema carries the amount
 * to be CHARGED. `startCheckoutSchema` takes an order id and nothing else; the
 * total is read from the order row server-side. A client-supplied charge amount
 * is the number-one vulnerability in custom checkouts.
 *
 * The return-page confirmation body (`confirmPaymentRequestSchema`) lives in
 * `@akai/contracts`, because the storefront sends it.
 */

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * An identifier, and no money whatsoever. There is deliberately no `amount`,
 * `currency`, `total` or `lineItems` field to tamper with.
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
// Params
// ---------------------------------------------------------------------------

export const orderNumberParamSchema = z
  .string()
  .regex(/^AK-\d{4}-\d{6}$/, "Expected an order number of the form AK-2026-000123");

export const orderIdParamSchema = idSchema;
