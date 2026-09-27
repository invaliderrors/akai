import { z } from "zod";

/**
 * Every closed domain vocabulary in the platform.
 *
 * These are the single source of truth: the Prisma enums in libs/db mirror these
 * names exactly, and libs/contracts/src/lib/enums.test.ts pins the members so a
 * schema drift between the DB and the wire cannot land silently.
 */

/**
 * Authorisation role. Re-read from the DB session row on every request — never
 * trusted from a token (spec §8).
 *
 * PARTNER is a referral partner signed into their own restricted view — see
 * `Affiliate.customerId` in the Prisma schema. It is deliberately excluded from
 * `ROLES_REQUIRING_TWO_FACTOR` and `ELEVATED_ROLES` in the API's auth module: a
 * read-one-number account, not a privileged one.
 */
export const roleSchema = z.enum(["CUSTOMER", "STAFF", "ADMIN", "PARTNER"]);
export type Role = z.infer<typeof roleSchema>;

export const addressTypeSchema = z.enum(["SHIPPING", "BILLING"]);
export type AddressType = z.infer<typeof addressTypeSchema>;

/** ARCHIVED is never deleted: orders and invoices reference products forever. */
export const productStatusSchema = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;

/**
 * SIMPLE is every product that exists today. PACK is a product whose own
 * variant is never sold directly — see `productSchema.packComponents`'s own
 * comment for why, and the `ProductPackComponent` Prisma model for the full
 * design.
 */
export const productKindSchema = z.enum(["SIMPLE", "PACK"]);
export type ProductKind = z.infer<typeof productKindSchema>;

/**
 * The physical form a product ships in — the FORMA cell of the storefront's
 * spec table. Closed, so every label a shopper sees is a translated one.
 * Mirrors the Prisma `ProductForm` enum.
 */
export const productFormSchema = z.enum(["LYOPHILIZED", "SOLUTION", "CAPSULE", "OTHER"]);
export type ProductForm = z.infer<typeof productFormSchema>;

/**
 * Order lifecycle. The OrdersModule state machine THROWS on an illegal
 * transition rather than coercing (spec §13) — The provider delivers events out of
 * order, and coercion is how a refunded order silently becomes PAID again.
 */
