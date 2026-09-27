import { toMinor } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import { FakePaymentsRepository, paymentSnapshot } from "./payments.fakes";

/**
 * `upsertSettlementPayment` is keyed on `providerPaymentId`, which is `@unique`
 * GLOBALLY in the schema — at most one payment row can ever exist per payment id,
 * irrespective of which order created it. These tests pin the two branches, and
 * in particular that the update branch re-attributes the row to the settling
 * order rather than silently mutating whatever order first claimed the id.
 */
describe("FakePaymentsRepository.upsertSettlementPayment", () => {
  const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ORDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const SHARED_PAYMENT_ID = "tgd_pay_shared";

  it("re-scopes orderId on update so a settlement never lands on another order's row", async () => {
    const repository = new FakePaymentsRepository();

    // Order B already owns a row for this payment id (e.g. it recorded the
    // attempt, or an earlier out-of-band event created it).
    repository.seedPayment(
      paymentSnapshot({
        id: "row_owned_by_b",
        orderId: ORDER_B,
        // PROCESSING, not PENDING. `PaymentStatus` is
        // REQUIRES_PAYMENT_METHOD | REQUIRES_ACTION | PROCESSING | SUCCEEDED | FAILED |
        // CANCELLED — PENDING belongs to `RefundStatus`, so seeding it described a row
        // the database can never hold and the branch under test was proven against a
        // fictional prior state. Any non-SUCCEEDED member satisfies the premise; this is
        // the one a real in-flight attempt carries.
        status: "PROCESSING",
        providerPaymentId: SHARED_PAYMENT_ID,
      }),
    );

    // Order A's settlement event carries the SAME payment id.
    await repository.upsertSettlementPayment({
      orderId: ORDER_A,
      amount: toMinor(4999),
      currency: "EUR",
      status: "SUCCEEDED",
      providerPaymentId: SHARED_PAYMENT_ID,
      cardBrand: "visa",
      cardLast4: "4242",
      capturedAt: new Date("2026-07-21T00:00:00.000Z"),
    });

    // Exactly one row (the id is globally unique) and it is now attributed to A.
    expect(repository.payments).toHaveLength(1);
    const row = repository.payments[0];
    expect(row?.orderId).toBe(ORDER_A);
    expect(row?.status).toBe("SUCCEEDED");
    // The FIRST settlement figure is preserved — the update must not rewrite amount.
    expect(row?.amount).toBe(toMinor(4999));
  });

  it("is a no-op re-scope in the ordinary same-order concurrent case", async () => {
    const repository = new FakePaymentsRepository();
    repository.seedPayment(
      paymentSnapshot({
        orderId: ORDER_A,
        amount: toMinor(1234),
        // See the note on the sibling case: PENDING is not a `PaymentStatus`.
        status: "PROCESSING",
        providerPaymentId: SHARED_PAYMENT_ID,
      }),
    );

    await repository.upsertSettlementPayment({
      orderId: ORDER_A,
      amount: toMinor(9999),
      currency: "EUR",
      status: "SUCCEEDED",
      providerPaymentId: SHARED_PAYMENT_ID,
      cardBrand: null,
      cardLast4: null,
      capturedAt: null,
    });

    expect(repository.payments).toHaveLength(1);
    expect(repository.payments[0]?.orderId).toBe(ORDER_A);
    expect(repository.payments[0]?.status).toBe("SUCCEEDED");
    // amount untouched: the first settlement figure is the evidence the mismatch
    // path preserves.
    expect(repository.payments[0]?.amount).toBe(toMinor(1234));
  });

  it("inserts a fresh row when no row for the payment id exists yet", async () => {
    const repository = new FakePaymentsRepository();

    await repository.upsertSettlementPayment({
      orderId: ORDER_A,
      amount: toMinor(500),
      currency: "EUR",
      status: "SUCCEEDED",
      providerPaymentId: SHARED_PAYMENT_ID,
      cardBrand: null,
      cardLast4: null,
      capturedAt: null,
    });

    expect(repository.payments).toHaveLength(1);
    expect(repository.payments[0]?.orderId).toBe(ORDER_A);
    expect(repository.payments[0]?.providerPaymentId).toBe(SHARED_PAYMENT_ID);
  });
});
