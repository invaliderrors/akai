import { toMinor } from "@akai/contracts";

import type {
  JsonObject,
  OrderCheckoutDetails,
  OrderLineSnapshot,
  OrderSnapshot,
  PaymentSnapshot,
  PaymentsRepository,
  PaymentsWriter,
  RecordPaymentAttemptInput,
  RecordTransactionInput,
  StalledTransaction,
} from "../repository/payments.repository";

/**
 * In-memory test doubles for the payments persistence port.
 *
 * `FakePaymentsRepository` implements the real `PaymentsRepository`, so it is
 * checked against a real interface — if a signature changes, this stops
 * compiling. That is the whole reason the services depend on a port instead of
 * on `PrismaService` directly: a double for that would need
 * `as unknown as PrismaClient`, which the engineering rules forbid and which
 * would let the fake silently diverge from the thing it stands in for.
 *
 * THIS IS THE ONLY FAKE REPOSITORY IN THE MODULE, and that is deliberate. The
 * checkout/refund lane and the webhook lane were built in parallel and each grew
 * its own — two classes implementing the same port, each modelling a different
 * subset of it. Two fakes for one port is worse than none: a change that breaks
 * an invariant in one can pass every suite that uses the other, and "does the
 * repository behave like this?" acquires two answers. The settlement-specific
 * behaviours (the `provider_event` dedupe ledger, reference correlation, the
 * three-case `recordTransaction`) are modelled HERE, where every suite gets them.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function orderSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  const base: OrderSnapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    orderNumber: "AK-2026-000123",
    status: "PENDING",
    email: "customer@example.com",
    currency: "COP",
    // $ 89.000, IVA-inclusive at 19%: 8_900_000 / 1.19 = 7_478_992 net.
    grandTotal: toMinor(8_900_000),
    discountTotal: toMinor(0),
    shippingTotal: toMinor(0),
    taxTotal: toMinor(1_421_008),
    refundedTotal: toMinor(0),
  };

  return Object.assign({}, base, overrides);
}

export function orderLine(overrides: Partial<OrderLineSnapshot> = {}): OrderLineSnapshot {
  const base: OrderLineSnapshot = {
    id: "22222222-2222-4222-8222-222222222222",
    productName: "Hoodie Kumo",
    variantName: "M",
    sku: "AK-HOOD-M",
    imageUrl: null,
    quantity: 1,
    unitPriceGross: toMinor(8_900_000),
    lineTotalGross: toMinor(8_900_000),
    // The IVA inside $ 89.000 at 19%, so a default line and a default order
    // agree: taxTotal - lineTax leaves shipping untaxed.
    taxAmount: toMinor(1_421_008),
  };

  return Object.assign({}, base, overrides);
}

export function paymentSnapshot(
  overrides: Partial<PaymentSnapshot> = {},
): PaymentSnapshot {
  const base: PaymentSnapshot = {
    id: "33333333-3333-4333-8333-333333333333",
    orderId: "11111111-1111-4111-8111-111111111111",
    status: "REQUIRES_PAYMENT_METHOD",
    amount: toMinor(8_900_000),
    currency: "COP",
    providerReference: "AK-2026-000123-1",
    providerPaymentId: null,
  };

  return Object.assign({}, base, overrides);
}

export function checkoutDetails(
  overrides: Partial<OrderCheckoutDetails> = {},
): OrderCheckoutDetails {
  const base: OrderCheckoutDetails = {
    billingName: "Ana García",
    billingPhone: "3001234567",
    documentType: "CC",
    documentNumber: "1020304050",
    shipping: {
      name: "Ana García",
      line1: "Calle 10 # 43-21",
      line2: null,
      city: "Medellín",
      region: "Antioquia",
      postalCode: null,
      countryCode: "CO",
      phone: "3001234567",
    },
  };

  return Object.assign({}, base, overrides);
}

// ---------------------------------------------------------------------------
// Recorded calls
// ---------------------------------------------------------------------------

export interface RecordedOrderEvent {
  readonly orderId: string;
  readonly type: string;
  readonly message: string;
  readonly isInternal: boolean;
}

export interface RecordedOutbox {
  readonly topic: string;
  readonly payload: JsonObject;
}

/** One accepted `provider_event` row. */
export interface RecordedProviderEvent {
  readonly id: string;
  readonly type: string;
}