export const orderStatusSchema = z.enum([
  "PENDING",
  "AWAITING_PAYMENT",
  "PAID",
  /**
   * The payment provider reported a settlement whose amount or currency does
   * NOT match our own recomputed grand total — or reported one without saying
   * what was charged at all, which is never agreement.
   *
   * Deliberately NOT a terminal state and deliberately NOT reachable back to
   * PAID by any automated path: a webhook may put an order here, only a human
   * may take it out.
   */
  "PAYMENT_MISMATCH",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "FAILED",
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/**
 * The legal transition graph. Exported so the domain service, the dashboard's
 * status dropdown and the tests all read the SAME map — three copies of this
 * table drifting apart is a guaranteed production incident.
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  PENDING: ["AWAITING_PAYMENT", "CANCELLED", "FAILED", "PAYMENT_MISMATCH"],
  AWAITING_PAYMENT: ["PAID", "CANCELLED", "FAILED", "PAYMENT_MISMATCH"],
  PAID: ["FULFILLING", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"],
  // Non-terminal and OPERATOR-RESOLVED. Money may well have moved, so every
  // outcome stays reachable — but only by a human. The automated webhook path
  // treats PAYMENT_MISMATCH -> PAID as redundant rather than legal, so a second
  // "succeeded" event can never quietly promote a flagged order.
  //
  // PARTIALLY_REFUNDED IS HERE FOR A SPECIFIC REASON. Refunding is the most
  // likely way an operator resolves a mismatch — the provider took money we did
  // not agree to, so some of it goes back — and that refund is very often
  // partial. Without this edge a FULL refund would succeed and a PARTIAL one
  // would throw IllegalOrderTransitionError *after* the gateway call had already
  // moved the money, leaving a refund at the provider with no ledger row on our
  // side. The transition has to exist before the status can be admitted to
  // REFUNDABLE_STATUSES, and it is what admits it.
  PAYMENT_MISMATCH: [
    "PAID",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
    "CANCELLED",
    "FAILED",
  ],
  // FULFILLING -> PAID exists for ONE caller: cancelling a Sendcloud label
  // (spec 2026-09-24-sendcloud-shipping §3.5). Buying the label moved the order
  // PAID -> FULFILLING without any goods leaving; cancelling it (credited by
  // the carrier) must put the order back where "Generar etiqueta" can see it
  // again. Nothing else walks it: PAID is not operator-assignable
  // (`assertAdminMayAssign`), and the webhook path treats a late settlement on
  // a FULFILLING order as redundant (`isRedundantTransition`) BEFORE asking
  // this table, so the edge cannot be taken by a replayed payment event.
  FULFILLING: ["SHIPPED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED", "PAID"],
  SHIPPED: ["DELIVERED", "REFUNDED", "PARTIALLY_REFUNDED"],
  DELIVERED: ["REFUNDED", "PARTIALLY_REFUNDED"],
  // Terminal states. Nothing leaves them.
  CANCELLED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  FAILED: [],
};

export const paymentStatusSchema = z.enum([
  "REQUIRES_PAYMENT_METHOD",
  "REQUIRES_ACTION",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * The payment providers a `Payment` row can name.
 *
 * BROWSER-REACHABLE, so widening it is a client-visible change. One member is
 * correct: the Stripe adapter is gone, and leaving `STRIPE` here would let a
 * dashboard fixture or an API response carry a value nothing can produce and
 * nothing knows how to refund against.
 */
export const paymentProviderSchema = z.enum(["WHOP"]);
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;

export const refundStatusSchema = z.enum([
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

export const refundReasonSchema = z.enum([
  "REQUESTED_BY_CUSTOMER",
  "DUPLICATE",
  "FRAUDULENT",
  "WITHDRAWAL_RIGHT",
  "DAMAGED",
  "OTHER",
]);
export type RefundReason = z.infer<typeof refundReasonSchema>;

/**
 * PENDING/IN_TRANSIT/DELIVERED/RETURNED/LOST are the manual-fulfilment states.
 * The rest arrived with Sendcloud (spec 2026-09-24-sendcloud-shipping §3.7,
 * §11a G4):
 *  - LABEL_CREATED   — a label was bought; the carrier has not scanned it yet.
 *  - AWAITING_PICKUP — at the pickup point, waiting for the customer.
 *  - CANCELLED       — the label was cancelled (and credited).
 *  - FAILED          — Sendcloud refused the announcement; no label exists.
 *  - EXCEPTION       — the carrier reports a problem a human must look at.
 *
 * Mirrors the Prisma enum; `orders.mapper.ts` holds the compile-time proof.
 */
export const shipmentStatusSchema = z.enum([
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "RETURNED",
  "LOST",
  "LABEL_CREATED",
  "AWAITING_PICKUP",
  "CANCELLED",
  "FAILED",
  "EXCEPTION",
]);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;

/** Who made a shipment: staff by hand, or a label bought through Sendcloud. */
export const shipmentProviderSchema = z.enum(["MANUAL", "SENDCLOUD"]);
export type ShipmentProvider = z.infer<typeof shipmentProviderSchema>;

/**
 * How a shipping rate hands the parcel over. A SERVICE_POINT rate requires the
 * customer to choose a pickup point at checkout.
 */
export const shippingDeliveryTypeSchema = z.enum(["HOME", "SERVICE_POINT"]);
export type ShippingDeliveryType = z.infer<typeof shippingDeliveryTypeSchema>;

/**
 * Why a fulfilment action (pickup-point checkout, a label, a cancel) was
 * refused.
 *
 * A SUB-CODE carried as the error envelope's `reason`, NOT an `ErrorCode` —
 * the same reasoning `translationFailureReasonSchema` records: the closed
 * `errorCodeSchema` is exhausted by `satisfies Record<ErrorCode, …>` maps in
 * both web apps, and the coarse code that is right here (VALIDATION_FAILED /
 * CONFLICT) cannot tell "pick a point" from "that point just closed" from
 * "fulfilment is not set up". The API's error class for these maps each reason
 * to its code; clients branch on the reason against their own message
 * catalogue and never render the message.
 */
export const fulfilmentFailureReasonSchema = z.enum([
  /** The chosen rate is SERVICE_POINT and no `servicePointId` was sent. (VALIDATION_FAILED) */
  "SERVICE_POINT_REQUIRED",
  /** A `servicePointId` was sent for a HOME rate. (VALIDATION_FAILED) */
  "SERVICE_POINT_NOT_ALLOWED",
  /**
   * The point does not exist, is expired, belongs to another carrier or
   * country, or failed Sendcloud's availability check — pick another. (CONFLICT)
   */
  "SERVICE_POINT_UNAVAILABLE",
  /** No SENDCLOUD_* configuration on this deployment. (CONFLICT, 409 — not a 500) */
  "FULFILMENT_NOT_CONFIGURED",
  /** Sendcloud is down, timed out or answered unusably. Retrying may help. (CONFLICT) */
  "VENDOR_UNAVAILABLE",
  /** Sendcloud rejected the request (bad address, weight, option). (CONFLICT) */
  "VENDOR_REJECTED",
  /** The carrier no longer allows cancelling this label (Sendcloud 409). (CONFLICT) */
  "CANCEL_REJECTED",
  /** The shipment has no stored label to download or print. (CONFLICT) */
  "LABEL_NOT_AVAILABLE",
]);
export type FulfilmentFailureReason = z.infer<typeof fulfilmentFailureReasonSchema>;

/**
 * Inventory ledger movement kinds. The ledger is append-only, so the CURRENT
 * stock integer is always reconstructable by replaying these — which is the
 * only way to settle an oversell dispute after the fact.
 */
export const inventoryMovementSchema = z.enum([
  "SALE",
  "RESTOCK",
  "RETURN",
  "ADJUSTMENT",
  "RESERVATION",
  "RESERVATION_RELEASE",
]);
export type InventoryMovement = z.infer<typeof inventoryMovementSchema>;

export const discountTypeSchema = z.enum([
  "PERCENTAGE",
  "FIXED_AMOUNT",
  "FREE_SHIPPING",
]);
export type DiscountType = z.infer<typeof discountTypeSchema>;

/**
 * Why a discount code was refused.
 *
 * The published `ErrorCode` for every one of these is VALIDATION_FAILED, which
 * is right — an unusable code is a bad input — and useless on its own: "spend
 * EUR 10 more" and "that code expired" reach the browser as the same response,
 * so the only honest thing a client can say is "that did not work".
 *
 * This is the sub-code the API attaches as the error envelope's `reason`
 * (`errorEnvelopeSchema`, libs/contracts/src/lib/common.ts). It is an
 * IDENTIFIER a client parses and maps to a translated string; it is never
 * rendered, and it is never the display text.
 *
 * INVALID_CODE stays deliberately coarse — an unknown code and a typo are the
 * same answer, because a distinct "no such code" would let anyone enumerate
 * which codes exist.
 *
 * The API's `DiscountError` imports this type rather than restating the union,
 * so the reasons the server can emit and the reasons a client can branch on
 * cannot drift apart.
 */
/**
 * Machine-readable sub-codes for auth failures that share `FORBIDDEN`.
 *
 * `FORBIDDEN` alone cannot separate "you lack permission" — a dead end — from
 * "your second factor has gone stale", which the admin fixes by signing in
 * again. The API's own comment on `twoFactorRequired()` says the CLIENT MUST act
 * on it; without a sub-code the client has only the English message to go on,
 * and rendering that to an operator is exactly what the platform forbids.
 */
export const authFailureReasonSchema = z.enum([
  /** Session is authenticated but its 2FA proof is older than the step-up window. */
  "TWO_FACTOR_REQUIRED",
  /** Privileged account that has never enrolled a second factor at all. */
  "TWO_FACTOR_ENROLMENT_REQUIRED",
]);

export type AuthFailureReason = z.infer<typeof authFailureReasonSchema>;

export const discountFailureReasonSchema = z.enum([
  "INVALID_CODE",
  "NOT_ACTIVE",
  "EXPIRED",
  "CURRENCY_MISMATCH",
  "BELOW_MINIMUM",
  "USAGE_LIMIT_REACHED",
]);
export type DiscountFailureReason = z.infer<typeof discountFailureReasonSchema>;

/**
 * Why a machine translation did not happen.
 *
 * A SUB-CODE, not an ErrorCode. `errorCodeSchema` is closed and exhausted by
 * `satisfies Record<ErrorCode, string>` maps in both web apps, so widening it
 * for a vendor integration would break every one of those files; and the coarse
 * code that is correct here (CONFLICT) cannot separate "nobody configured a
 * key" from "the quota ran out" from "the vendor is down". Those need three
 * different sentences and three different operator actions, which is exactly
 * what the envelope's `reason` member exists to carry.
 *
 * Rendered NOWHERE. The dashboard branches on these against its own message
 * catalogue; the vendor's own prose never reaches a client at all, because
 * `TranslationFailure` has no field to carry it.
 */
export const translationFailureReasonSchema = z.enum([
  /** No DEEPL_API_KEY on this deployment. The feature is off, not broken. */
  "NOT_CONFIGURED",
  /** The vendor rejected our credential (401/403) — rotate the key. */
  "INVALID_KEY",
  /** The character allowance is spent (DeepL's own 456). Waiting does not fix it. */
  "QUOTA_EXCEEDED",
  /** Too many requests (429). Waiting DOES fix it, which is why it is distinct. */
  "RATE_LIMITED",
  /** The vendor refused the language pair. The only reason a caller can fix. */
  "UNSUPPORTED_LANGUAGE",
  /** 5xx, connection refused, DNS — the vendor is down. */
  "VENDOR_UNAVAILABLE",
  /** Our own deadline elapsed first. Distinct from an outage: it may have been billed. */
  "VENDOR_TIMEOUT",
  /**
   * The response could not be trusted: unparseable, wrong shape, or a different
   * number of translations than texts sent. Never degraded into empty copy —
   * blank text written over a product's other locale is the one genuinely
   * destructive outcome available here.
   */
  "MALFORMED_RESPONSE",
]);
export type TranslationFailureReason = z.infer<typeof translationFailureReasonSchema>;

/**
 * Tax class. Supplements are reduced-rate in some member states and standard in
 * others, so the class is a per-product property, not a global constant.
 * ZERO_RATED covers B2B reverse charge.
 */
export const taxClassSchema = z.enum(["STANDARD", "REDUCED", "ZERO_RATED"]);
export type TaxClass = z.infer<typeof taxClassSchema>;

/** Transactional templates only. Marketing mail is a separate, consent-gated system. */
export const emailTemplateKeySchema = z.enum([
  "verify-email",
  "reset-password",
  /**
   * An emailed one-time sign-in code.
   *
   * Distinct from `verify-email`, which proves an address at registration. This
   * one IS the credential: `customer.passwordHash` is nullable, so an account
   * whose ONLY sign-in route is a mailed code is a real account — which is why
   * this key is suppression-exempt (see SUPPRESSION_EXEMPT_TEMPLATE_KEYS). A
   * hard bounce from six months ago must not lock someone out permanently.
   */
  "login-code",
  "order-confirmation",
  "payment-receipt",
  "payment-failed",
  "shipping-confirmation",
  /**
   * "Your parcel is waiting at the pickup point" — sent once per parcel when
   * Sendcloud reports AWAITING_CUSTOMER_PICKUP (spec 2026-09-24-sendcloud-shipping
   * §8, decision D6). Per-parcel, like `shipping-confirmation`.
   */
  "ready-for-pickup",
  "delivery-confirmation",
  "refund-confirmation",
  "order-cancelled",
  "admin-new-order",
  "contact-autoreply",
  /**
   * The STAFF copy of a contact-form submission.
   *
   * Distinct from `contact-autoreply`, which goes to the person who wrote in.
   * Two keys rather than one template with a flag, because they have different
   * recipients, different suppression rules (an operational alert is not
   * marketing mail a recipient may opt out of) and different content — the staff
   * copy carries the message body and the submitter's address, and must never be
   * renderable to the submitter by a mistaken `to:`.
   */
  "contact-received",
  /** The applicant's acknowledgement of an affiliate application. Same "two keys, two recipients" split as `contact-autoreply`/`contact-received`. */
  "affiliate-application-autoreply",
  /** The STAFF copy of an affiliate application. */
  "affiliate-application-received",
]);
export type EmailTemplateKey = z.infer<typeof emailTemplateKeySchema>;

export const emailStatusSchema = z.enum([
  "QUEUED",
  "SENT",
  "DELIVERED",
  "BOUNCED",
  "COMPLAINED",
  "FAILED",
]);
export type EmailStatus = z.infer<typeof emailStatusSchema>;

export const returnStatusSchema = z.enum([
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "IN_TRANSIT",
  "RECEIVED",
  "REFUNDED",
]);
export type ReturnStatus = z.infer<typeof returnStatusSchema>;
