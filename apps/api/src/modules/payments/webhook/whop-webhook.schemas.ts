import { z } from "zod";

/**
 * Inbound Whop webhook payloads, validated at the boundary.
 *
 * MUCH SMALLER THAN ITS TAGADAPAY PREDECESSOR, and the deletions are the
 * interesting part. That file had to merge three candidate envelope layouts
 * into one flat view, report when two layers disagreed, and rank three
 * correlation keys — all because the SDK shipped no CRM event type at all and
 * nothing could be proven about what actually arrived. Whop documents one
 * envelope and generates a type per event, so there are no layers to flatten,
 * no conflicts to detect and nothing to guess.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Dot-format event types this system acts on. Everything else is ACKed and ignored. */
export const HANDLED_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "refund.created",
  "refund.updated",
] as const;

export const handledEventTypeSchema = z.enum(HANDLED_EVENT_TYPES);
export type HandledEventType = z.infer<typeof handledEventTypeSchema>;

export function isHandledEventType(type: string): type is HandledEventType {
  return handledEventTypeSchema.safeParse(type).success;
}

// ---------------------------------------------------------------------------
// Prototype-pollution filtering
// ---------------------------------------------------------------------------

/**
 * Keys that may never be read out of an inbound body.
 *
 * A BOUNDARY-INTEGRITY CONTROL, NOT HOUSEKEEPING — it is retained from the
 * TagadaPay integration because the hole it closes was measured, not theorised,
 * and the mechanism is unchanged: verification ends in `JSON.parse`, which
 * creates `__proto__` as an OWN data property, and a spread or `Object.assign`
 * then writes it through `[[Set]]`, invoking the `Object.prototype.__proto__`
 * SETTER and replacing the prototype of the copy. zod reads inherited
 * properties, so fields that came from no declared key parse cleanly and reach
 * the settlement check. The concrete consequence there: a delivery carrying NO
 * amount — which must land in PAYMENT_MISMATCH, because absence is never
 * agreement — could be made to SETTLE by appending a `__proto__` object.
 *
 * Reaching it requires the signing secret, so it is not a forgery vector; it is
 * data of unknown provenance crossing the boundary that exists to stop exactly
 * that. `constructor` and `prototype` carry no such setter and are harmless
 * today; they are filtered alongside because the invariant worth stating is "no
 * inbound key may address the object model", not "no `__proto__`".
 */
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * Copy a value's own, non-forbidden, enumerable keys into a fresh record.
 *
 * PURE AND TOTAL. Takes `unknown`, never throws, returns a plain record.
 * Anything that is not a plain object contributes nothing.
 */
export function sanitiseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  // A widening of a value already proven, on the line above, to be a non-null
  // non-array object. Not an `any`, and it discards no checking — every field
  // read out of the result is read through zod below.
  const source = value as Record<string, unknown>;
  const copied: Record<string, unknown> = {};

  // An explicit own-key loop rather than `{ ...source }`: the spread would copy
  // `__proto__` as an own data property, which is the mechanism described above.
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      continue;
    }

    copied[key] = source[key];
  }

  return copied;
}

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/**
 * Money, as Whop's WEBHOOK plane reports it.
 *
 * ORIGINALLY a bare `number` IN MAJOR UNITS, and the two halves of that
 * sentence were both traps. Whop's REST plane carries an exact decimal string
 * in a `Money` envelope; its webhook plane (`PaymentLegacy`) was documented to
 * carry a plain JSON number. And it is MAJOR units — 49.99, not 4999 — which
 * is the opposite of our integer-minor ledger.
 *
 * 2026-09-16 ADDENDUM, recorded because it was a real production incident, not
 * a theoretical one: a live delivery reported `total` and `refunded_amount` as
 * `Whop.Money` objects (`{amount: string, currency, decimals,
 * display_decimals}` — the shape the REST `Payment` resource uses, per
 * `Payment.d.ts`) instead of the bare number `PaymentLegacy.d.ts` (this SDK's
 * own pinned 1.1.2 types) still declares for the webhook `data` field. Two
 * real orders sat in AWAITING_PAYMENT because of it — `recordUnparsable` did
 * exactly what it is supposed to (one alert, no retry storm), but the
 * `notifications` topic has no consumer yet, so nobody was paged.
 *
 * This is exactly the drift **W13** in the integration contract named in
 * advance: *"Unpinned, Whop may change `PaymentLegacy` under us."* Outbound
 * REST calls pin `Api-Version-Date`; nothing pins the WEBHOOK plane's shape,
 * and Whop's webhook sender moved ahead of what this SDK version's own types
 * (and its public webhook docs page) describe. Refusing the newer shape would
 * leave every future payment stuck exactly like these two, for a difference
 * we can trivially absorb — so this schema now accepts EITHER shape.
 *
 * NORMALIZES TO A STRING, NEVER A NUMBER IN BETWEEN. `Money.amount` is already
 * documented (contract §W8) as the correct, EXACT input to
 * `fromDecimalString` — converting it to a JS number first and back would
 * reintroduce exactly the float round-trip the string format exists to avoid.
 * The legacy bare-number case becomes `String(n)`, which is what every caller
 * already did before this schema owned the conversion.
 *
 * `.finite()` on the number branch matters: `Infinity` and `NaN` do not
 * survive JSON, but a `1e400` literal parses to `Infinity`, and it must not
 * reach the money path.
 *
 * IDEMPOTENT ON PURPOSE: the third union branch accepts an already-normalized
 * string and passes it through unchanged. `verifySettlement` re-parses
 * `event.data.total` through `settlementSchema` a second time — not to
 * reshape it again, but to turn "maybe absent" into "definitely present" (its
 * own doc comment: the ENFORCED presence control) — and by then `event` is
 * already a fully-parsed `WhopEventEnvelope` whose `total` this schema has
 * already normalized to a string once. Without this branch that second parse
 * fails (a string matches neither the number nor the `Money` branch), which
 * is a real regression this caught: every settlement started landing in
 * `AMOUNT_ABSENT` instead of settling.
 */
