import { z } from "zod";
import {
  emailSchema,
  isoDateTimeSchema,
  moneySchema,
  type EmailTemplateKey,
} from "@akai/contracts";

/**
 * TYPED TEMPLATE PAYLOADS.
 *
 * The spec's `SendEmailInput.data` is `Readonly<Record<string, unknown>>` —
 * necessarily so, because the transport port must not know the template
 * vocabulary. That looseness stops HERE: every send in the platform goes
 * through EmailService, which is generic over the template key and accepts only
 * that key's payload. Handing an order-confirmation payload to `verify-email`
 * is a COMPILE error, not a mail with `undefined` in the subject line.
 *
 * The registry below is `satisfies Record<EmailTemplateKey, ...>`, so adding a
 * key to `emailTemplateKeySchema` in @akai/contracts without adding a payload
 * here fails the build. A runtime "unknown template" branch cannot exist,
 * because the compiler proves the map is total.
 *
 * Every schema is `.strict()`: an unknown key is a rejected payload, not a
 * silently-dropped field. That matters more than usual here because payloads
 * are assembled from order aggregates, and a stray `passwordHash` spread into
 * a template context would be rendered into an email and stored at the
 * provider.
 */

/** A single order line as it appears in a customer-facing email. */
const emailOrderLineSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** Variant/size, e.g. "60 caps". Absent for single-variant products. */
    variantName: z.string().max(120).optional(),
    quantity: z.number().int().min(1).max(10_000),
    unitPrice: moneySchema,
    lineTotal: moneySchema,
  })
  .strict();

export type EmailOrderLine = z.infer<typeof emailOrderLineSchema>;

/** Order number in the rendered `AK-YYYY-NNNNNN` form, never the internal UUID. */
const orderNumberSchema = z
  .string()
  .regex(/^AK-\d{4}-\d{6}$/, "Order number must look like AK-2026-000123");

/**
 * Recipient first name.
 *
 * Deliberately permissive on CONTENT (names contain apostrophes, hyphens and
 * every script) and strict on LENGTH. Sanitisation is not attempted here: the
 * renderer escapes structurally, so a name containing `<script>` is safe by
 * construction rather than by a blocklist that will always miss a case.
 */
const firstNameSchema = z.string().min(1).max(120);

/**
 * A link that will be rendered into an `href`.
 *
 * `.url()` alone is NOT enough: zod backs it with `new URL()`, and
 * `new URL("javascript:alert(1)")` parses successfully. Every link in these
 * payloads is built from config + our own ids today, but "today" is exactly the
 * assumption that decays — a return URL echoed from a request would sail
 * through a bare `.url()`. Refined here, and independently re-checked in the
 * renderer's `safeUrl`, so neither layer is load-bearing alone.
 */
const urlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Link must be an http(s) URL" },
  );

export const verifyEmailPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    verifyUrl: urlSchema,
    expiresInHours: z.number().int().min(1).max(168),
  })
  .strict();

export const resetPasswordPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    resetUrl: urlSchema,
    expiresInMinutes: z.number().int().min(1).max(1440),
  })
  .strict();

/**
 * AN EMAILED ONE-TIME SIGN-IN CODE.
 *
 * WHAT IS DELIBERATELY NOT IN HERE, and why:
 *
 *  - No customer id, no email address, no session id. The recipient is already
 *    the `to:`; repeating an identifier inside the body only widens what a
 *    forwarded mail discloses.
 *  - NO SIGN-IN LINK. A one-click link in a sign-in mail is a bearer credential
 *    that survives forwarding, appears in mail-scanner logs and is the single
 *    most phishable thing a store can send. The code is typed into the tab the
 *    customer already has open, so this mail has nothing to click at all — the
 *    renderer emits no anchor, and a test pins that.
 *  - No `codeHash`, no attempt counter, no expiry TIMESTAMP. Only a relative
 *    "expires in N minutes", so the mail carries no absolute clock to correlate
 *    against the `email_otp` row.
 *
 * THE CODE ITSELF IS STILL A LIVE CREDENTIAL WHILE IT LASTS. This payload is
 * written into `outbox_message.payload`, and nothing sweeps that table — see
 * the note in the outbox handler and the follow-up recorded with this change.
 */
export const loginCodePayloadSchema = z
  .object({
    firstName: firstNameSchema,
    /**
     * Six digits, as a STRING. A number would drop a leading zero, and "04815"
     * rendered as "4815" is a code the customer cannot use and cannot diagnose.
     */
    code: z.string().regex(/^\d{6}$/, "A sign-in code is exactly six digits"),
    /** Short by design. The upper bound is a cap on how wrong a producer can be. */
    expiresInMinutes: z.number().int().min(1).max(60),
  })
  .strict();

