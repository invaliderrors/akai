import { toMinor, type OrderStatus } from "@akai/contracts";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it } from "vitest";

import { TransitionTableOrderState } from "./order-state.port";
import {
  FakePaymentsRepository,
  orderLine,
  orderSnapshot,
  paymentSnapshot,
} from "./testing/payments.fakes";
import { wompiTransaction } from "./testing/wompi.fakes";
import {
  UNPARSABLE_EVENT_TYPE,
  WompiSettlementService,
  transactionEventId,
  verifySettlement,
} from "./wompi-settlement.service";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });

let repository: FakePaymentsRepository;
let settlement: WompiSettlementService;

function seedAwaiting(status: OrderStatus = "AWAITING_PAYMENT"): void {
  repository.seedOrder(orderSnapshot({ status }), [orderLine()]);
  repository.seedPayment(paymentSnapshot());
}

beforeEach(() => {
  repository = new FakePaymentsRepository();
  settlement = new WompiSettlementService(repository, new TransitionTableOrderState(), logger);
});

describe("verifySettlement", () => {
  const order = orderSnapshot();

  it("settles when amount_in_cents and currency equal ours — no unit conversion", () => {
    expect(verifySettlement(wompiTransaction(), order)).toEqual({
      settle: true,
      amount: toMinor(8_900_000),
      currency: "COP",
    });
  });

  it("treats an ABSENT amount as a refusal, never as agreement", () => {
    expect(verifySettlement(wompiTransaction({ amount_in_cents: null }), order)).toEqual({
      settle: false,
      reason: "AMOUNT_ABSENT",
    });
    expect(verifySettlement(wompiTransaction({ amount_in_cents: undefined }), order)).toEqual({
      settle: false,
      reason: "AMOUNT_ABSENT",
    });
  });

  it("refuses a figure it cannot read exactly (fractional, negative)", () => {
    expect(verifySettlement(wompiTransaction({ amount_in_cents: 8_900_000.5 }), order).settle).toBe(
      false,
    );
    expect(verifySettlement(wompiTransaction({ amount_in_cents: -1 }), order).settle).toBe(false);
  });

  it("refuses a different amount — one centavo is enough", () => {
    expect(verifySettlement(wompiTransaction({ amount_in_cents: 8_899_999 }), order)).toEqual({
      settle: false,
      reason: "AMOUNT_DIFFERS",
    });
  });

  it("refuses a different or missing currency", () => {
    expect(verifySettlement(wompiTransaction({ currency: "USD" }), order)).toEqual({
      settle: false,
      reason: "CURRENCY_DIFFERS",
    });
    expect(verifySettlement(wompiTransaction({ currency: null }), order).settle).toBe(false);
  });

  it("accepts the currency in any case", () => {
    expect(verifySettlement(wompiTransaction({ currency: "cop" }), order).settle).toBe(true);
  });
});

