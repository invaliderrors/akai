import { z } from "zod";
import { countryCodeSchema, emailSchema, paginationQuerySchema } from "@akai/contracts";

/**
 * Admin affiliate CRUD DTOs.
 *
 * DEFINED LOCALLY, matching `discount-admin.dto.ts`'s own note: promoting
 * these into @akai/contracts belongs to the ts-rest router pass. Every
 * schema is `.strict()`.
 */

export const createAffiliateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    country: countryCodeSchema,
    socialHandle: z.string().trim().min(1).max(200),
    email: emailSchema,
  })
  .strict();

export type CreateAffiliateDto = z.infer<typeof createAffiliateSchema>;

/** Every field individually optional; an omitted field is untouched. There is nothing nullable to clear — every field on this row is required. */
export const updateAffiliateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    country: countryCodeSchema.optional(),
    socialHandle: z.string().trim().min(1).max(200).optional(),
    email: emailSchema.optional(),
  })
  .strict();

export type UpdateAffiliateDto = z.infer<typeof updateAffiliateSchema>;

export const listAffiliatesQuerySchema = paginationQuerySchema
  .extend({
    /** Same enum+transform idiom `listDiscountsQuerySchema` uses — `z.coerce.boolean()` is truthiness, not parsing. */
    includeDeleted: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default("false"),
  })
  .strict();

export type ListAffiliatesQuery = z.infer<typeof listAffiliatesQuerySchema>;

/**
 * The admin view of an affiliate, INCLUDING derived stats.
 *
 * `redemptionCount`/`revenueMinor` are NOT stored columns — see
 * `AffiliateAdminService`'s own doc comment for exactly which order statuses
 * they count and why. `discountCodes` is every LIVE coupon currently
 * assigned to this affiliate (an affiliate may hold more than one — see the
 * `Discount.affiliateId` field's own comment for why).
 *
 * `hasLogin` mirrors `Affiliate.customerId !== null` — whether an admin has
 * activated a partner dashboard login for this row. The email a login uses
 * is always this row's own `email`; there is no separate login-email field.
 */
export interface AdminAffiliate {
  readonly id: string;
  readonly name: string;
  readonly country: string;
  readonly socialHandle: string;
  readonly email: string;
  readonly discountCodes: readonly string[];
  readonly redemptionCount: number;
  /** Minor units, the store's currency. Summed across every counted order — see the service's own doc comment. */
  readonly revenueMinor: number;
  readonly hasLogin: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** Response from activating (or re-notifying) a partner's dashboard login. */
export interface PartnerLoginStatus {
  readonly active: boolean;
  readonly email: string;
}

/**
 * The PARTNER's own view of their stats — deliberately NARROWER than
 * `AdminAffiliate`. No `revenueMinor`: a partner sees how many times their
 * code has been used, never the store's revenue figures, so the field is
 * omitted from the TYPE rather than merely left unrendered.
 */
export interface PartnerStats {
  readonly discountCodes: readonly string[];
  readonly redemptionCount: number;
}
