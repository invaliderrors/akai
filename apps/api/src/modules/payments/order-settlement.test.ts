import { describe, expect, it, vi } from "vitest";

import { settleOrderPaid } from "./order-settlement";
import type { OrderSnapshot, PaymentsWriter } from "./repository/payments.repository";

/**
 * REGRESSION: a paid order must not enqueue a topic nothing consumes.
 *
 * The dispatcher treats an UNROUTED topic as a FAILURE, not as work waiting for
 * a consumer, so `invoice-pdf` and `order-fulfilment` — whose modules are still
 * empty — burned ~8 retries per order and then dead-lettered. The order was fine;
 * `/admin/jobs` filled with permanent red that drowned the dead-letters meaning
 * something real.
 *
 * This pins the topic set. When `invoices` or `fulfilment` gains a handler, the
 * producer comes back in that SAME change and this expectation moves with it —
 * which is the point: the two can no longer drift apart quietly.
 */

/** Topics with a registered handler. Mirrors `OUTBOX_HANDLERS` in outbox.module.ts. */
const ROUTED_TOPICS = new Set([
  "email",
  "provider-sync",
  "storefront.revalidate",
  "catalog.product.created",
  "catalog.product.updated",
  "catalog.product.published",
  "catalog.product.unpublished",
  "catalog.product.archived",
  "catalog.product.restored",
  "catalog.variant.created",
  "catalog.variant.updated",
  "catalog.variant.deactivated",
  "catalog.variant.price_changed",
]);

function order(): OrderSnapshot {
  // Only the fields the settlement reads; the writer is a spy, so nothing else
  // is exercised.
  return {
    id: "8f1f2c1e-1f3a-4c6e-9b2a-2f7f5c4d3e21",
    orderNumber: "AK-2026-000001",
    email: "buyer@akai.test",
  } as OrderSnapshot;
}

function spyWriter() {
  const enqueued: { topic: string }[] = [];
  const writer = {
    markOrderPaid: vi.fn(),
    commitReservationsForOrder: vi.fn(),
    appendOrderEvent: vi.fn(),
    enqueue: vi.fn((topic: string) => {
      enqueued.push({ topic });
      return Promise.resolve();
    }),
  };
  return { writer: writer as unknown as PaymentsWriter, enqueued };
}

describe("settleOrderPaid", () => {
  const settlement = { occurredAt: new Date("2026-09-09T12:00:00.000Z"), timelineMessage: "ok" };

  it("enqueues ONLY topics that have a registered handler", async () => {
    const { writer, enqueued } = spyWriter();
    await settleOrderPaid(writer, order(), settlement);

    const unrouted = enqueued.map((row) => row.topic).filter((topic) => !ROUTED_TOPICS.has(topic));
    expect(
      unrouted,
      "every one of these would dead-letter on a perfectly good order — ship the handler in the same change as the producer",
    ).toEqual([]);
  });

  it("still sends the customer their confirmation and receipt", async () => {
    const { writer, enqueued } = spyWriter();
    await settleOrderPaid(writer, order(), settlement);

    // Removing the unrouted producers must not have taken the working ones with
    // them: three emails, all on the routed `email` topic.
    expect(enqueued.filter((row) => row.topic === "email")).toHaveLength(3);
  });

  it("marks the order paid and commits the reserved stock, atomically with the caller", async () => {
    const { writer } = spyWriter();
    await settleOrderPaid(writer, order(), settlement);

    expect(writer.markOrderPaid).toHaveBeenCalledWith(order().id, settlement.occurredAt);
    // The stock decrement must share the caller's transaction, or a rollback
    // loses the movement while the order stays PAID.
    expect(writer.commitReservationsForOrder).toHaveBeenCalledWith(order().id);
  });

  it("writes the caller's own timeline message", async () => {
    const { writer } = spyWriter();
    await settleOrderPaid(writer, order(), { ...settlement, timelineMessage: "no charge taken" });

    expect(writer.appendOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ message: "no charge taken", isInternal: false }),
    );
  });
});
