import type {
  EmailStatus,
  JobState,
  OrderStatus,
  PaymentStatus,
  ProductStatus,
  ReturnStatus,
  Role,
  ShipmentStatus,
} from "@akai/contracts";
import type { DiscountState } from "@/lib/admin/discount-display";
import type { StockState } from "@/lib/admin/inventory-display";

/**
 * THE status vocabulary — one tone table and one message key for every badged
 * value in the dashboard.
 *
 * It replaces six ad-hoc tone maps that had drifted into disagreement:
 * the admin primitives module had one palette, `account/status-badge.tsx` had another
 * with three hardcoded hex values, and `order-status.ts`, `email-display.ts`,
 * `job-display.ts`, `discount-display.ts` and `inventory-display.ts` each
 * carried a partial copy. A PAID order was one green in the account area and a
 * different green in admin, and nothing in the build could see it.
 *
 * KEYED ON (DOMAIN, MEMBER), NEVER ON THE MEMBER ALONE. Four names collide
 * across the enums and they do not mean the same thing:
 *
 *   PENDING    order (nothing has happened yet) vs shipment (not handed over
 *              to the carrier) vs job (waiting for its next attempt)
 *   CANCELLED  order (the whole order is off) vs payment (one attempt died and
 *              the order behind it is untouched)
 *   FAILED     order (terminal) vs payment (a retryable attempt) vs email (our
 *              own send erroring, also retryable)
 *   DELIVERED  order and shipment (the parcel) vs email (the message)
 *
 * A single flat map cannot express that, which is why `Badge` takes a REQUIRED
 * `domain` prop and reads through here rather than looking a bare value up.
 *
 * TOTALITY IS THE POINT. Every domain is a `Record` over its closed union, so
 * adding a member to a contract enum is a COMPILE ERROR here until it is given
 * a tone — not a badge that silently renders unstyled next to money.
 *
 * The message half lives in `messages/{es,en}.json` under `status.<domain>`,
 * reached through `messageKey`. Colour is never the only signal: every badge
 * carries its translated label (WCAG 1.4.1).
 */

/**
 * The six tones. Note the rename from the superseded admin primitives
 * `Tone`, which was `neutral | progress | positive | warning | danger`:
 * `positive` is spelled `success` here, matching the `--success-*` token
 * family, and `attention` is new.
 *
 *   neutral    nothing is happening and nothing is wrong
 *   progress   in flight; it will move on its own
 *   success    the good terminal outcome
 *   warning    someone has to do something, eventually
 *   danger     the bad terminal outcome, or money that went the wrong way
 *   attention  an operator must rule on this NOW — see the cap below
 */
export type BadgeTone =
  | "neutral"
  | "progress"
  | "success"
  | "warning"
  | "danger"
  | "attention";

/** Whether a customer has confirmed their email address. Derived from `emailVerifiedAt`. */
export type EmailVerificationState = "verified" | "unverified";

/**
 * Who can read a timeline entry. Not an enum — the wire carries a boolean
 * `isInternal` — but it is badged, so it needs a tone and a label like anything
 * else. It exists so an operator note is distinguishable BY TEXT and not by the
 * warning tint alone.
 */
export type NoteVisibility = "internal" | "customer";

/**
 * The twelve badged vocabularies. Eight are contract enums; `discount` and
 * `stock` are DERIVED unions whose resolvers stay beside the pages that compute
 * them (`resolveState`, `resolveStockState`) — the type is imported rather than
 * redeclared so there is still one definition of each; `emailVerification` and
 * `internalNote` are display-only pairs with no enum behind them at all.
 */