describe("WompiSettlementService — APPROVED", () => {
  it("settles a matching transaction: PAID, stock sold, invoice, emails", async () => {
    seedAwaiting();

    const outcome = await settlement.applyTransaction(wompiTransaction(), { source: "webhook" });

    expect(outcome).toEqual({ status: "applied", transactionStatus: "APPROVED" });
    expect(repository.order().status).toBe("PAID");
    expect(repository.committedReservationOrders).toEqual([repository.order().id]);
    expect(repository.invoiceNumberFor(repository.order().id)).toMatch(/^INV-/);
    expect(repository.emailTemplates()).toEqual([
      "order-confirmation",
      "payment-receipt",
      "admin-new-order",
    ]);
    expect(repository.paidAt.get(repository.order().id)?.toISOString()).toBe(
      "2026-10-06T12:00:05.000Z",
    );
  });

  it("claims the checkout's attempt row with the transaction id", async () => {
    seedAwaiting();

    await settlement.applyTransaction(wompiTransaction(), { source: "webhook" });

    expect(repository.payments).toHaveLength(1);
    expect(repository.paymentFor("1234-1700000000-00001")).toMatchObject({
      status: "SUCCEEDED",
      providerReference: "AK-2026-000123-1",
    });
  });

  it("dedupes on (transaction id, status) and locks the order to correlate", async () => {
    seedAwaiting();

    await settlement.applyTransaction(wompiTransaction(), { source: "webhook" });
    const second = await settlement.applyTransaction(wompiTransaction(), { source: "return" });

    expect(second).toEqual({ status: "duplicate", transactionStatus: "APPROVED" });
    expect(repository.providerEvents).toEqual([
      { id: "wompi:1234-1700000000-00001:APPROVED", type: "transaction.approved" },
    ]);
    expect(repository.committedReservationOrders).toHaveLength(1);
    expect(repository.invoiceNumbersIssued).toHaveLength(1);
    expect(repository.locks).toEqual([repository.order().id]);
  });

  it("never settles twice — a SECOND approved transaction is recorded and paged", async () => {
    seedAwaiting();
    await settlement.applyTransaction(wompiTransaction(), { source: "webhook" });

    const outcome = await settlement.applyTransaction(
      wompiTransaction({ id: "1234-1700000000-00002", reference: "AK-2026-000123-1" }),
      { source: "webhook" },
    );

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("PAID");
    expect(repository.emailTemplates()).toHaveLength(3);
    expect(repository.invoiceNumbersIssued).toHaveLength(1);
    expect(repository.paymentFor("1234-1700000000-00002").status).toBe("SUCCEEDED");
    expect(repository.outboxFor("notifications")[0]?.payload).toMatchObject({
      kind: "duplicate-payment",
      providerPaymentId: "1234-1700000000-00002",
    });
  });

  it.each<[string, Partial<Parameters<typeof wompiTransaction>[0]>, string]>([
    ["a different amount", { amount_in_cents: 100 }, "AMOUNT_DIFFERS"],
    ["no amount", { amount_in_cents: null }, "AMOUNT_ABSENT"],
    ["a different currency", { currency: "USD" }, "CURRENCY_DIFFERS"],
  ])("parks %s in PAYMENT_MISMATCH and pages an operator", async (_label, overrides, reason) => {
    seedAwaiting();

    await settlement.applyTransaction(wompiTransaction(overrides), { source: "webhook" });

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.outboxFor("notifications")[0]?.payload).toMatchObject({
      kind: "payment-mismatch",
      reason,
      expectedAmount: 8_900_000,
      providerPaymentId: "1234-1700000000-00001",
    });
    // Money may have moved: stock neither sold nor released, nothing invoiced.
    expect(repository.committedReservationOrders).toHaveLength(0);
    expect(repository.releasedReservationOrders).toHaveLength(0);
    expect(repository.invoiceNumbersIssued).toHaveLength(0);
    expect(repository.emailTemplates()).toHaveLength(0);
  });

  it("records WOMPI's figure on the ledger row when it is readable — the evidence", async () => {
    seedAwaiting();

    await settlement.applyTransaction(wompiTransaction({ amount_in_cents: 100 }), {
      source: "webhook",
    });

    expect(repository.paymentFor("1234-1700000000-00001")).toMatchObject({
      status: "SUCCEEDED",
      amount: 100,
    });
  });

  it("never lets an automated settlement leave PAYMENT_MISMATCH", async () => {
    seedAwaiting("PAYMENT_MISMATCH");

    await settlement.applyTransaction(wompiTransaction({ id: "tx_good" }), { source: "sweep" });
    await settlement.applyTransaction(wompiTransaction({ id: "tx_bad", status: "DECLINED" }), {
      source: "webhook",
    });

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.releasedReservationOrders).toHaveLength(0);
  });

  it("RECORDS and ALERTS on an approval for an order that already failed", async () => {
    seedAwaiting();
    await settlement.applyTransaction(
      wompiTransaction({ id: "tx_declined", status: "DECLINED" }),
      { source: "webhook" },
    );

    await settlement.applyTransaction(wompiTransaction({ id: "tx_retry" }), { source: "webhook" });

    expect(repository.order().status).toBe("FAILED");
    expect(repository.paymentFor("tx_retry").status).toBe("SUCCEEDED");
    expect(repository.outboxFor("notifications")[0]?.payload).toMatchObject({
      kind: "payment-after-failure",
      providerPaymentId: "tx_retry",
    });
    expect(repository.invoiceNumbersIssued).toHaveLength(0);
  });
});

