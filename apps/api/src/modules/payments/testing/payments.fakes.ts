import { type Minor, toMinor } from "@akai/contracts";
import { add, subtract } from "@akai/money";

import type {
  JsonObject,
  OrderLineSnapshot,
  OrderSnapshot,
  PaymentSnapshot,
  PaymentsRepository,
  PaymentsWriter,
  ProviderOrderReference,
  RecordDisputeInput,
  RecordPaymentAttemptInput,
  RecordRefundInput,
  UpdatePaymentInput,
  UpsertSettlementPaymentInput,
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
 * repository behave like this?" acquires two answers. The webhook-specific
 * behaviours (the `provider_event` dedupe ledger, the
 * three-way correlation lookup, the never-overwrite `providerOrderId` backfill)
 * are modelled HERE, where every suite gets them.
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
    locale: "es",
    currency: "EUR",
    grandTotal: toMinor(4999),
    discountTotal: toMinor(0),
    shippingTotal: toMinor(0),
    taxTotal: toMinor(867),
    refundedTotal: toMinor(0),
    providerCheckoutId: null,
  };

  return Object.assign({}, base, overrides);
}

export function orderLine(overrides: Partial<OrderLineSnapshot> = {}): OrderLineSnapshot {
  const base: OrderLineSnapshot = {
    id: "22222222-2222-4222-8222-222222222222",
    productName: "BPC-157",
    variantName: "10 mg",
    sku: "AK-BPC-10",
    imageUrl: null,
    quantity: 1,
    unitPriceGross: toMinor(4999),
    lineTotalGross: toMinor(4999),
    // The VAT inside 4999 at the order fixture's rate, so a default line and a
    // default order agree: taxTotal(867) - lineTax(867) leaves shipping untaxed.
    taxAmount: toMinor(867),
  };

  return Object.assign({}, base, overrides);
}

