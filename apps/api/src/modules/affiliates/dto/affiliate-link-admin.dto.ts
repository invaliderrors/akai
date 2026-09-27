import { z } from "zod";

/**
 * Admin CRUD DTOs for an affiliate's vanity links (`akai.shop/<slug>`).
 *
 * DEFINED LOCALLY, matching `affiliate-admin.dto.ts`'s own note: promoting
 * these into @akai/contracts belongs to the ts-rest router pass.
 */

/**
 * Lowercase alphanumeric with internal hyphens, 2-80 chars, no leading or
 * trailing hyphen. MUST MATCH the `affiliate_link_slug_format` CHECK
 * constraint in the migration byte-for-byte — this is the friendly 400 in
 * front of that constraint, not a replacement for it.
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Every existing top-level storefront route segment, plus both locale
 * prefixes (`/en` collides with the English locale route exactly as a
 * same-named slug would). Checked case-insensitively in the service — a
 * partner slug that only differs in case from a real route is exactly as
 * broken as an exact match, and Postgres's `citext`-free `VARCHAR` unique
 * index would not catch it.
 *
 * `apps/storefront/src/app/[locale]` is the source of truth for this list.
 * A new top-level storefront route must be added here in the same commit.
 */
export const RESERVED_PARTNER_SLUGS: readonly string[] = [
  "affiliate",
  "blog",
  "bundles",
  "cart",
  "checkout",
  "contact",
  "faq",
  "privacy",
  "products",
  "shipping-returns",
  "sign-in",
  "sign-up",
  "terms",
  "verify-email",
  "en",
  "es",
];

export const createAffiliateLinkSchema = z
  .object({
    slug: z.string().trim().toLowerCase().min(2).max(80).regex(SLUG_PATTERN),
  })
  .strict();

export type CreateAffiliateLinkDto = z.infer<typeof createAffiliateLinkSchema>;

/**
 * The slug as it arrives in a visitor's URL — lower-cased before lookup so a
 * miscased link someone typed or retyped by hand still resolves. Bounded the
 * same as the stored value, but NOT regex-validated: an out-of-shape slug is
 * simply a lookup miss (404), the same outcome a valid-but-unknown one gets —
 * validating it here would only add a second way to say "not found".
 */
export const partnerLinkSlugParamSchema = z.string().trim().toLowerCase().min(1).max(80);

export const listAffiliateLinksQuerySchema = z
  .object({
    includeDeleted: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default("false"),
  })
  .strict();

export type ListAffiliateLinksQuery = z.infer<typeof listAffiliateLinksQuerySchema>;

/**
 * `clickCount` is a live `COUNT(*)` over `AffiliateLinkClick`, never a stored
 * counter — the same append-only-log convention `Affiliate`'s own
 * redemption/revenue figures follow, for the same reason: a count query is
 * the source of truth, nothing to keep in sync.
 */
export interface AdminAffiliateLink {
  readonly id: string;
  readonly affiliateId: string;
  readonly slug: string;
  readonly clickCount: number;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}