export const orderConfirmationPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    placedAt: isoDateTimeSchema,
    lines: z.array(emailOrderLineSchema).min(1).max(200),
    subtotal: moneySchema,
    discountTotal: moneySchema,
    shippingTotal: moneySchema,
    taxTotal: moneySchema,
    grandTotal: moneySchema,
    orderUrl: urlSchema,
  })
  .strict();

export const paymentReceiptPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    /** Allocated at PAID only, gap-free (spec §13). Hence required here. */
    invoiceNumber: z.string().min(1).max(40),
    paidAt: isoDateTimeSchema,
    amountPaid: moneySchema,
    /** Card metadata is display-only. A PAN never reaches this process. */
    cardBrand: z.string().max(40).optional(),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),
    invoiceUrl: urlSchema,
  })
  .strict();

export const paymentFailedPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    /**
     * A human-readable decline reason, already mapped from the gateway's
     * `failureCode` by the payments module. Never the raw provider error —
     * those carry internal ids.
     */
    reason: z.string().min(1).max(300),
    retryUrl: urlSchema,
  })
  .strict();

/**
 * ONE PARCEL. Not one order — `Shipment` exists precisely so an order can go out
 * in several, and each one gets its own mail (deduped by shipment id through
 * `email_event.dedupeScope`).
 *
 * TRACKING IS OPTIONAL, AND THAT IS THE LOAD-BEARING DECISION HERE.
 * `shipment.trackingNumber` is nullable because parcels genuinely ship
 * untracked, and `shipment.trackingUrl` is a column nothing currently writes.
 * Required, either one would fail this schema — and a payload that fails its
 * schema is `rejected`, which DEAD-LETTERS rather than degrading. The customer
 * would then hear nothing at all about exactly the parcels that are hardest to
 * chase, while /admin/jobs filled with red for a shipment that was fine.
 *
 * `orderUrl` is REQUIRED in exchange: there is always one working button, so
 * dropping the tracking link costs a link, never the mail.
 *
 * No carrier URL is synthesised from the tracking number. A per-carrier URL
 * template is fulfilment's job, and a link that resolves to the wrong parcel is
 * worse than no link.
 */
/**
 * A pickup point as a mail shows it — the snapshot taken at checkout (spec
 * §3.3), so it is the point the customer chose even if Sendcloud later renames
 * or retires it. Bounds match the `order.servicePoint*` columns.
 */
const emailServicePointSchema = z
  .object({
    name: z.string().min(1).max(120),
    address: z.string().min(1).max(255),
  })
  .strict();

const WEEKDAY = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

/** "HH:MM", exactly as Sendcloud sends a shift boundary. */
const clockTimeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");

/**
 * One day of a pickup point's CURRENT week (Sendcloud returns the actual week,
 * not a template). `shifts: []` = closed that day. Several shifts per day are
 * real (08:00–14:00, 17:00–20:30 — spec §11a G2).
 */
const openingDaySchema = z
  .object({
    day: WEEKDAY,
    shifts: z
      .array(z.object({ start: clockTimeSchema, end: clockTimeSchema }).strict())
      .max(6),
  })
  .strict();

export const shippingConfirmationPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    carrier: z.string().min(1).max(80),
    // 128 TO MATCH THE COLUMN, not 80. `shipment.trackingNumber` is
    // `VarChar(128)` and the create DTO allows the same, so an 81-character
    // number is storable, shippable — and, at max(80), unmailable: the payload
    // is rejected and the row dead-letters after the parcel has gone out. Three
    // bounds on one value must agree, and the column is the one that decides.
    trackingNumber: z.string().min(1).max(128).optional(),
    trackingUrl: urlSchema.optional(),
    shippedAt: isoDateTimeSchema,
    orderUrl: urlSchema,
    /** The contents of THIS parcel, priced by the quantity actually shipped. */
    lines: z.array(emailOrderLineSchema).min(1).max(200),
    /**
     * The pickup point, for an order shipped to one (Sendcloud spec §8): the
     * customer has to know where to go, not just that it moved. Absent for home
     * delivery and for the manual path, which has no point to name.
     */
    servicePoint: emailServicePointSchema.optional(),
  })
  .strict();

/**
 * "Your parcel is waiting for you" — Sendcloud reported AWAITING_CUSTOMER_PICKUP
 * (spec §8, decision D6). ONE PARCEL, deduped by shipment id exactly like
 * `shipping-confirmation`, because it is the moment the customer must act and a
 * second copy teaches them to ignore it.
 *
 * `servicePoint` is OPTIONAL: a home-delivery parcel the carrier could not hand
 * over is also left at a point, and then we have no snapshot to name — the
 * mail still goes, pointing at the carrier's tracking page instead. Opening
 * hours are best-effort (a live read at send time) and simply omitted when that
 * read fails; a mail without hours beats no mail.
 */
