import { z } from "zod";
import { countryCodeSchema, emailSchema } from "./common";

/**
 * Support surfaces that are not commerce: the contact form, the affiliate
 * application form, and cache revalidation.
 *
 * The contact and affiliate forms replace WordPress endpoints. The contact
 * form used to POST to an unauthenticated mu-plugin route that called
 * `wp_mail`; revalidation used to be triggered by a WordPress save hook.
 * Neither had a home on this API, so deleting WordPress deleted the only
 * implementation of each. The affiliate form is genuinely new — see its own
 * doc comment.
 */

/**
 * A contact-form submission.
 *
 * `.strict()`, unlike the storefront route handler's schema it replaces — that
 * one was a plain `z.object`, so an unknown key was silently dropped rather than
 * rejected. Same shape, one word different, and the word is the whole rule.
 *
 * `turnstileToken` is NULLABLE rather than optional so the key is always present
 * on the wire. An optional captcha field is indistinguishable, in a log or a
 * review, from a client that forgot to send one; an explicit `null` is a client
 * saying "I have no token", which is a decision the server can then act on.
 */
export const contactRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    message: z.string().trim().min(1).max(5_000),
    turnstileToken: z.string().max(2_048).nullable().default(null),
  })
  .strict();

export type ContactRequest = z.infer<typeof contactRequestSchema>;

/**
 * Accepted, not delivered.
 *
 * `sent: true` means the submission was durably accepted for delivery. It
 * deliberately does not promise the mail transport succeeded — reporting a
 * transport failure to the submitter would invite them to resubmit into a
 * problem only we can fix, and would leak which addresses our provider rejects.
 */
export const contactResponseSchema = z
  .object({
    sent: z.literal(true),
  })
  .strict();

export type ContactResponse = z.infer<typeof contactResponseSchema>;

/**
 * An affiliate application — §5 of
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`.
 *
 * The exact four fields the request named: name, country, social handle,
 * email. NOT a login and not a customer signup — see the `Affiliate` Prisma
 * model's own doc comment for why this stays a one-time form rather than an
 * account.
 *
 * Same shape as `contactRequestSchema` for the two fields they share
 * (`turnstileToken`'s nullable-with-default reasoning is identical — see that
 * schema's own comment) — this is a second anonymous public write and
 * deliberately gets the same abuse-resistance treatment, not a lighter one.
 */
export const affiliateApplicationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    country: countryCodeSchema,
    socialHandle: z.string().trim().min(1).max(200),
    email: emailSchema,
    turnstileToken: z.string().max(2_048).nullable().default(null),
  })
  .strict();

export type AffiliateApplication = z.infer<typeof affiliateApplicationSchema>;

/** Accepted, not approved — same "durably queued, not a promise" shape as `contactResponseSchema`. */
export const affiliateApplicationResponseSchema = z
  .object({
    received: z.literal(true),
  })
  .strict();

export type AffiliateApplicationResponse = z.infer<typeof affiliateApplicationResponseSchema>;

/**
 * A vanity-link visit's outcome — `POST /partner-links/:slug/visit`.
 *
 * `discountCode` is `null` when the click was recorded but the affiliate has
 * no LIVE coupon right now (none assigned, or every one expired/exhausted) —
 * the visit still counts; there is simply nothing to hand the storefront to
 * auto-apply. See `AffiliateLinksService.resolveVisit`'s own doc comment for
 * exactly what "live" means here.
 */
export const partnerLinkVisitResponseSchema = z
  .object({
    discountCode: z.string().nullable(),
  })
  .strict();

export type PartnerLinkVisitResponse = z.infer<typeof partnerLinkVisitResponseSchema>;

/**
 * Storefront ISR cache tags to invalidate.
 *
 * The API is the CALLER of the storefront's `/api/revalidate`, not the receiver,
 * so this schema describes an OUTBOUND body. It lives in contracts anyway
 * because the storefront route handler validates the exact same shape on the way
 * in, and two hand-written copies of a signed payload's shape is how a signature
 * ends up covering bytes that no longer parse.
 */
export const revalidateRequestSchema = z
  .object({
    tags: z.array(z.string().min(1).max(128)).min(1).max(50),
  })
  .strict();

export type RevalidateRequest = z.infer<typeof revalidateRequestSchema>;

/**
 * Header carrying the HMAC-SHA256 (hex) of the RAW revalidation body.
 *
 * A header, not a `?secret=` query parameter: a secret in a URL lands in access
 * logs, in `Referer`, and in every proxy's request line. Exported so the signer
 * (this API) and the verifier (the storefront route handler) cannot disagree
 * about the name.
 */
export const REVALIDATE_SIGNATURE_HEADER = "x-akai-revalidate-signature";

/** Cache tag covering every catalog-derived page on the storefront. */
export const REVALIDATE_TAG_PRODUCTS = "products";

/** Cache tag covering category navigation and filter surfaces. */
export const REVALIDATE_TAG_CATEGORIES = "categories";

/**
 * Cache tag covering every blog surface: the home page's "latest posts"
 * section, `/blog`, each `/blog/[slug]` page and the sitemap's post entries.
 * Enqueued by the API on every blog publish, unpublish, update and delete.
 */
export const REVALIDATE_TAG_BLOG = "blog";

/**
 * The site-wide admin settings — today, exactly one field.
 *
 * `GET /v1/site-settings` (public, throttled — the storefront's own middleware
 * is the caller, and it has no session to prove) and `PATCH /admin/site-settings`
 * (STAFF/ADMIN) share this shape; see
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md` §2. Grows a
 * new field per future admin-togglable setting rather than a second schema —
 * one row, one shape, same as the `SiteSettings` table it mirrors.
 */
export const siteSettingsSchema = z
  .object({
    maintenanceMode: z.boolean(),
  })
  .strict();

export type SiteSettings = z.infer<typeof siteSettingsSchema>;

/** The admin write — identical shape today, kept as its own type so the two can diverge without a caller silently accepting a field it should not. */
export const updateSiteSettingsSchema = siteSettingsSchema;

export type UpdateSiteSettings = z.infer<typeof updateSiteSettingsSchema>;
