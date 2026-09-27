import { z } from "zod";
import {
  currencyCodeSchema,
  discountTypeSchema,
  idSchema,
  isoDateTimeSchema,
  nonNegativeMinorSchema,
  paginationQuerySchema,
  type DiscountType,
} from "@akai/contracts";

/**
 * Admin discount CRUD DTOs.
 *
 * DEFINED LOCALLY, like the catalog admin DTOs: promoting these into
 * @akai/contracts belongs to the ts-rest router pass and would collide with
 * whoever is editing that lib now. Every schema is `.strict()` — an unknown key is
 * rejected, never stripped, so a crafted body cannot smuggle a field into a Prisma
 * `data:` spread (spec §7).
 *
 * The `value` column is overloaded by type, matching the discount engine:
 *  - PERCENTAGE   → basis points (1000 = 10%), capped at 10000 (100%).
 *  - FIXED_AMOUNT → minor units off.
 *  - FREE_SHIPPING→ unused (the effect is on shipping).
 */

/** A percentage discount is capped at 100% so a code can never over-refund. */
function assertValueInRange(
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

export const createDiscountSchema = z
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
    /**
     * Which affiliate this coupon belongs to, if any — §14 of
     * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`. Set
     * at create time (a code minted specifically for a partner) or later via
     * `updateDiscountSchema`'s identical field (reassignment).
     */
    affiliateId: idSchema.nullable().default(null),
  })
  .strict()
  .superRefine(assertValueInRange);

export type CreateDiscountDto = z.infer<typeof createDiscountSchema>;

/**
 * Update leaves `code` alone — it is the coupon's identity and the key customers
 * type. Everything else is individually optional; an omitted field is untouched,
 * an explicit `null` clears a nullable one.
 */
export const updateDiscountSchema = z
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
    /**
     * Assign, reassign or clear (`null`) this coupon's affiliate. THE ADMIN
     * AFFILIATES SCREEN'S "assign a coupon" CONTROL WRITES THROUGH HERE —
     * see `AdminAffiliatesController`'s own doc comment for why coupon
     * assignment has no route of its own.
     */
    affiliateId: idSchema.nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.type !== undefined) {
      assertValueInRange({ type: data.type, value: data.value }, ctx);
    }
  });

export type UpdateDiscountDto = z.infer<typeof updateDiscountSchema>;

export const listDiscountsQuerySchema = paginationQuerySchema
  .extend({
    /**
     * `z.coerce.boolean()` is JavaScript TRUTHINESS, and a query string arrives
     * as text: `Boolean("false") === true`, so `?includeDeleted=false` turned
     * the filter ON and soft-deleted coupons were listed on every request. The
     * enum+transform is the repo's idiom for a boolean on the wire — see
     * `anonymised` in users/dto/users.dto.ts.
     */
    includeDeleted: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default("false"),
  })
  .strict();

export type ListDiscountsQuery = z.infer<typeof listDiscountsQuerySchema>;

/**
 * The admin view of a discount, INCLUDING usage stats. `timesRedeemed` and the
 * derived `remainingRedemptions` are the "usage" the checklist asks for — an
 * admin managing coupons needs to see how much of a code's allowance is spent.
 */
export interface AdminDiscount {
  readonly id: string;
  readonly code: string;
  readonly type: DiscountType;
  readonly value: number;
  readonly minimumSubtotal: number | null;
  readonly currency: string | null;
  readonly maxRedemptions: number | null;
  readonly maxRedemptionsPerCustomer: number | null;
  readonly timesRedeemed: number;
  /** null when the code is uncapped; otherwise how many redemptions remain. */
  readonly remainingRedemptions: number | null;
  readonly stackable: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** The affiliate this coupon currently belongs to, or null. */
  readonly affiliateId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}