export function paymentSnapshot(
  overrides: Partial<PaymentSnapshot> = {},
): PaymentSnapshot {
  const base: PaymentSnapshot = {
    id: "33333333-3333-4333-8333-333333333333",
    orderId: "11111111-1111-4111-8111-111111111111",
    status: "SUCCEEDED",
    amount: toMinor(4999),
    currency: "EUR",
    providerPaymentId: "tgd_pay_test",
    providerTransactionId: "tgd_txn_test",
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
  readonly payments: PaymentSnapshot[];
  /** Invoice allocation rolls back with the transaction — see `invoiceNumbersIssued`. */
  readonly invoiceNumbers: Map<string, string>;
  readonly invoiceNumbersIssuedLength: number;
  readonly outboxLength: number;
  readonly eventsLength: number;
  readonly refundsLength: number;
  readonly disputesLength: number;
  readonly committedReservationsLength: number;
  readonly releasedReservationsLength: number;
  readonly checkoutIdLinksLength: number;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export class FakePaymentsRepository implements PaymentsRepository {
  readonly orders = new Map<string, OrderSnapshot>();
  readonly lines = new Map<string, OrderLineSnapshot[]>();
  readonly payments: PaymentSnapshot[] = [];

  readonly refunds: RecordRefundInput[] = [];
  readonly disputes: RecordDisputeInput[] = [];
  readonly orderEvents: RecordedOrderEvent[] = [];
  readonly outbox: RecordedOutbox[] = [];
  /** Order ids whose reservations were converted to a sale (commit at PAID). */
  readonly committedReservationOrders: string[] = [];
  /** Order ids whose reservations were released (payment failed / cancelled). */
  readonly releasedReservationOrders: string[] = [];

  /** Every `provider_event` row this fake accepted, in order. */
  readonly providerEvents: RecordedProviderEvent[] = [];
  /** Every `linkCheckoutId` call, in order. */
  readonly checkoutIdLinks: { orderId: string; checkoutId: string }[] = [];
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

  seedOrder(order: OrderSnapshot, lines: readonly OrderLineSnapshot[] = []): void {
    this.orders.set(order.id, order);
    this.lines.set(order.id, [...lines]);
  }

  seedPayment(payment: PaymentSnapshot): void {
    this.payments.push(payment);
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

  async findOrderByProviderReference(
    reference: ProviderOrderReference,
  ): Promise<OrderSnapshot | null> {
    switch (reference.kind) {
      // Our own order UUID, round-tripped through the provider's metadata — a
      // primary-key lookup.
      case "orderId":
        return this.findOrderById(reference.id);

      case "checkoutId": {
        for (const order of this.orders.values()) {
          if (order.providerCheckoutId === reference.id) {
            return order;
          }
        }
        return null;
      }
    }
  }

  async findOrderLines(orderId: string): Promise<readonly OrderLineSnapshot[]> {
    return this.lines.get(orderId) ?? [];
  }

  async findPaymentByProviderId(
    providerPaymentId: string,
  ): Promise<PaymentSnapshot | null> {
    return (
      this.payments.find((entry) => entry.providerPaymentId === providerPaymentId) ?? null
    );
  }

  async findRefundablePaymentForOrder(orderId: string): Promise<PaymentSnapshot | null> {
    return (
      this.payments.find(
        (entry) => entry.orderId === orderId && entry.status === "SUCCEEDED",
      ) ?? null
    );
  }

  // --- Writes --------------------------------------------------------------

  async recordPaymentAttempt(
    input: RecordPaymentAttemptInput,
  ): Promise<PaymentSnapshot> {
    const payment: PaymentSnapshot = {
      id: `pay_${this.payments.length + 1}`,
      orderId: input.orderId,
      status: input.status,
      amount: input.amount,
      currency: input.currency,
      providerPaymentId: input.providerPaymentId,
      providerTransactionId: null,
    };

    this.payments.push(payment);
    return payment;
  }

  /**
   * Insert-or-update on `providerPaymentId`, mirroring the production upsert.
   *
   * Modelled as ONE operation, not a find followed by a push, because the whole
   * reason the port has this method is that a check-then-insert is not atomic. A
   * fake that split it in two would let a test pass against an implementation the
   * database rejects.
   */
  async upsertSettlementPayment(input: UpsertSettlementPaymentInput): Promise<void> {
    const index = this.payments.findIndex(
      (entry) => entry.providerPaymentId === input.providerPaymentId,
    );

    const existing = this.payments[index];

    if (existing === undefined) {
      this.payments.push({
        id: `pay_${this.payments.length + 1}`,
        orderId: input.orderId,
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        providerPaymentId: input.providerPaymentId,
        providerTransactionId: null,
      });
      return;
    }

    // `amount` deliberately NOT rewritten — the first settlement figure is the
    // evidence the mismatch path preserves. `orderId` IS re-scoped, mirroring the
    // Prisma repo: `providerPaymentId` is globally unique, so a settlement for one
    // order landing on a row another order created must re-attribute the row to the
    // order this settlement belongs to, not silently mutate the other order's row.
    this.payments[index] = {
      ...existing,
      orderId: input.orderId,
      status: input.status,
    };
  }

  async updatePaymentByProviderId(input: UpdatePaymentInput): Promise<void> {
    // Scoped to the correlated order too: mirrors the production `updateMany` predicate,
    // so an event correlated to order A cannot mutate a paymentId belonging to order B.
    const index = this.payments.findIndex(
      (entry) =>
        entry.providerPaymentId === input.providerPaymentId &&
        entry.orderId === input.orderId,
    );

    const existing = this.payments[index];
    if (existing === undefined) {
      return;
    }

    this.payments[index] = {
      ...existing,
      status: input.status,
      providerTransactionId: input.providerTransactionId,
    };
  }

  async linkCheckoutId(orderId: string, checkoutId: string): Promise<void> {
    this.checkoutIdLinks.push({ orderId, checkoutId });
    this.mutateOrder(orderId, { providerCheckoutId: checkoutId });
  }

  async setOrderStatus(orderId: string, status: OrderSnapshot["status"]): Promise<void> {
    this.mutateOrder(orderId, { status });
  }

  /**
   * PAID, and the invoice number that legally goes with it, in one step.
   *
   * The allocation is conditional, mirroring the adapter's check-under-lock:
   * that guard is the whole reason a duplicate webhook cannot consume a second
   * number, so a fake that allocated unconditionally would hide exactly the
   * defect worth testing for.
   */
  async markOrderPaid(orderId: string, paidAt: Date): Promise<void> {
    this.paidAt.set(orderId, paidAt);

    const order = this.orders.get(orderId);
    if (order === undefined || this.invoiceNumbers.has(orderId)) {
      this.mutateOrder(orderId, { status: "PAID" });
      return;
    }

    // Shaped like `allocate_invoice_number()`: INV-<year>-<six digits>, from a
    // counter that never resets per year.
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

  async addRefundedTotal(orderId: string, delta: Minor): Promise<void> {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      return;
    }
    this.mutateOrder(orderId, { refundedTotal: add(order.refundedTotal, delta) });
  }

  async commitReservationsForOrder(orderId: string): Promise<void> {
    this.committedReservationOrders.push(orderId);
  }

  async releaseReservationsForOrder(orderId: string): Promise<void> {
    this.releasedReservationOrders.push(orderId);
  }

  async recordRefund(input: RecordRefundInput): Promise<void> {
    this.refunds.push(input);
  }

  async recordDispute(input: RecordDisputeInput): Promise<void> {
    this.disputes.push(input);
  }

  async appendOrderEvent(input: RecordedOrderEvent): Promise<void> {
    this.orderEvents.push(input);
  }

  async enqueue(topic: string, payload: JsonObject): Promise<void> {
    this.outbox.push({ topic, payload });
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
   * concurrency; that is what `apps/api-e2e/src/whop-webhook-dedupe.spec.ts`
   * is for.
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
      refundsLength: this.refunds.length,
      disputesLength: this.disputes.length,
      committedReservationsLength: this.committedReservationOrders.length,
      releasedReservationsLength: this.releasedReservationOrders.length,
      checkoutIdLinksLength: this.checkoutIdLinks.length,
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
    this.refunds.length = snapshot.refundsLength;
    this.disputes.length = snapshot.disputesLength;
    this.committedReservationOrders.length = snapshot.committedReservationsLength;
    this.releasedReservationOrders.length = snapshot.releasedReservationsLength;
    this.checkoutIdLinks.length = snapshot.checkoutIdLinksLength;
  }
}

/** Remaining refundable balance, for assertions. */
export function refundable(order: OrderSnapshot): Minor {
  return subtract(order.grandTotal, order.refundedTotal);
}