export const readyForPickupPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    carrier: z.string().min(1).max(80),
    trackingNumber: z.string().min(1).max(128).optional(),
    trackingUrl: urlSchema.optional(),
    orderUrl: urlSchema,
    servicePoint: emailServicePointSchema.optional(),
    openingHours: z.array(openingDaySchema).min(1).max(7).optional(),
  })
  .strict();

export const deliveryConfirmationPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    deliveredAt: isoDateTimeSchema,
    orderUrl: urlSchema,
  })
  .strict();

export const refundConfirmationPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    refundAmount: moneySchema,
    reason: z.string().min(1).max(300),
    refundedAt: isoDateTimeSchema,
    /** Partial refunds must say so, or the customer reads it as a full one. */
    isPartial: z.boolean(),
  })
  .strict();

export const orderCancelledPayloadSchema = z
  .object({
    firstName: firstNameSchema,
    orderNumber: orderNumberSchema,
    reason: z.string().min(1).max(300),
    cancelledAt: isoDateTimeSchema,
  })
  .strict();

/**
 * Internal alert. Goes to staff, never to a customer, so it may carry the
 * customer's email — which is precisely why it must never be sent with a
 * customer address as the recipient. EmailService cannot enforce that; the
 * orders module supplies the staff address from config.
 */
export const adminNewOrderPayloadSchema = z
  .object({
    orderNumber: orderNumberSchema,
    customerEmail: emailSchema,
    itemCount: z.number().int().min(1).max(10_000),
    grandTotal: moneySchema,
    placedAt: isoDateTimeSchema,
    adminUrl: urlSchema,
  })
  .strict();

export const contactAutoreplyPayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    subject: z.string().min(1).max(300),
    /** Quotable reference so support can find the message without a PII search. */
    referenceId: z.string().min(1).max(64),
  })
  .strict();

/**
 * The STAFF copy of a contact submission.
 *
 * `message` is capped at the same 5000 characters the request schema enforces,
 * so a submission that passed validation can always be rendered — a template
 * with a tighter bound than its producer is a mail that silently fails to send
 * for exactly the long messages someone took the trouble to write.
 */
export const contactReceivedPayloadSchema = z
  .object({
    referenceId: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    /** The submitter's address. Staff reply to it; it is never the `to:`. */
    replyTo: z.string().email().max(254),
    subject: z.string().min(1).max(300),
    message: z.string().min(1).max(5_000),
    submittedAt: z.string().min(1).max(40),
  })
  .strict();

/** Same "quotable reference, nothing else" shape as `contactAutoreplyPayloadSchema`. */
export const affiliateApplicationAutoreplyPayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    referenceId: z.string().min(1).max(64),
  })
  .strict();

/**
 * The STAFF copy of an affiliate application.
 *
 * No `subject`/`message` fields — unlike the contact form, an affiliate
 * application has no free-text body to quote back; every field here is one
 * the applicant actually filled in.
 */
export const affiliateApplicationReceivedPayloadSchema = z
  .object({
    referenceId: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    /** The applicant's address. Staff reply to it; it is never the `to:`. */
    replyTo: z.string().email().max(254),
    country: z.string().length(2),
    socialHandle: z.string().min(1).max(200),
    submittedAt: z.string().min(1).max(40),
  })
  .strict();

/**
 * THE registry. `satisfies` (not an annotation) so each entry keeps its precise
 * schema type for `z.infer` below, while the totality check still runs.
 */
export const EMAIL_TEMPLATE_PAYLOADS = {
  "verify-email": verifyEmailPayloadSchema,
  "reset-password": resetPasswordPayloadSchema,
  "login-code": loginCodePayloadSchema,
  "order-confirmation": orderConfirmationPayloadSchema,
  "payment-receipt": paymentReceiptPayloadSchema,
  "payment-failed": paymentFailedPayloadSchema,
  "shipping-confirmation": shippingConfirmationPayloadSchema,
  "ready-for-pickup": readyForPickupPayloadSchema,
  "delivery-confirmation": deliveryConfirmationPayloadSchema,
  "refund-confirmation": refundConfirmationPayloadSchema,
  "order-cancelled": orderCancelledPayloadSchema,
  "admin-new-order": adminNewOrderPayloadSchema,
  "contact-autoreply": contactAutoreplyPayloadSchema,
  "contact-received": contactReceivedPayloadSchema,
  "affiliate-application-autoreply": affiliateApplicationAutoreplyPayloadSchema,
  "affiliate-application-received": affiliateApplicationReceivedPayloadSchema,
} as const satisfies Record<EmailTemplateKey, z.ZodTypeAny>;

