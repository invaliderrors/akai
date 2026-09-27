import { SetMetadata, type CustomDecorator } from "@nestjs/common";

export const THROTTLE_KEY = "akai:throttle";

/**
 * How hard one named bucket may be hit, per client, per window.
 *
 * `name` is what separates buckets. Without it every throttled route in the API
 * would share one budget keyed on IP alone, so a shopper browsing the catalog
 * would spend the allowance their own checkout is about to need.
 */
export interface ThrottleRule {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * `@Throttle({ name: "catalog", limit: 300, windowMs: 60_000 })`
 *
 * Applies to a handler or a whole controller; the handler wins when both carry
 * one, so a controller can set a generous default and a single expensive route
 * can tighten it.
 */
export const Throttle = (rule: ThrottleRule): CustomDecorator<string> =>
  SetMetadata(THROTTLE_KEY, rule);

// ---------------------------------------------------------------------------
// The standard buckets.
// ---------------------------------------------------------------------------

/**
 * These are declared once, here, rather than as literals at each decorator.
 *
 * Two reasons. A limit written inline is invisible to review — nobody can answer
 * "what are our public rate limits?" without grepping decorators across nine
 * modules. And the numbers are RELATIVE to one another: reads must be far more
 * generous than writes, and writes that create money must be tightest of all.
 * That ordering is only legible when the values sit next to each other, and it
 * is asserted by throttle.decorator.test.ts so a future edit cannot quietly
 * make checkout more permissive than catalog browsing.
 */
const MINUTE_MS = 60_000;

export const THROTTLE_RULES = {
  /**
   * Catalog and category reads. Generous: a storefront home page fans out to
   * several product queries and an ISR revalidation can burst.
   */
  catalogRead: { name: "catalog-read", limit: 300, windowMs: MINUTE_MS },

  /** Cart mutations. A human cannot click 60 times a minute; a script can. */
  cartWrite: { name: "cart-write", limit: 60, windowMs: MINUTE_MS },

  /** Shipping quotes. One per address-form change, plus slack. */
  shippingQuote: { name: "shipping-quote", limit: 60, windowMs: MINUTE_MS },

  /**
   * Checkout. The money-creating POST, and the one place a burst is either a
   * double-submit (handled by idempotency) or an attack.
   */
  checkout: { name: "checkout", limit: 10, windowMs: MINUTE_MS },

  /**
   * Contact form. Tightest of all: it turns an anonymous HTTP request into an
   * outbound email, which is the classic spam-relay shape.
   */
  contact: { name: "contact", limit: 5, windowMs: 15 * MINUTE_MS },

  /**
   * The affiliate application form. IDENTICAL RATE TO `contact`, on purpose —
   * same shape of risk (an anonymous POST that produces two outbound emails)
   * — but its OWN NAME, so a burst against one form never spends the other's
   * budget.
   */
  affiliateApply: { name: "affiliate-apply", limit: 5, windowMs: 15 * MINUTE_MS },

  /**
   * A vanity-link visit (`akai.shop/<partner-slug>`). DELIBERATELY AS
   * GENEROUS AS `catalogRead`, not as tight as `contact`/`affiliateApply` —
   * this route sends no email and moves no money, so the only cost of a
   * burst is a few extra rows in `affiliate_link_click`.
   *
   * It is also, structurally, the ONE bucket here whose key does not mean
   * "one visitor": the caller is the storefront's OWN `[partnerSlug]` route
   * handler (a Next 15 constraint — only a route handler can set the
   * resulting cookie), so every visitor's click is proxied through that
   * server and lands on ONE client IP as far as this API is concerned. A
   * tight limit here would throttle the whole site's vanity-link traffic
   * off one popular link, not one abuser — the same shape of problem
   * `lib/api/contact.ts`'s own comment describes for why `/v1/contact` is
   * never proxied. This route IS proxied, for a reason contact's isn't
   * (the cookie constraint, not a token), so the fix here is a limit sized
   * for "the whole site", not for "don't proxy it".
   */
  partnerLinkVisit: { name: "partner-link-visit", limit: 300, windowMs: MINUTE_MS },
} as const satisfies Readonly<Record<string, ThrottleRule>>;

export type ThrottleBucket = keyof typeof THROTTLE_RULES;