const whopMoneySchema = z
  .object({
    /** The only field this schema reads. Exact decimal string — see above. */
    amount: z.string().min(1),
  })
  // Vendor-owned shape; `currency`/`decimals`/`display_decimals` ride along
  // unread rather than being asserted, same reasoning as `.strip()`/
  // `.passthrough()` elsewhere in this file.
  .passthrough();

export const reportedAmountSchema = z
  .union([z.number().finite(), whopMoneySchema, z.string().min(1)])
  .transform((value) => {
    if (typeof value === "string") return value;
    return typeof value === "number" ? String(value) : value.amount;
  });

/**
 * Correlation metadata, as we set it on the checkout configuration.
 *
 * BOTH OPTIONAL. Whop documents that a checkout configuration's metadata is
 * copied onto the payments created from it, but a payment created any other way
 * — an operator charging by hand in the dashboard, a subscription we did not
 * originate — carries whatever metadata that flow set, or none. Such an event is
 * `unmatched` and ACKed, never an error.
 */
export const whopMetadataSchema = z
  .object({
    order_id: z.string().min(1).max(128).optional(),
    order_number: z.string().min(1).max(64).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * `.strip()` (zod default) on the payload, NOT `.strict()` — a recorded
 * exception to the "validate every external input" rule, carried over from the
 * TagadaPay contract because the argument is unchanged.
 *
 * `.strict()` exists for OUR request DTOs, where we own the shape and an unknown
 * field is either an attack or a client bug. This payload's shape is owned by
 * Whop, which ships additive fields under a pinned API version. `.strict()` here
 * means the first additive field turns every inbound payment notification into a
 * rejection and stalls every order in AWAITING_PAYMENT — a self-inflicted outage
 * triggered by a change we did not cause and cannot see coming.
 *
 * `.strip()` delivers the property the rule exists to guarantee: NOTHING
 * UNVALIDATED REACHES A HANDLER, because every field a handler reads is one this
 * schema declared and parsed. Unknown keys are dropped at the boundary, not
 * trusted. The visibility `.strict()` would have bought is bought instead by
 * `logUnknownPayloadKeys` in the controller, which warns once per process per
 * unseen key.
 */
export const whopPaymentPayloadSchema = z.object({
  /** `pay_…`. The handle a refund is later issued against. */
  id: z.string().min(1).max(128).optional(),

  /** `ch_…`. Correlation rank 2. */
  checkout_configuration_id: z.string().min(1).max(128).nullish(),

  metadata: whopMetadataSchema.nullish(),

  /**
   * WHAT THE BUYER WAS CHARGED. The settlement check compares this against
   * `order.grandTotal` and nothing else.
   *
   * NEVER `amount_after_fees`, which sits beside it on the same object and is
   * net of Whop's platform fee. Comparing that against our total would mismatch
   * EVERY order — not a subtle bug, but an easy field to reach for.
   */
  total: reportedAmountSchema.nullish(),

  /** Lowercase ISO-4217 on this provider. */
  currency: z.string().length(3).optional(),

  /** CUMULATIVE refunded total, which is what makes refund reconciliation commutative. */
  refunded_amount: reportedAmountSchema.nullish(),

  status: z.string().min(1).max(64).nullish(),
  substatus: z.string().min(1).max(64).optional(),

  failure_message: z.string().min(1).max(500).nullish(),
  decline_code: z.string().min(1).max(64).nullish(),

  paid_at: z.string().min(1).max(64).nullish(),
  created_at: z.string().min(1).max(64).optional(),
});

export type WhopPaymentPayload = z.infer<typeof whopPaymentPayloadSchema>;

/**
 * The envelope Whop wraps every event in.
 *
 * ONE SHAPE, documented and generated per event type — contrast the three
 * candidate layouts the TagadaPay integration had to merge blind. `id` is the
 * envelope's own `msg_…`; the controller prefers the `webhook-id` HEADER for
 * dedupe, because that is the value Whop's own documentation tells integrators
 * to key on and it is covered by the signature.
 */
export const whopEventEnvelopeSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  type: z.string().min(1).max(64),
  /** ISO-8601. When the event happened, per the provider. */
  timestamp: z.string().min(1).max(64).optional(),
  data: whopPaymentPayloadSchema,
});

export type WhopEventEnvelope = z.infer<typeof whopEventEnvelopeSchema>;

/**
 * `payment.succeeded` may only settle an order if these are present.
 *
 * THIS IS THE ENFORCED CONTROL, not a description of one: `verifySettlement`
 * parses through it rather than re-testing `total !== null && currency !==
 * undefined` by hand. A schema that documents a rule nobody executes is worse
 * than no schema — it reads as a guarantee while the real check drifts beside it.
 */
export const settlementSchema = z.object({
  total: reportedAmountSchema,
  currency: z.string().length(3),
});

export type ReportedSettlement = z.infer<typeof settlementSchema>;

/** The payload keys this system knows about. Anything else is vendor drift. */
export const KNOWN_PAYLOAD_KEYS: readonly string[] = Object.keys(
  whopPaymentPayloadSchema.shape,
);