export type EmailTemplateRegistry = typeof EMAIL_TEMPLATE_PAYLOADS;

/** The payload type for one template key. This is what makes sends type-safe. */
export type EmailPayloadFor<K extends EmailTemplateKey> = z.infer<
  EmailTemplateRegistry[K]
>;

/**
 * Templates whose recipient is staff, not a customer.
 *
 * Used by the suppression check: a bounce on a customer address must never
 * silence the internal new-order alert, and an operational alert is not
 * marketing mail that a recipient can opt out of.
 */
export const INTERNAL_TEMPLATE_KEYS: ReadonlySet<EmailTemplateKey> = new Set<
  EmailTemplateKey
>(["admin-new-order", "contact-received", "affiliate-application-received"]);

/**
 * Templates that must reach the recipient even if the address previously
 * bounced, because withholding them breaks account recovery entirely.
 *
 * A suppressed address still blocks marketing and order mail (sending to a hard
 * bounce destroys sender reputation for every other customer), but a password
 * reset the user just requested is different: they are actively waiting for it,
 * and a bounce list entry from six months ago must not lock them out.
 */
export const SUPPRESSION_EXEMPT_TEMPLATE_KEYS: ReadonlySet<EmailTemplateKey> =
  new Set<EmailTemplateKey>(["verify-email", "reset-password", "login-code"]);

/**
 * Templates that fire more than once per order, and what widens their
 * idempotency key.
 *
 * `email_event` is unique on (orderId, templateKey, dedupeScope). The scope
 * defaults to '' — "the whole order" — which is right for every template that
 * fires once. `shipping-confirmation` is the exception: it fires once per
 * PARCEL, so it must carry a shipment id, or the second parcel's claim collides
 * with the first, `send` reports `duplicate`, and the outbox handler counts
 * `duplicate` as terminal SUCCESS. Nothing anywhere records a failure and the
 * customer is never told about parcel two.
 *
 * Membership here makes an unscoped send a LOUD `rejected` instead of that
 * silent swallow. It is enforced in EmailService.send.
 */
export const PER_PARCEL_TEMPLATE_KEYS: ReadonlySet<EmailTemplateKey> =
  new Set<EmailTemplateKey>(["shipping-confirmation", "ready-for-pickup"]);

type PayloadParser<K extends EmailTemplateKey> = (input: unknown) => EmailPayloadFor<K>;

/**
 * Parsers as a MAPPED type rather than a lookup on the schema registry.
 *
 * Going through `EMAIL_TEMPLATE_PAYLOADS[key].parse(...)` for a generic key
 * forces the schema to be widened to `z.ZodTypeAny`, whose `.parse` returns
 * `any` — which would smuggle exactly the type the workspace bans back into the
 * one place every email payload passes through. Each entry below closes over
 * its own concrete schema, so `.parse` returns that schema's precise output and
 * no cast is needed anywhere in the chain.
 */
const PAYLOAD_PARSERS: { [K in EmailTemplateKey]: PayloadParser<K> } = {
  "verify-email": (input) => verifyEmailPayloadSchema.parse(input),
  "reset-password": (input) => resetPasswordPayloadSchema.parse(input),
  "login-code": (input) => loginCodePayloadSchema.parse(input),
  "order-confirmation": (input) => orderConfirmationPayloadSchema.parse(input),
  "payment-receipt": (input) => paymentReceiptPayloadSchema.parse(input),
  "payment-failed": (input) => paymentFailedPayloadSchema.parse(input),
  "shipping-confirmation": (input) => shippingConfirmationPayloadSchema.parse(input),
  "ready-for-pickup": (input) => readyForPickupPayloadSchema.parse(input),
  "delivery-confirmation": (input) => deliveryConfirmationPayloadSchema.parse(input),
  "refund-confirmation": (input) => refundConfirmationPayloadSchema.parse(input),
  "order-cancelled": (input) => orderCancelledPayloadSchema.parse(input),
  "admin-new-order": (input) => adminNewOrderPayloadSchema.parse(input),
  "contact-autoreply": (input) => contactAutoreplyPayloadSchema.parse(input),
  "contact-received": (input) => contactReceivedPayloadSchema.parse(input),
  "affiliate-application-autoreply": (input) =>
    affiliateApplicationAutoreplyPayloadSchema.parse(input),
  "affiliate-application-received": (input) =>
    affiliateApplicationReceivedPayloadSchema.parse(input),
};

/** Parse an untrusted payload against its template's schema. Throws ZodError. */
export function parseTemplatePayload<K extends EmailTemplateKey>(
  templateKey: K,
  payload: unknown,
): EmailPayloadFor<K> {
  const parser: PayloadParser<K> = PAYLOAD_PARSERS[templateKey];
  return parser(payload);
}
