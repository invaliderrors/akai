import type {
  CurrencyCode,
  IdentityDocumentType,
  Locale,
  Minor,
  OrderStatus,
  PaymentStatus,
} from "@akai/contracts";

/**
 * The persistence port for everything this module reads and writes.
 *
 * WHY A PORT AND NOT `PrismaService` DIRECTLY: the services below contain the
 * rules that decide whether money is accepted — the settlement check, order
 * state transitions, event idempotency. Those rules must be unit-testable
 * without a database, and a `PrismaClient` test double cannot be built without
 * `as unknown as PrismaClient`, which the engineering rules forbid.
 *
 * The shapes here are DOMAIN snapshots, not Prisma row types, and money crosses
 * this boundary already branded as `Minor` — the conversion from a raw Postgres
 * `Int` happens once, in the adapter.
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
}

/**
 * What the hosted checkout is pre-filled with: the payer and the shipping
 * snapshot, exactly as the order stored them at checkout. Read separately from
 * `OrderSnapshot` because only `startCheckout` needs it.
 */
export interface OrderCheckoutDetails {
  readonly billingName: string;
  readonly billingPhone: string | null;
  readonly documentType: IdentityDocumentType;
  readonly documentNumber: string;
  readonly shipping: {
    readonly name: string;
    readonly line1: string;
    readonly line2: string | null;
    readonly city: string;
    readonly region: string;
    readonly postalCode: string | null;
    readonly countryCode: string;
    readonly phone: string | null;
  };
}

/**
 * NO `invoiceNumber` ON THIS SNAPSHOT, deliberately: "read the number, then
 * allocate if it was null" is a read-then-write across the transaction
 * boundary, and `markOrderPaid` exists to do the check and the allocation
 * together under one row lock inside the database.
 */

export interface OrderLineSnapshot {
  readonly id: string;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly imageUrl: string | null;
  readonly quantity: number;
  /** IVA-INCLUSIVE unit price. Consumer prices are displayed gross. */
  readonly unitPriceGross: Minor;
  readonly lineTotalGross: Minor;
  /**
   * The IVA contained in `lineTotalGross`. Carried so the payment path can
   * separate the order's line tax from its SHIPPING tax: `taxTotal` bundles
   * both, and shipping is stored NET.
   */
  readonly taxAmount: Minor;
}

export interface PaymentSnapshot {
  readonly id: string;
  readonly orderId: string;
  readonly status: PaymentStatus;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly providerReference: string | null;
  readonly providerPaymentId: string | null;
}

/** A Wompi transaction the sweep should ask about again. */
export interface StalledTransaction {
  readonly transactionId: string;
  readonly orderNumber: string;
}

// ---------------------------------------------------------------------------
// Write models
// ---------------------------------------------------------------------------

export interface RecordPaymentAttemptInput {
  readonly orderId: string;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly status: PaymentStatus;
  /** The Wompi `reference` this attempt was sent to checkout with. */
  readonly providerReference: string;
}

/**
 * One Wompi transaction's state, written into the payment ledger.
 *
 * KEYED ON THE TRANSACTION ID, and resolved in this order (see the adapter):
 *   1. a row that already carries this transaction id is updated;
 *   2. otherwise the attempt row for this reference that has no transaction yet
 *      is CLAIMED — `startCheckout` wrote it before Wompi minted an id;
 *   3. otherwise (a second transaction under one reference — a decline, then a
 *      retry) a new row is inserted, when there is an amount to give it.
 */
export interface RecordTransactionInput {
  readonly orderId: string;
  readonly providerReference: string;
  readonly providerPaymentId: string;
  readonly status: PaymentStatus;
  /**
   * The amount WOMPI REPORTED, when it is a valid amount in a currency we
   * recognise — the evidence an operator reconciles a mismatch against. `null`
   * keeps the attempt's own figure, and skips the insert in case 3: a ledger
   * row must never carry a number we invented.
   */
  readonly reported: { readonly amount: Minor; readonly currency: CurrencyCode } | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly capturedAt: Date | null;
}