export type StatusVocabulary = {
  readonly order: Readonly<Record<OrderStatus, BadgeTone>>;
  readonly payment: Readonly<Record<PaymentStatus, BadgeTone>>;
  readonly shipment: Readonly<Record<ShipmentStatus, BadgeTone>>;
  readonly return: Readonly<Record<ReturnStatus, BadgeTone>>;
  readonly email: Readonly<Record<EmailStatus, BadgeTone>>;
  readonly job: Readonly<Record<JobState, BadgeTone>>;
  readonly product: Readonly<Record<ProductStatus, BadgeTone>>;
  readonly role: Readonly<Record<Role, BadgeTone>>;
  readonly discount: Readonly<Record<DiscountState, BadgeTone>>;
  readonly stock: Readonly<Record<StockState, BadgeTone>>;
  readonly emailVerification: Readonly<Record<EmailVerificationState, BadgeTone>>;
  readonly internalNote: Readonly<Record<NoteVisibility, BadgeTone>>;
};

/**
 * ATTENTION IS CAPPED AT TWO ENTRIES, and the cap is asserted in the test
 * beside this file rather than left as a convention.
 *
 * The tone is a solid red fill with a warning glyph — it is the loudest thing
 * the dashboard can draw, and it earns that only where an operator must make a
 * decision that nothing automated will make for them:
 *
 *   order.PAYMENT_MISMATCH  the provider settled an amount that is not ours.
 *                           Money may already have moved. The order is frozen
 *                           and only a human takes it out — the state machine
 *                           refuses PAID from any automated path.
 *   stock.out               a tracked, no-backorder variant at zero available.
 *                           On an ACTIVE product this is a listing customers
 *                           can reach and cannot buy; the products and
 *                           inventory tables additionally gate the ROW rail on
 *                           ACTIVE, because an archived product's zero stock is
 *                           nobody's problem.
 *
 * A third case has to be argued on its own merits, because a third one makes
 * all three read as decoration.
 */
export const STATUS_TONE: StatusVocabulary = {
  order: {
    PENDING: "neutral",
    AWAITING_PAYMENT: "warning",
    PAID: "success",
    PAYMENT_MISMATCH: "attention",
    FULFILLING: "progress",
    SHIPPED: "progress",
    DELIVERED: "success",
    CANCELLED: "neutral",
    REFUNDED: "danger",
    PARTIALLY_REFUNDED: "warning",
    FAILED: "danger",
  },
  payment: {
    REQUIRES_PAYMENT_METHOD: "warning",
    REQUIRES_ACTION: "warning",
    PROCESSING: "progress",
    SUCCEEDED: "success",
    FAILED: "danger",
    // `neutral`, unlike order.CANCELLED's twin: a cancelled ATTEMPT is routine
    // — the customer closed the tab — and the order behind it is untouched.
    CANCELLED: "neutral",
  },
  shipment: {
    PENDING: "neutral",
    // Sendcloud states (spec 2026-09-24-sendcloud-shipping §3.7). A bought
    // label the carrier has not scanned is still waiting on us: neutral.
    LABEL_CREATED: "neutral",
    IN_TRANSIT: "progress",
    // At the pickup point — moving, but now waiting on the CUSTOMER.
    AWAITING_PICKUP: "progress",
    DELIVERED: "success",
    RETURNED: "warning",
    // A carrier problem an operator should look at, but not the solid-red
    // `attention` tone: that is capped at two entries (see above), and a
    // parcel exception is recoverable in the ordinary course.
    EXCEPTION: "warning",
    // Label announcement refused — no parcel exists; retry or ship by hand.
    FAILED: "danger",
    LOST: "danger",
    // A cancelled (credited) label — routine, like payment.CANCELLED.
    CANCELLED: "neutral",
  },
  return: {
    // The operator, not the customer, owes the next move — but nothing is wrong
    // yet, so this is the same neutral an unstarted order gets.
    REQUESTED: "neutral",
    APPROVED: "progress",
    REJECTED: "danger",
    IN_TRANSIT: "progress",
    // Received but not yet refunded: the customer is still owed money, so this
    // is in flight rather than done.
    RECEIVED: "progress",
    REFUNDED: "success",
  },
  email: {
    QUEUED: "neutral",
    SENT: "progress",
    DELIVERED: "success",
    // BOUNCED and COMPLAINED are `danger` and FAILED is only `warning`, and the
    // asymmetry is deliberate: a complaint is a spam report that damages
    // sending reputation for every other customer, and a hard bounce usually
    // means the address is dead. FAILED is our own send erroring, and retries.
    BOUNCED: "danger",
    COMPLAINED: "danger",
    FAILED: "warning",
  },
  job: {
    PENDING: "neutral",
    // A retrying job may still succeed unattended; a dead one never will —
    // nothing drains it again without an operator.
    RETRYING: "warning",
    DEAD: "danger",
    PROCESSED: "success",
  },
  product: {
    DRAFT: "neutral",
    ACTIVE: "success",
    // Neutral, not danger: ARCHIVED is the intended end of a product's life and
    // is never deleted, because orders and invoices reference it forever.
    ARCHIVED: "neutral",
  },
  role: {
    CUSTOMER: "neutral",
    STAFF: "progress",
    ADMIN: "progress",
    PARTNER: "neutral",
  },
  discount: {
    ACTIVE: "success",
    SCHEDULED: "progress",
    EXPIRED: "neutral",
    EXHAUSTED: "warning",
    ARCHIVED: "danger",
  },
  stock: {
    // `danger` rather than a stock level, and ranked above the numeric states
    // by `resolveStockState` for the same reason: a variant with no inventory
    // record reads as sold out, but sold out is fixed by restocking and this is
    // fixed by creating the record.
    untracked: "danger",
    out: "attention",
    low: "warning",
    backorder: "progress",
    ok: "success",
  },
  emailVerification: {
    verified: "success",
    // `warning`, not `neutral`: an unverified address means transactional mail
    // may never arrive, and the customer can fix it in one click.
    unverified: "warning",
  },
  internalNote: {
    internal: "warning",
    customer: "neutral",
  },
};

