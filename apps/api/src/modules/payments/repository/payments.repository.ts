import type {
  CurrencyCode,
  Locale,
  Minor,
  OrderStatus,
  PaymentStatus,
  RefundReason,
  RefundStatus,
} from "@akai/contracts";

/**
 * The persistence port for everything this module reads and writes.
 *
 * WHY A PORT AND NOT `PrismaService` DIRECTLY: the services below contain the
 * rules that decide whether money moves — refund ceilings, order state
 * transitions, webhook idempotency. Those rules must be unit-testable without a
 * database, and a `PrismaClient` test double cannot be built without
 * `as unknown as PrismaClient`, which the engineering rules forbid and which
 * would also silently rot as the schema changes.
 *
 * The shapes here are DOMAIN snapshots, not Prisma row types. That keeps the
 * generated Prisma types from leaking into service signatures, and it means
 * money crosses this boundary already branded as `Minor` — the conversion from
 * a raw Postgres `Int` happens once, in the adapter.
 */

// ---------------------------------------------------------------------------
// JSON — for outbox payloads, without importing Prisma's own Json types.
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Outbox payloads are always objects, never bare scalars. */
export type JsonObject = { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface OrderSnapshot {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly email: string;
  readonly locale: Locale;
  readonly currency: CurrencyCode;
  readonly grandTotal: Minor;
  readonly discountTotal: Minor;
  readonly shippingTotal: Minor;
  readonly taxTotal: Minor;
  readonly refundedTotal: Minor;
  /**
   * The `ch_…` checkout configuration this order was sent to. Correlation
   * rank 2, persisted before the customer reaches the payment page so it cannot
   * lose a race with the webhook that settles the order.
   */
  readonly providerCheckoutId: string | null;
}

/**
 * NO `invoiceNumber` ON THIS SNAPSHOT, deliberately.
 *
 * It was carried here so a caller could tell an order that already has a number
 * from one that does not — but no caller ever did, because that decision cannot
 * safely be made in application code. "Read the number, then allocate if it was
 * null" is a read-then-write across the transaction boundary, and the whole
 * point of `markOrderPaid` is that the check and the allocation happen together
 * under one row lock inside the database. Exposing the field invited exactly the
 * race the design exists to close, while only ever being read by tests.
 *
 * Everything that genuinely needs the number reads the order row: the receipt
 * handler (`email-outbox.handler`), the account and admin order views. They go
 * through their own repositories, which project it explicitly.
 */

export interface OrderLineSnapshot {
  readonly id: string;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly imageUrl: string | null;
  readonly quantity: number;
  /** VAT-INCLUSIVE unit price. EU consumer prices are displayed gross. */
  readonly unitPriceGross: Minor;
  readonly lineTotalGross: Minor;
  /**
   * The VAT contained in `lineTotalGross`.
   *
   * Carried so the payment path can separate the order's line tax from its
   * SHIPPING tax: `taxTotal` on the order bundles both, and shipping is stored
   * NET, so shipping gross is unrecoverable without it.
   */
  readonly taxAmount: Minor;
}

export interface PaymentSnapshot {
  readonly id: string;
  readonly orderId: string;
  readonly status: PaymentStatus;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly providerPaymentId: string | null;
  readonly providerTransactionId: string | null;
}

/**
 * How an inbound Whop event is matched back to one of our orders.
 *
 * TWO KEYS, resolved in this rank order, first hit wins — down from the previous
 * provider's three plus a backfill rule. That chain existed because nothing in the SDK
 * types proved a CRM webhook carried ANY of our keys, so the design sent three
 * and hoped one survived. Whop documents that a checkout configuration's
 * metadata is copied onto the payments created from it, so rank 1 is our own
 * UUID round-tripped and is always present.
 *
 *   1. `orderId`    — `metadata.order_id`, our own order UUID.
 *   2. `checkoutId` — the `ch_…` configuration, persisted before the customer
 *                     reaches the payment page, so it cannot lose a race with
 *                     the webhook.
 */
export type ProviderOrderReference =
  | { readonly kind: "orderId"; readonly id: string }
  | { readonly kind: "checkoutId"; readonly id: string };

// ---------------------------------------------------------------------------
// Write models
// ---------------------------------------------------------------------------

export interface RecordPaymentAttemptInput {
  readonly orderId: string;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly status: PaymentStatus;
  readonly providerPaymentId: string | null;
}

export interface UpdatePaymentInput {
  readonly providerPaymentId: string;
  /**
   * The order this event correlated to. SCOPES the update: without it the write
   * keys on `providerPaymentId` alone, so an event correlated to order A that
   * carries a `paymentId` belonging to order B would silently mutate B's
   * settlement row. Both id and order must match for the write to land.
   */
  readonly orderId: string;
  readonly status: PaymentStatus;
  readonly providerTransactionId: string | null;
  readonly cardBrand: string | null;
  readonly cardLast4: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly capturedAt: Date | null;
}

/**
 * A settlement row, written by the webhook plane, keyed on the provider payment
 * id.
 *
 * Separate from `RecordPaymentAttemptInput` because the two have different
 * concurrency requirements, not because their fields differ. An ATTEMPT is
 * written once, by us, from `startCheckout`, before a provider payment id
 * exists. A SETTLEMENT is written by whichever of TagadaPay's several
 * settlement events (`payment/succeeded`, `order/paid`, a retry of either)
 * reaches us first — so the write must be insert-OR-update in one statement.
 * `providerPaymentId` is REQUIRED here, unlike on the attempt: it is the key the
 * upsert turns on, and a settlement row without it could never be reconciled
 * against Tagada anyway.
 */
export interface UpsertSettlementPaymentInput {
  readonly orderId: string;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly status: PaymentStatus;
  readonly providerPaymentId: string;
  readonly cardBrand: string | null;
  readonly cardLast4: string | null;
  readonly capturedAt: Date | null;
}

export interface RecordRefundInput {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly reason: RefundReason;
  readonly status: RefundStatus;
  readonly providerRefundId: string | null;
  readonly note: string | null;
  readonly actorId: string | null;
}

export interface RecordDisputeInput {
  readonly orderId: string;
  readonly providerDisputeId: string;
  readonly status: string;
  readonly reason: string;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly evidenceDueBy: Date | null;
  readonly closedAt: Date | null;
}

/**
 * The write surface available INSIDE a transaction.
 *
 * Reads are included because a webhook handler must re-read the order under the
 * same transaction it mutates it in — reading outside and writing inside is
 * exactly the race that lets two out-of-order provider events both decide the
 * order should be PAID.
 */
export interface PaymentsWriter {
  findOrderById(orderId: string): Promise<OrderSnapshot | null>;
  findOrderByNumber(orderNumber: string): Promise<OrderSnapshot | null>;

  /**
   * Correlate an inbound provider event to one of our orders, TAKING A ROW LOCK
   * ON THE MATCH.
   *
   * THE LOCK IS THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. Every webhook
   * handler downstream of this call is a read-then-write: read `order.status`,
   * decide via `isRedundantTransition`, then write. Under Postgres' default READ
   * COMMITTED an unlocked read makes that a TOCTOU window, and a provider walks
   * straight into it: Whop explicitly does NOT guarantee delivery order and
   * retries up to 12 times over ~71 hours, so two deliveries touching one order
   * can be in flight at once with different `webhook-id`s — meaning
   * `provider_event` does not collide and both transactions are free to run.
   * Measured against real Postgres without the lock: both read
   * AWAITING_PAYMENT, both committed, and one order produced two
   * `payment.succeeded` events, two invoice-allocation jobs (two gap-free
   * invoice numbers), two fulfilment jobs and six emails.
   *
   * Locking here rather than in each handler is deliberate: correlation is the
   * ONE place every webhook path passes through, so the lock cannot be forgotten
   * by a handler added later. It serialises concurrent deliveries for the same
   * order and lets the second one re-read the state the first committed, which is
   * what makes `isRedundantTransition` sound rather than merely usually right.
   *
   * MUST therefore be called inside a transaction — outside one the lock is taken
   * and released by the same statement and guarantees nothing. `runOnceForEvent`
   * is the only caller path, and it always transacts.
   */
  findOrderByProviderReference(
    reference: ProviderOrderReference,
  ): Promise<OrderSnapshot | null>;

  findOrderLines(orderId: string): Promise<readonly OrderLineSnapshot[]>;
  findPaymentByProviderId(providerPaymentId: string): Promise<PaymentSnapshot | null>;
  findRefundablePaymentForOrder(orderId: string): Promise<PaymentSnapshot | null>;

  recordPaymentAttempt(input: RecordPaymentAttemptInput): Promise<PaymentSnapshot>;
  updatePaymentByProviderId(input: UpdatePaymentInput): Promise<void>;

  /**
   * Write the settlement row for a provider payment id: INSERT OR UPDATE, in one
   * statement.
   *
   * Replaces a `findPaymentByProviderId` -> `recordPaymentAttempt` check-then-
   * insert that had no lock behind it. Two concurrent settlement events carrying
   * the same `paymentId` both read null, both inserted, and the loser raised
   * P2002 on the `payment.providerPaymentId` unique index — which escaped the
   * webhook transaction as a 500 on an AUTHENTIC, correctly-signed delivery, and
   * a 5xx is exactly the answer that makes the provider retry forever. Observed as
   * `200 {applied}` alongside `500 {Internal server error}` on a concurrent pair.
   *
   * The `amount` is written on INSERT ONLY and never on update: the ledger must
   * keep the figure the FIRST settlement event reported, because on the mismatch
   * path that reported figure is the evidence an operator reconciles against.
   */
  upsertSettlementPayment(input: UpsertSettlementPaymentInput): Promise<void>;

  /**
   * Record the `ch_…` checkout configuration against the order, before the
   * customer is redirected. Correlation rank 2.
   */
  linkCheckoutId(orderId: string, checkoutId: string): Promise<void>;

  /**
   * Move an order between states. The CALLER is responsible for having asserted
   * the transition is legal (see OrderStatePort) — this is the dumb write.
   */
  setOrderStatus(orderId: string, status: OrderStatus): Promise<void>;

  /**
   * Move the order to PAID **and allocate its invoice number**, in the caller's
   * transaction.
   *
   * THE ALLOCATION BELONGS HERE, not in a follow-up job. Gap-free numbering is a
   * legal requirement, so a number may only be consumed by a transaction that
   * actually commits — allocating anywhere else would burn one on a settlement
   * that rolled back, and leave a paid order without a number if the follow-up
   * never ran. That second half was not hypothetical: the only caller of the old
   * `next_invoice_number()` was an OrdersService method with no production
   * caller, so every real paid order kept `invoiceNumber = null`, and
   * `settleOrderPaid`'s `payment-receipt` deferred on every retry until it
   * dead-lettered. The customer never got a receipt.
   *
   * TWO GUARANTEES, AND AN IMPLEMENTATION MAY NOT PROVIDE ONLY THE FIRST:
   *
   *   a. IDEMPOTENT — a number is allocated only for an order that has none, so
   *      a duplicate webhook or a settlement retry neither consumes a second
   *      number nor renumbers an order whose receipt has already gone out.
   *   b. TRANSACTIONAL — a settlement that rolls back consumes NOTHING. This is
   *      the one a Postgres sequence cannot give: `nextval` is deliberately not
   *      rolled back, so the previous `next_invoice_number()` implementation
   *      satisfied (a) and silently violated (b) on every aborted settlement and
   *      on every losing concurrent one.
   *
   * Proven against real Postgres, because neither property can be proven against
   * a fake that was written to model it: see
   * `apps/api-e2e/src/invoice-counter.spec.ts`.
   */
  markOrderPaid(orderId: string, paidAt: Date): Promise<void>;
  addRefundedTotal(orderId: string, delta: Minor): Promise<void>;

  /**
   * Convert this order's still-held stock reservations into a SALE, inside the
   * SAME transaction that marks the order PAID.
   *
   * Decrements `onHand` and `reserved` and writes the append-only SALE ledger
   * entry per reservation. Idempotent by construction: a reservation already
   * released — by a webhook retry, or by the TTL cron — is skipped, so the
   * provider's out-of-order, retried deliveries can never double-decrement
   * stock. This is why the sale is committed HERE, through the writer, and not
   * by calling CatalogModule's ProductInventoryService: that service opens its
   * own transaction, so a webhook rollback would leave stock decremented for an
   * event that never committed. Running it on the writer keeps the stock
   * movement atomic with the PAID transition (spec §4, §9).
   */
  commitReservationsForOrder(orderId: string): Promise<void>;

  /**
   * Release this order's still-held reservations without selling — the payment
   * failed or the order was cancelled, so the withheld stock returns to
   * available. Idempotent via the same `releasedAt` guard.
   */
  releaseReservationsForOrder(orderId: string): Promise<void>;

  recordRefund(input: RecordRefundInput): Promise<void>;
  recordDispute(input: RecordDisputeInput): Promise<void>;

  appendOrderEvent(input: {
    readonly orderId: string;
    readonly type: string;
    readonly message: string;
    readonly isInternal: boolean;
  }): Promise<void>;

  /**
   * Transactional outbox. Enqueued in the SAME transaction as the state change
   * it describes, so an email can never be promised for a payment that rolled
   * back, nor lost because the gateway was slow (spec §9).
   */
  enqueue(topic: string, payload: JsonObject): Promise<void>;
}

/**
 * The full repository: everything a writer can do, plus transaction control.
 */
export interface PaymentsRepository extends PaymentsWriter {
  /**
   * Run `apply` exactly once for a given provider event id.
   *
   * The `provider_event` INSERT happens INSIDE the same transaction as the state
   * change, so a duplicate delivery hits a primary-key violation and the whole
   * transaction — event row AND state change — rolls back atomically. That is
   * strictly stronger than a check-then-write, which races against the vendor's
   * own aggressive retries (spec §9).
   *
   * Whop signs `{webhook-id}.{webhook-timestamp}.{body}` with a 5-minute
   * tolerance, so the transport already closes the replay window this table
   * used to hold alone under the previous provider. It stays load-bearing for a different
   * reason: Whop retries a failed delivery up to 12 times over ~71 hours, so
   * every handler must be idempotent under redelivery and this is what makes it
   * so atomically.
   *
   * THE `derived` FLAG IS GONE, with the fallback it audited. TagadaPay might
   * have supplied no event id, so a content fingerprint had to stand in and the column
   * reported how often that weaker path was live. Whop sends a `webhook-id` on
   * every delivery.
   *
   * @returns `true` if the work ran, `false` if this event was already applied.
   */
  runOnceForEvent(
    event: {
      readonly id: string;
      readonly type: string;
    },
    apply: (tx: PaymentsWriter) => Promise<void>,
  ): Promise<boolean>;

  runInTransaction<T>(apply: (tx: PaymentsWriter) => Promise<T>): Promise<T>;
}

export const PAYMENTS_REPOSITORY = Symbol("PAYMENTS_REPOSITORY");