/**
 * The write surface available INSIDE a transaction.
 *
 * Reads are included because a settlement must re-read the order under the
 * same transaction it mutates it in — reading outside and writing inside is the
 * race that lets two deliveries both decide the order should be PAID.
 */
export interface PaymentsWriter {
  findOrderById(orderId: string): Promise<OrderSnapshot | null>;
  findOrderByNumber(orderNumber: string): Promise<OrderSnapshot | null>;

  /**
   * The order an inbound Wompi `reference` belongs to, TAKING A ROW LOCK ON IT.
   *
   * THE LOCK IS THE CONTRACT. Every settlement is a read-then-write on
   * `order.status` (read, decide via `isRedundantTransition`, write). The
   * webhook, the return-page confirmation and the sweep can carry the same
   * transaction at once, and the `provider_event` dedupe only collapses
   * IDENTICAL (transaction, status) pairs — an APPROVED and a DECLINED for two
   * transactions of one order race freely. Under READ COMMITTED an unlocked
   * read is a TOCTOU window; the lock serialises them and the second re-reads
   * what the first committed. MUST be called inside a transaction.
   */
  findOrderByPaymentReference(reference: string): Promise<OrderSnapshot | null>;

  /** The order row, locked `FOR UPDATE`. For `startCheckout`'s attempt count. */
  lockOrder(orderId: string): Promise<OrderSnapshot | null>;

  findOrderLines(orderId: string): Promise<readonly OrderLineSnapshot[]>;
  findOrderCheckoutDetails(orderId: string): Promise<OrderCheckoutDetails | null>;

  /** How many checkout attempts (rows with a reference) the order already has. */
  countPaymentAttempts(orderId: string): Promise<number>;

  recordPaymentAttempt(input: RecordPaymentAttemptInput): Promise<PaymentSnapshot>;
  recordTransaction(input: RecordTransactionInput): Promise<void>;

  /**
   * Move an order between states. The CALLER is responsible for having asserted
   * the transition is legal (see OrderStatePort) — this is the dumb write.
   */
  setOrderStatus(orderId: string, status: OrderStatus): Promise<void>;

  /**
   * Move the order to PAID **and allocate its invoice number**, in the caller's
   * transaction: IDEMPOTENT (a number only for an order that has none) and
   * TRANSACTIONAL (a rolled-back settlement consumes nothing). Proven against
   * real Postgres in `apps/api-e2e/src/invoice-counter.spec.ts`.
   */
  markOrderPaid(orderId: string, paidAt: Date): Promise<void>;

  /**
   * Convert this order's still-held stock reservations into a SALE, inside the
   * SAME transaction that marks the order PAID. Idempotent: a reservation
   * already released is skipped, so a redelivery can never double-decrement.
   */
  commitReservationsForOrder(orderId: string): Promise<void>;

  /**
   * Release this order's still-held reservations without selling — the payment
   * failed, so the withheld stock returns to available. Idempotent.
   */
  releaseReservationsForOrder(orderId: string): Promise<void>;

  appendOrderEvent(input: {
    readonly orderId: string;
    readonly type: string;
    readonly message: string;
    readonly isInternal: boolean;
  }): Promise<void>;

  /**
   * Transactional outbox. Enqueued in the SAME transaction as the state change
   * it describes, so an email can never be promised for a payment that rolled
   * back.
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
   * change, so a duplicate hits a primary-key violation and the whole
   * transaction — event row AND state change — rolls back atomically. Strictly
   * stronger than a check-then-write, which races against Wompi's retries.
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

  /**
   * Transactions Wompi last reported PENDING, on orders still AWAITING_PAYMENT,
   * untouched since `olderThan` — what the reconciliation sweep re-asks about.
   */
  findStalledTransactions(olderThan: Date, limit: number): Promise<readonly StalledTransaction[]>;
}

export const PAYMENTS_REPOSITORY = Symbol("PAYMENTS_REPOSITORY");