/** The twelve domain names. */
export type StatusDomain = keyof StatusVocabulary;

/** The members of one domain — `StatusMember<"order">` is `OrderStatus`. */
export type StatusMember<D extends StatusDomain> = Extract<
  keyof StatusVocabulary[D],
  string
>;

/**
 * The catalogue path for a status label: `status.order.PAID`.
 *
 * Built here rather than at each call site so the namespace and the domain
 * cannot drift apart — and so a badge rendered with the wrong domain is a
 * TYPE error rather than a raw key path printed beside a euro figure, which is
 * what a missing translation renders as (there is no `IntlMessages`
 * augmentation in this app, so `t()` keys are otherwise unchecked).
 */
export function messageKey<D extends StatusDomain>(
  domain: D,
  member: StatusMember<D>,
): string {
  return `status.${domain}.${member}`;
}

/**
 * Flattened `<domain>.<member>` → tone, built once at module load.
 *
 * A `Map` rather than nested property access because the lookup key is an
 * untrusted string: indexing a plain object with one reaches `constructor` and
 * `__proto__`, and `Map` has no prototype chain to walk into.
 */
const TONE_LOOKUP: ReadonlyMap<string, BadgeTone> = new Map(
  Object.entries<Readonly<Record<string, BadgeTone>>>(STATUS_TONE).flatMap(
    ([domain, members]) =>
      Object.entries(members).map(
        ([member, tone]): readonly [string, BadgeTone] => [`${domain}.${member}`, tone],
      ),
  ),
);

/**
 * Look a RAW string up against a domain, without throwing.
 *
 * The badge component takes `value: string` because most of its callers hold a
 * value narrowed by a zod parse several frames away, and re-narrowing it at the
 * boundary would mean either a cast (which the repo forbids) or twelve
 * overloads. This does the narrowing once, in one place, and returns `null` for
 * a value that is not a member — so a caller renders a neutral fallback rather
 * than a badge labelled `status.order.undefined`.
 */
export function resolveStatus(
  domain: StatusDomain,
  value: string,
): { readonly tone: BadgeTone; readonly key: string } | null {
  const tone = TONE_LOOKUP.get(`${domain}.${value}`);
  if (tone === undefined) {
    return null;
  }
  return { tone, key: `status.${domain}.${value}` };
}