interface StateSnapshot {
  readonly orders: Map<string, OrderSnapshot>;
  readonly payments: FakePaymentRow[];
  /** Invoice allocation rolls back with the transaction — see `invoiceNumbersIssued`. */
  readonly invoiceNumbers: Map<string, string>;
  readonly invoiceNumbersIssuedLength: number;
  readonly outboxLength: number;
  readonly eventsLength: number;
  readonly committedReservationsLength: number;
  readonly releasedReservationsLength: number;
}

/** One ledger row as the fake stores it — the snapshot plus what a test asserts on. */
export interface FakePaymentRow extends PaymentSnapshot {
  readonly failureCode: string | null;
  readonly capturedAt: Date | null;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export class FakePaymentsRepository implements PaymentsRepository {
  readonly orders = new Map<string, OrderSnapshot>();
  readonly lines = new Map<string, OrderLineSnapshot[]>();
  readonly details = new Map<string, OrderCheckoutDetails>();
  readonly payments: FakePaymentRow[] = [];

  readonly orderEvents: RecordedOrderEvent[] = [];
  readonly outbox: RecordedOutbox[] = [];
  /** Order ids whose reservations were converted to a sale (commit at PAID). */
  readonly committedReservationOrders: string[] = [];
  /** Order ids whose reservations were released (payment failed / cancelled). */
  readonly releasedReservationOrders: string[] = [];

  /** Every `provider_event` row this fake accepted, in order. */
  readonly providerEvents: RecordedProviderEvent[] = [];
  /** Order ids `lockOrder` / `findOrderByPaymentReference` locked, in order. */
  readonly locks: string[] = [];
  /** What `findStalledTransactions` answers. Tests set it. */
  stalled: StalledTransaction[] = [];
  /** When each order was marked paid — the settlement time the event carried. */
  readonly paidAt = new Map<string, Date>();

  /**
   * The invoice number each order was allocated. Empty until `markOrderPaid`.
   *
   * Held here rather than on `OrderSnapshot` because the snapshot no longer
   * carries the field: reading it in application code is the read-then-write the
   * real design closes by doing the check and the allocation together under one
   * row lock.
   */
  readonly invoiceNumbers = new Map<string, string>();

  /**
   * Every invoice number this fake handed out, in allocation order.
   *
   * It exists so a test can assert what the COUNTER did, not merely what the
   * order ended up carrying: "the order still has its first number" and "no
   * second number was consumed" are different claims, and gap-free numbering is
   * the one that is a legal requirement.
   *
   * ROLLED BACK BY `restore`, and that reverses what this fake used to model. It
   * previously kept issued numbers across a rollback on the grounds that
   * `nextval` is non-transactional — which was an accurate description of a
   * BROKEN implementation. Allocation is now a row update
   * (`allocate_invoice_number()`), so a rolled-back settlement genuinely returns
   * its number to the series, and a fake that kept it would let a test pass
   * against a guarantee the database now does give.
   *
   * WHAT THIS FAKE STILL CANNOT PROVE is that Postgres behaves this way — it
   * models the contract rather than demonstrating it, which is the exact trap the
   * previous attempt fell into. `apps/api-e2e/src/invoice-counter.spec.ts` is
   * where the claim is actually tested, against a real database.
   */
  readonly invoiceNumbersIssued: string[] = [];

  /** How many times a `runOnceForEvent` body actually executed. */
  handlerRuns = 0;

  /** Set to make the next `runInTransaction` body fail AFTER the gateway succeeded. */
  failNextTransaction = false;

  seedOrder(
    order: OrderSnapshot,
    lines: readonly OrderLineSnapshot[] = [],
    details: OrderCheckoutDetails = checkoutDetails(),
  ): void {
    this.orders.set(order.id, order);
    this.lines.set(order.id, [...lines]);
    this.details.set(order.id, details);
  }

  seedPayment(payment: PaymentSnapshot): void {
    this.payments.push({ ...payment, failureCode: null, capturedAt: null });
  }

  /** The seeded order, or a loud test-setup failure. Never silently undefined. */
  order(orderId = "11111111-1111-4111-8111-111111111111"): OrderSnapshot {
    const found = this.orders.get(orderId);
    if (found === undefined) {
      throw new Error(`Test setup error: no seeded order ${orderId}`);
    }
    return found;
  }

  outboxFor(topic: string): readonly RecordedOutbox[] {
    return this.outbox.filter((entry) => entry.topic === topic);
  }

  emailTemplates(): readonly unknown[] {
    return this.outboxFor("email").map((entry) => entry.payload["templateKey"]);
  }

  // --- Reads ---------------------------------------------------------------

  async findOrderById(orderId: string): Promise<OrderSnapshot | null> {
    return this.orders.get(orderId) ?? null;
  }

  async findOrderByNumber(orderNumber: string): Promise<OrderSnapshot | null> {
    for (const order of this.orders.values()) {
      if (order.orderNumber === orderNumber) {
        return order;
      }
    }
    return null;
  }

  async findOrderByPaymentReference(reference: string): Promise<OrderSnapshot | null> {
    const row = this.payments.find((entry) => entry.providerReference === reference);
    if (row === undefined) {
      return null;
    }
    this.locks.push(row.orderId);
    return this.findOrderById(row.orderId);
  }

  async lockOrder(orderId: string): Promise<OrderSnapshot | null> {
    this.locks.push(orderId);
    return this.findOrderById(orderId);
  }

  async findOrderLines(orderId: string): Promise<readonly OrderLineSnapshot[]> {
    return this.lines.get(orderId) ?? [];
  }

  async findOrderCheckoutDetails(orderId: string): Promise<OrderCheckoutDetails | null> {
    return this.details.get(orderId) ?? null;
  }

  async countPaymentAttempts(orderId: string): Promise<number> {
    return this.payments.filter(
      (entry) => entry.orderId === orderId && entry.providerReference !== null,
    ).length;
  }

  /** The ledger row for a transaction id, or a loud test failure. */
  paymentFor(providerPaymentId: string): FakePaymentRow {
    const found = this.payments.find((entry) => entry.providerPaymentId === providerPaymentId);
    if (found === undefined) {
      throw new Error(`Test assertion: no payment row for ${providerPaymentId}`);
    }
    return found;
  }

  // --- Writes --------------------------------------------------------------

  async recordPaymentAttempt(input: RecordPaymentAttemptInput): Promise<PaymentSnapshot> {
    const payment: FakePaymentRow = {
      id: `pay_${this.payments.length + 1}`,
      orderId: input.orderId,
      status: input.status,
      amount: input.amount,
      currency: input.currency,
      providerReference: input.providerReference,
      providerPaymentId: null,
      failureCode: null,
      capturedAt: null,
    };

    this.payments.push(payment);
    return payment;
  }

  /** Mirrors the adapter's three cases, in the same order. */
  async recordTransaction(input: RecordTransactionInput): Promise<void> {
    const state = {
      status: input.status,
      failureCode: input.failureCode,
      capturedAt: input.capturedAt,
    };

    const existing = this.payments.findIndex(
      (entry) => entry.providerPaymentId === input.providerPaymentId,
    );
    const existingRow = this.payments[existing];
    if (existingRow !== undefined) {
      if (existingRow.orderId === input.orderId) {
        this.payments[existing] = { ...existingRow, ...state };
      }
      return;
    }

    const attempt = this.payments.findIndex(
      (entry) =>
        entry.orderId === input.orderId &&
        entry.providerReference === input.providerReference &&
        entry.providerPaymentId === null,
    );
    const attemptRow = this.payments[attempt];
    if (attemptRow !== undefined) {
      this.payments[attempt] = {
        ...attemptRow,
        ...state,
        providerPaymentId: input.providerPaymentId,
        ...(input.reported === null
          ? {}
          : { amount: input.reported.amount, currency: input.reported.currency }),
      };
      return;
    }

    if (input.reported === null || input.reported.amount <= 0) {
      return;
    }

    this.payments.push({
      ...state,
      id: `pay_${this.payments.length + 1}`,
      orderId: input.orderId,
      amount: input.reported.amount,
      currency: input.reported.currency,
      providerReference: input.providerReference,
      providerPaymentId: input.providerPaymentId,
    });
  }

  async setOrderStatus(orderId: string, status: OrderSnapshot["status"]): Promise<void> {
    this.mutateOrder(orderId, { status });
  }

  /**
   * PAID, and the invoice number that legally goes with it, in one step. The
   * allocation is conditional, mirroring the adapter's check-under-lock.
   */
  async markOrderPaid(orderId: string, paidAt: Date): Promise<void> {
    this.paidAt.set(orderId, paidAt);

    const order = this.orders.get(orderId);
    if (order === undefined || this.invoiceNumbers.has(orderId)) {
      this.mutateOrder(orderId, { status: "PAID" });
      return;
    }

    const sequence = String(this.invoiceNumbersIssued.length + 1).padStart(6, "0");
    const invoiceNumber = `INV-${String(paidAt.getUTCFullYear())}-${sequence}`;
    this.invoiceNumbersIssued.push(invoiceNumber);
    this.invoiceNumbers.set(orderId, invoiceNumber);

    this.mutateOrder(orderId, { status: "PAID" });
  }

  /** The number allocated to an order, or null if it has none. */
  invoiceNumberFor(orderId: string): string | null {
    return this.invoiceNumbers.get(orderId) ?? null;
  }

  async commitReservationsForOrder(orderId: string): Promise<void> {
    this.committedReservationOrders.push(orderId);
  }

  async releaseReservationsForOrder(orderId: string): Promise<void> {
    this.releasedReservationOrders.push(orderId);
  }

  async appendOrderEvent(input: RecordedOrderEvent): Promise<void> {
    this.orderEvents.push(input);
  }

  async enqueue(topic: string, payload: JsonObject): Promise<void> {
    this.outbox.push({ topic, payload });
  }

  async findStalledTransactions(
    _olderThan: Date,
    limit: number,
  ): Promise<readonly StalledTransaction[]> {
    return this.stalled.slice(0, limit);
  }

  // --- Transactions --------------------------------------------------------

  /**
   * Models the real thing faithfully enough to test BOTH properties that matter.
   *
   * Insert-first-then-run, so a duplicate id short-circuits before the handler
   * can touch anything — the ordering a primary-key violation gives. And if the
   * handler throws, the event row AND every write it made roll back together,
   * which is what the single-transaction design buys in production.
   *
   * What it CANNOT prove is that Postgres actually behaves this way under
   * concurrency; that is what `apps/api-e2e/src/wompi-webhook.spec.ts` is for.
   */
  async runOnceForEvent(
    event: { readonly id: string; readonly type: string },
    apply: (tx: PaymentsWriter) => Promise<void>,
  ): Promise<boolean> {
    if (this.providerEvents.some((entry) => entry.id === event.id)) {
      return false;
    }

    this.providerEvents.push({ ...event });
    const snapshot = this.snapshot();
    this.handlerRuns += 1;

    try {
      await apply(this);
    } catch (error) {
      this.restore(snapshot);
      this.providerEvents.pop();
      this.handlerRuns -= 1;
      throw error;
    }

    return true;
  }

  async runInTransaction<T>(apply: (tx: PaymentsWriter) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();

    try {
      const result = await apply(this);
      if (this.failNextTransaction) {
        this.failNextTransaction = false;
        throw new Error("Simulated commit failure");
      }
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  // --- Internals -----------------------------------------------------------

  private mutateOrder(orderId: string, patch: Partial<OrderSnapshot>): void {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      return;
    }
    this.orders.set(orderId, Object.assign({}, order, patch));
  }

  private snapshot(): StateSnapshot {
    return {
      orders: new Map(this.orders),
      payments: [...this.payments],
      invoiceNumbers: new Map(this.invoiceNumbers),
      invoiceNumbersIssuedLength: this.invoiceNumbersIssued.length,
      outboxLength: this.outbox.length,
      eventsLength: this.orderEvents.length,
      committedReservationsLength: this.committedReservationOrders.length,
      releasedReservationsLength: this.releasedReservationOrders.length,
    };
  }

  private restore(snapshot: StateSnapshot): void {
    this.orders.clear();
    for (const [id, order] of snapshot.orders) {
      this.orders.set(id, order);
    }
    this.payments.length = 0;
    this.payments.push(...snapshot.payments);
    // The counter is a ROW, so a rolled-back settlement returns its number to
    // the series rather than burning it.
    this.invoiceNumbers.clear();
    for (const [id, number] of snapshot.invoiceNumbers) {
      this.invoiceNumbers.set(id, number);
    }
    this.invoiceNumbersIssued.length = snapshot.invoiceNumbersIssuedLength;
    this.outbox.length = snapshot.outboxLength;
    this.orderEvents.length = snapshot.eventsLength;
    this.committedReservationOrders.length = snapshot.committedReservationsLength;
    this.releasedReservationOrders.length = snapshot.releasedReservationsLength;
  }
}