describe("WompiSettlementService — DECLINED / VOIDED / ERROR", () => {
  it.each(["DECLINED", "VOIDED", "ERROR"] as const)(
    "fails the order on %s, releases the stock and tells the customer",
    async (status) => {
      seedAwaiting();

      await settlement.applyTransaction(
        wompiTransaction({ status, status_message: "Fondos insuficientes" }),
        { source: "webhook" },
      );

      expect(repository.order().status).toBe("FAILED");
      expect(repository.releasedReservationOrders).toEqual([repository.order().id]);
      expect(repository.emailTemplates()).toEqual(["payment-failed"]);
      expect(repository.paymentFor("1234-1700000000-00001")).toMatchObject({
        status: "FAILED",
        failureCode: status,
      });
      expect(repository.orderEvents.at(-1)?.message).toBe(`${status}: Fondos insuficientes`);
    },
  );

  it("ignores a late failure for an order already paid — ledger and status untouched", async () => {
    seedAwaiting();
    await settlement.applyTransaction(wompiTransaction(), { source: "webhook" });

    await settlement.applyTransaction(
      wompiTransaction({ id: "tx_old", status: "DECLINED" }),
      { source: "sweep" },
    );

    expect(repository.order().status).toBe("PAID");
    expect(repository.releasedReservationOrders).toHaveLength(0);
    expect(repository.payments.some((row) => row.providerPaymentId === "tx_old")).toBe(false);
  });
});

describe("WompiSettlementService — PENDING", () => {
  it("leaves the order alone and records the transaction id for the sweep", async () => {
    seedAwaiting();

    const outcome = await settlement.applyTransaction(
      wompiTransaction({ status: "PENDING", finalized_at: null }),
      { source: "webhook" },
    );

    expect(outcome).toEqual({ status: "applied", transactionStatus: "PENDING" });
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
    expect(repository.paymentFor("1234-1700000000-00001").status).toBe("PROCESSING");
    expect(repository.outbox).toHaveLength(0);
  });

  it("then settles when the same transaction is APPROVED", async () => {
    seedAwaiting();
    await settlement.applyTransaction(wompiTransaction({ status: "PENDING" }), {
      source: "webhook",
    });

    await settlement.applyTransaction(wompiTransaction(), { source: "sweep" });

    expect(repository.order().status).toBe("PAID");
    expect(repository.payments).toHaveLength(1);
    expect(repository.paymentFor("1234-1700000000-00001").status).toBe("SUCCEEDED");
  });

  it("does not downgrade a settled order's ledger on a late PENDING", async () => {
    seedAwaiting();
    await settlement.applyTransaction(wompiTransaction(), { source: "webhook" });

    await settlement.applyTransaction(wompiTransaction({ status: "PENDING" }), {
      source: "webhook",
    });

    expect(repository.paymentFor("1234-1700000000-00001").status).toBe("SUCCEEDED");
  });
});

describe("WompiSettlementService — correlation", () => {
  it("ACKs an unknown reference as unmatched and burns no dedupe key", async () => {
    seedAwaiting();

    const outcome = await settlement.applyTransaction(
      wompiTransaction({ reference: "NOT-OURS-1" }),
      { source: "webhook" },
    );

    expect(outcome).toEqual({ status: "unmatched" });
    expect(repository.providerEvents).toHaveLength(0);
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("refuses a transaction whose order is not the one the caller asked about", async () => {
    seedAwaiting();

    const outcome = await settlement.applyTransaction(wompiTransaction(), {
      source: "return",
      expectedOrderNumber: "AK-2026-000999",
    });

    expect(outcome).toEqual({ status: "unmatched" });
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("ACKs a status Wompi has not documented, without touching anything", async () => {
    seedAwaiting();

    const outcome = await settlement.applyTransaction(
      wompiTransaction({ status: "SOMETHING_NEW" }),
      { source: "webhook" },
    );

    expect(outcome.status).toBe("ignored");
    expect(repository.providerEvents).toHaveLength(0);
  });

  it("keys events as wompi:<id>:<status>, inside the 128-char column", () => {
    const id = transactionEventId("1234-1610641025-49201", "APPROVED");
    expect(id).toBe("wompi:1234-1610641025-49201:APPROVED");
    expect(transactionEventId("x".repeat(64), "DECLINED").length).toBeLessThanOrEqual(128);
  });
});

describe("WompiSettlementService.recordUnparsable", () => {
  it("alerts ONCE per verified checksum, however often it is replayed", async () => {
    const checksum = "A".repeat(64);

    await settlement.recordUnparsable(checksum, ["transaction.id: Required"]);
    await settlement.recordUnparsable(checksum, ["transaction.id: Required"]);

    expect(repository.outboxFor("notifications")).toHaveLength(1);
    expect(repository.outboxFor("notifications")[0]?.payload).toMatchObject({
      kind: "webhook-unparsable",
      provider: "WOMPI",
    });
    expect(repository.providerEvents).toEqual([
      { id: `unparsable:${"a".repeat(64)}`, type: UNPARSABLE_EVENT_TYPE },
    ]);
  });
});
