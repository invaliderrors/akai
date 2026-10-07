import { toMinor } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import type { RecordTransactionInput } from "../repository/payments.repository";
import { FakePaymentsRepository, paymentSnapshot } from "./payments.fakes";

/**
 * The fake's `recordTransaction` must model the adapter's three cases in the
 * same order, or the settlement suites pass against a ledger Postgres does not
 * keep. Pinned here; the adapter itself is proven in api-e2e.
 */
describe("FakePaymentsRepository.recordTransaction", () => {
  const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ORDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const REFERENCE = "AK-2026-000123-1";

  function input(overrides: Partial<RecordTransactionInput> = {}): RecordTransactionInput {
    return {
      orderId: ORDER_A,
      providerReference: REFERENCE,
      providerPaymentId: "tx_1",
      status: "SUCCEEDED",
      reported: { amount: toMinor(8_900_000), currency: "COP" },
      failureCode: null,
      failureMessage: null,
      capturedAt: new Date("2026-10-06T12:00:00.000Z"),
      ...overrides,
    };
  }

  it("CLAIMS the attempt row the checkout wrote, rather than inserting a second", async () => {
    const repository = new FakePaymentsRepository();
    repository.seedPayment(paymentSnapshot({ orderId: ORDER_A, providerReference: REFERENCE }));

    await repository.recordTransaction(input());

    expect(repository.payments).toHaveLength(1);
    expect(repository.payments[0]).toMatchObject({
      providerPaymentId: "tx_1",
      status: "SUCCEEDED",
      providerReference: REFERENCE,
    });
  });

  it("keeps the attempt's own amount when nothing valid was reported", async () => {
    const repository = new FakePaymentsRepository();
    repository.seedPayment(
      paymentSnapshot({ orderId: ORDER_A, providerReference: REFERENCE, amount: toMinor(1234) }),
    );

    await repository.recordTransaction(input({ reported: null }));

    expect(repository.payments[0]?.amount).toBe(toMinor(1234));
  });

  it("updates the row already carrying the transaction id", async () => {
    const repository = new FakePaymentsRepository();
    repository.seedPayment(
      paymentSnapshot({
        orderId: ORDER_A,
        providerReference: REFERENCE,
        providerPaymentId: "tx_1",
        status: "PROCESSING",
        amount: toMinor(1234),
      }),
    );

    await repository.recordTransaction(input());

    expect(repository.payments).toHaveLength(1);
    expect(repository.payments[0]?.status).toBe("SUCCEEDED");
    // The first figure stays: an update never rewrites the amount.
    expect(repository.payments[0]?.amount).toBe(toMinor(1234));
  });

  it("never rewrites a row that belongs to ANOTHER order", async () => {
    const repository = new FakePaymentsRepository();
    repository.seedPayment(
      paymentSnapshot({
        orderId: ORDER_B,
        providerReference: "AK-2026-000999-1",
        providerPaymentId: "tx_1",
        status: "PROCESSING",
      }),
    );

    await repository.recordTransaction(input());

    expect(repository.payments).toHaveLength(1);
    expect(repository.payments[0]).toMatchObject({ orderId: ORDER_B, status: "PROCESSING" });
  });

  it("inserts a row for a SECOND transaction under one reference", async () => {
    const repository = new FakePaymentsRepository();
    repository.seedPayment(
      paymentSnapshot({
        orderId: ORDER_A,
        providerReference: REFERENCE,
        providerPaymentId: "tx_declined",
        status: "FAILED",
      }),
    );

    await repository.recordTransaction(input({ providerPaymentId: "tx_2" }));

    expect(repository.payments).toHaveLength(2);
    expect(repository.paymentFor("tx_2")).toMatchObject({ status: "SUCCEEDED", orderId: ORDER_A });
  });

  it("writes no row it would have to invent an amount for", async () => {
    const repository = new FakePaymentsRepository();

    await repository.recordTransaction(input({ reported: null }));

    expect(repository.payments).toHaveLength(0);
  });
});
