import "reflect-metadata";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { RecordNotFoundError } from "@akai/db";
import { toMinor } from "@akai/money";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "@akai/config";

import { SERVER_CONFIG } from "../config/config.module";
import { PrismaService } from "../prisma/prisma.service";
import { ProductInventoryService } from "../catalog/product-inventory.service";
import { DiscountsService } from "../discounts/discounts.service";
import { DESTINATION_TAX_RESOLVER } from "../tax/destination-tax.resolver";
import { StatusNotAdminAssignableError } from "./order-status.machine";
import { OrdersService } from "./orders.service";
import { parseTemplatePayload } from "../email/email.templates";
import type { Principal } from "../auth/security/principal";

/**
 * These tests stub Prisma at the client boundary rather than running a database.
 * The invariants under test are about WHICH query is issued — does the where
 * clause carry the customer id, is the invoice number allocated twice, does a
 * concurrent write get rejected — and those are precisely the things a real
 * database would answer identically for a correct and an incorrect
 * implementation. Full round-trips against Postgres live in apps/api-e2e.
 */

const STAFF: Principal = {
  customerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  sessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
  role: "STAFF",
  twoFactorAssertedAt: null,
};

const CONFIG = {
  DASHBOARD_URL: "https://dash.akai.test/",
  EMAIL_FROM: "ops@akai.test",
} as unknown as ServerEnv;

const OWNER_ID = "eeeeeeee-0000-4000-8000-000000000001";
const OTHER_ID = "eeeeeeee-0000-4000-8000-00000000000f";
const ORDER_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const ORDER_NUMBER = "AK-2026-000123";

interface OrderRowOverrides {
  readonly status?: string;
  readonly version?: number;
  readonly grandTotal?: number;
  readonly refundedTotal?: number;
}

/** Minimal order row — only the columns the method under test reads. */
function orderRow(overrides: OrderRowOverrides = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    customerId: OWNER_ID,
    email: "cliente@example.com",
    status: overrides.status ?? "PAID",
    locale: "es",
    currency: "EUR",
    subtotal: 8263,
    discountTotal: 0,
    shippingTotal: 0,
    taxTotal: 1735,
    grandTotal: overrides.grandTotal ?? 9998,
    refundedTotal: overrides.refundedTotal ?? 0,
    shipFirstName: "Valentina",
    shipLastName: "Restrepo",
    shipCompany: null,
    shipLine1: "Calle 10 # 43-21",
    shipLine2: null,
    shipCity: "Medellín",
    shipRegion: "Antioquia",
    shipPostalCode: null,
    shipCountryCode: "CO",
    shipPhone: "3001234567",
    billFirstName: "Valentina",
    billLastName: "Restrepo",
    billCompany: null,
    billLine1: "Calle 10 # 43-21",
    billLine2: null,
    billCity: "Medellín",
    billRegion: "Antioquia",
    billPostalCode: null,
    billCountryCode: "CO",
    billPhone: null,
    invoiceNumber: null,
    documentType: "CC",
    documentNumber: "1020304050",
    shippingMethodName: "Estándar",
    acceptedTermsVersion: "2026-01",
    providerCheckoutToken: null,
    placedAt: new Date("2026-07-01T10:00:00.000Z"),
    paidAt: null,
    cancelledAt: null,
    updatedAt: new Date("2026-07-01T10:00:00.000Z"),
    version: overrides.version ?? 0,
    items: [],
    events: [],
    payments: [],
    refunds: [],
    shipments: [],
  };
}

function detailRow(overrides: OrderRowOverrides = {}): Record<string, unknown> {
  return {
    ...orderRow(overrides),
    items: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        orderId: ORDER_ID,
        variantId: "cccccccc-0000-4000-8000-000000000001",
        productName: "Oversized Tee",
        variantName: "L",
        sku: "AK-TEE-BLK-L",
        imageUrl: null,
        quantity: 2,
        unitPriceNet: 4131,
        unitPriceGross: 4999,
        lineDiscount: 0,
        taxRateBps: 2100,
        taxAmount: 1735,
        lineTotalNet: 8263,
        lineTotalGross: 9998,
      },
    ],
    events: [],
  };
}

/**
 * Named fields rather than a `Record<string, Mock>`: under
 * noUncheckedIndexedAccess an index signature makes every lookup `Mock |
 * undefined`, and the fix people reach for is a `!`. Declaring the shape means
 * a typo in a mock name is a compile error instead.
 */
type Mock = ReturnType<typeof vi.fn>;

interface PrismaHarness {
  readonly fake: Record<string, unknown>;
  readonly order: {
    readonly findFirst: Mock;
    readonly findUnique: Mock;
    readonly findMany: Mock;
    readonly updateMany: Mock;
    readonly update: Mock;
    readonly create: Mock;
  };
  readonly orderEvent: { readonly create: Mock };
  readonly refund: {
    readonly findUnique: Mock;
    readonly create: Mock;
    readonly update: Mock;
  };
  readonly shipment: {
    readonly findUnique: Mock;
    readonly create: Mock;
    readonly update: Mock;
  };
  readonly outboxMessage: { readonly create: Mock };
  readonly queryRaw: Mock;
  readonly cart: { readonly findUnique: Mock };
  readonly product: { readonly findMany: Mock };
  readonly stockReservation: { readonly updateMany: Mock };
}

function createPrismaFake(): PrismaHarness {
  const order = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(),
    create: vi.fn(),
  };
  const orderEvent = { create: vi.fn(async () => ({})) };
  const refund = { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  const shipment = { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  const outboxMessage = { create: vi.fn(async () => ({ id: "outbox-1" })) };
  const cart = { findUnique: vi.fn() };
  const queryRaw = vi.fn(async () => [{ value: "INV-2026-000045" }]);
  // Read by `createFromCart`'s pack-pricing resolution and by its
  // reservation-linking step. Empty/no-op by default — only the
  // `createFromCart` suite below exercises either.
  const product = { findMany: vi.fn(async () => []) };
  const stockReservation = { updateMany: vi.fn(async () => ({ count: 0 })) };

  const fake: Record<string, unknown> = {
    order,
    orderEvent,
    refund,
    shipment,
    outboxMessage,
    cart,
    product,
    stockReservation,
    $queryRaw: queryRaw,
  };
  // The transaction callback receives the same fake, so a method under test
  // exercises exactly the calls it would inside a real transaction.
  fake["$transaction"] = vi.fn(
    async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(fake),
  );

  return {
    fake,
    order,
    orderEvent,
    refund,
    shipment,
    outboxMessage,
    queryRaw,
    cart,
    product,
    stockReservation,
  };
}

/**
 * A fake inventory service. OrdersService.markPaid commits the stock reserved at
 * checkout once an order transitions to PAID; the unit tests stub that collaborator
 * so the money-state assertions stay about the order, and a dedicated test below
 * asserts the commit fires exactly on the real transition.
 */
function createInventoryFake(): { commitReservationsForOrder: Mock } {
  return { commitReservationsForOrder: vi.fn(async () => 0) };
}

async function buildService(
  prisma: Record<string, unknown>,
  inventory: { commitReservationsForOrder: Mock } = createInventoryFake(),
): Promise<OrdersService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrdersService,
      { provide: PrismaService, useValue: prisma },
      // Customer-facing mail carries a link to the order, which is a dashboard
      // URL — so the service needs the validated config the same way the outbox
      // handler does.
      { provide: SERVER_CONFIG, useValue: CONFIG },
      // Destination VAT is resolved per line at order creation; a fixed rate is
      // enough for the transition/refund/ownership suites, which never assert on tax.
      {
        provide: DESTINATION_TAX_RESOLVER,
        useValue: { resolveBps: vi.fn(async () => 2100) },
      },
      { provide: ProductInventoryService, useValue: inventory },
      // No cart in these suites carries a discount code, so validate is never hit;
      // the provider only has to exist for DI to construct the service.
      { provide: DiscountsService, useValue: { validate: vi.fn() } },
    ],
  }).compile();

  return moduleRef.get(OrdersService);
}

describe("OrdersService — customer ownership", () => {
  let harness: ReturnType<typeof createPrismaFake>;
  let service: OrdersService;

  beforeEach(async () => {
    harness = createPrismaFake();
    service = await buildService(harness.fake);
  });

  /**
   * THE IDOR test.
   *
   * The vulnerability is not exotic: it is `findUnique({ where: { id } })` on a
   * customer-owned table, and it returns someone else's invoice, full name and
   * home address. Asserting on the WHERE CLAUSE rather than on the response is
   * deliberate — a test that only checks the returned value passes just as
   * happily against an unscoped query whose fixture happens to belong to the
   * right customer.
   */
  it("scopes a detail read by (orderNumber AND customerId)", async () => {
    harness.order.findFirst.mockResolvedValue(detailRow());

    await service.getForCustomer(OWNER_ID, ORDER_NUMBER);

    const call: unknown = harness.order.findFirst.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      where: { orderNumber: ORDER_NUMBER, customerId: OWNER_ID },
    });
  });

  it("returns 404 — not 403 — for another customer's order", async () => {
    // The scoped query finds nothing for a non-owner. Surfacing 403 would
    // confirm the order exists, and order numbers are sequential: an attacker
    // could walk AK-2026-000001 upward and map the store's entire order volume.
    harness.order.findFirst.mockResolvedValue(null);

    await expect(service.getForCustomer(OTHER_ID, ORDER_NUMBER)).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
  });

  it("scopes the history list and the status poll by customer id too", async () => {
    harness.order.findMany.mockResolvedValue([]);
    await service.listForCustomer(OWNER_ID, { limit: 24 });
    expect(harness.order.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { customerId: OWNER_ID },
    });

    harness.order.findFirst.mockResolvedValue({ orderNumber: ORDER_NUMBER, status: "PAID" });
    await service.getStatusForCustomer(OWNER_ID, ORDER_NUMBER);
    expect(harness.order.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { orderNumber: ORDER_NUMBER, customerId: OWNER_ID },
    });
  });

  it("reports paid-ness and terminality on the polled status", async () => {
    harness.order.findFirst.mockResolvedValue({
      orderNumber: ORDER_NUMBER,
      status: "REFUNDED",
    });

    const status = await service.getStatusForCustomer(OWNER_ID, ORDER_NUMBER);
    expect(status).toEqual({
      orderNumber: ORDER_NUMBER,
      status: "REFUNDED",
      isPaid: true,
      isTerminal: true,
    });
  });

  it("paginates by cursor and reports hasMore without leaking the extra row", async () => {
    // The service fetches limit + 1 to detect a next page; the caller must
    // never see that probe row.
    const rows = Array.from({ length: 3 }, (_unused, index) => ({
      ...orderRow(),
      id: `bbbbbbbb-0000-4000-8000-00000000000${index}`,
      items: [{ quantity: 1 }],
    }));
    harness.order.findMany.mockResolvedValue(rows);

    const page = await service.listForCustomer(OWNER_ID, { limit: 2 });

    expect(harness.order.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 3 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("bbbbbbbb-0000-4000-8000-000000000001");
  });
});

describe("OrdersService — operator transitions", () => {
  let harness: ReturnType<typeof createPrismaFake>;
  let service: OrdersService;

  beforeEach(async () => {
    harness = createPrismaFake();
    service = await buildService(harness.fake);
  });

  /**
   * An operator marking an order PAID by hand would mean anyone with a staff
   * session can ship free product. The check runs BEFORE the order is even
   * loaded, which is asserted here: a rejection that happens after a read is a
   * rejection that a later refactor can accidentally move to after the write.
   */
  it("refuses a hand-set PAID before touching the database", async () => {
    await expect(
      service.transitionByAdmin(ORDER_NUMBER, { status: "PAID" }, STAFF),
    ).rejects.toBeInstanceOf(StatusNotAdminAssignableError);

    await expect(
      service.transitionByAdmin(ORDER_NUMBER, { status: "PAID" }, STAFF),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(harness.order.findUnique).not.toHaveBeenCalled();
    expect(harness.order.updateMany).not.toHaveBeenCalled();
  });

  it("refuses hand-set refund statuses", async () => {
    for (const status of ["REFUNDED", "PARTIALLY_REFUNDED"] as const) {
      await expect(
        service.transitionByAdmin(ORDER_NUMBER, { status }, STAFF),
      ).rejects.toBeInstanceOf(StatusNotAdminAssignableError);
    }
    expect(harness.order.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a transition the state machine does not permit", async () => {
    // DELIVERED is operator-assignable, but not reachable from PAID.
    harness.order.findUnique.mockResolvedValue(orderRow({ status: "PAID" }));

    await expect(
      service.transitionByAdmin(ORDER_NUMBER, { status: "DELIVERED" }, STAFF),
    ).rejects.toThrow(/PAID -> DELIVERED/);

    expect(harness.order.updateMany).not.toHaveBeenCalled();
  });

  it("applies a legal transition under an optimistic-concurrency guard", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID", version: 7 }))
      .mockResolvedValueOnce(detailRow({ status: "FULFILLING", version: 8 }));

    await service.transitionByAdmin(
      ORDER_NUMBER,
      { status: "FULFILLING", note: "picked" },
      STAFF,
    );

    // Expected status AND version in the WHERE clause: read-then-write would
    // let two out-of-order updates both read PAID and the loser silently
    // overwrite the winner.
    expect(harness.order.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: ORDER_ID, status: "PAID", version: 7 },
      data: { status: "FULFILLING", version: { increment: 1 } },
    });
  });

  it("409s when the order changed underneath the update", async () => {
    harness.order.findUnique.mockResolvedValue(orderRow({ status: "PAID", version: 7 }));
    harness.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.transitionByAdmin(ORDER_NUMBER, { status: "FULFILLING" }, STAFF),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("records the operator's status change as an INTERNAL event", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID", version: 0 }))
      .mockResolvedValueOnce(detailRow({ status: "CANCELLED" }));

    await service.transitionByAdmin(
      ORDER_NUMBER,
      { status: "CANCELLED", note: "suspected reseller" },
      STAFF,
    );

    // "Status changed by operator #4b2f: suspected reseller" is not something a
    // customer should read on their order timeline.
    expect(harness.orderEvent.create.mock.calls[0]?.[0]).toMatchObject({
      data: { isInternal: true, actorId: STAFF.customerId },
    });
  });

  it("stamps cancelledAt when cancelling", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID", version: 0 }))
      .mockResolvedValueOnce(detailRow({ status: "CANCELLED" }));

    await service.transitionByAdmin(ORDER_NUMBER, { status: "CANCELLED" }, STAFF);

    const call: unknown = harness.order.updateMany.mock.calls[0]?.[0];
    expect(call).toMatchObject({ data: { status: "CANCELLED" } });
    const data =
      typeof call === "object" && call !== null && "data" in call
        ? (call as { data: Record<string, unknown> }).data
        : {};
    expect(data["cancelledAt"]).toBeInstanceOf(Date);
  });
});

describe("OrdersService — markPaid", () => {
  let harness: ReturnType<typeof createPrismaFake>;
  let service: OrdersService;

  beforeEach(async () => {
    harness = createPrismaFake();
    service = await buildService(harness.fake);
  });

  /**
   * Whop retries webhooks up to 12 times and guarantees no ordering. A
   * second `payment/succeeded` for an already-PAID order must be a
   * no-op, not a 409 (which makes the provider retry forever) and above all not a
   * second invoice number — invoice numbering is legally required to be
   * gap-free, and burning one per retry destroys that.
   */
  it("is idempotent for an order that is already paid", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID" }))
      .mockResolvedValueOnce(detailRow({ status: "PAID" }));

    const result = await service.markPaid({ orderId: ORDER_ID });

    expect(result.status).toBe("PAID");
    expect(harness.queryRaw).not.toHaveBeenCalled();
    expect(harness.order.updateMany).not.toHaveBeenCalled();
  });

  it("treats a later status as already-paid rather than moving backwards", async () => {
    // The webhook can be re-delivered after the order has already shipped.
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "SHIPPED" }))
      .mockResolvedValueOnce(detailRow({ status: "SHIPPED" }));

    const result = await service.markPaid({ orderId: ORDER_ID });

    expect(result.status).toBe("SHIPPED");
    expect(harness.order.updateMany).not.toHaveBeenCalled();
  });

  it("allocates exactly one invoice number on the PAID transition", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "AWAITING_PAYMENT", version: 3 }))
      .mockResolvedValueOnce(detailRow({ status: "PAID" }));

    await service.markPaid({ orderId: ORDER_ID });

    expect(harness.queryRaw).toHaveBeenCalledTimes(1);
    expect(harness.order.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: ORDER_ID, status: "AWAITING_PAYMENT", version: 3 },
      data: { status: "PAID", invoiceNumber: "INV-2026-000045" },
    });
  });

  /**
   * A webhook can land while the order is still PENDING — the customer paid
   * before our checkout-session bookkeeping committed. PENDING -> PAID is not
   * an edge in the table, so the service WALKS through AWAITING_PAYMENT rather
   * than jumping. No rule is bent and the timeline stays truthful.
   */
  it("walks PENDING -> AWAITING_PAYMENT -> PAID rather than skipping a state", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PENDING", version: 0 }))
      .mockResolvedValueOnce(detailRow({ status: "PAID" }));

    await service.markPaid({ orderId: ORDER_ID });

    expect(harness.order.updateMany).toHaveBeenCalledTimes(2);
    expect(harness.order.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: "PENDING", version: 0 },
      data: { status: "AWAITING_PAYMENT" },
    });
    // The second hop uses the INCREMENTED version, or it would 409 against its
    // own first write.
    expect(harness.order.updateMany.mock.calls[1]?.[0]).toMatchObject({
      where: { status: "AWAITING_PAYMENT", version: 1 },
      data: { status: "PAID" },
    });
  });

  it("refuses to resurrect a cancelled order", async () => {
    harness.order.findUnique.mockResolvedValue(orderRow({ status: "CANCELLED" }));

    await expect(service.markPaid({ orderId: ORDER_ID })).rejects.toThrow(
      /CANCELLED -> PAID/,
    );
    expect(harness.queryRaw).not.toHaveBeenCalled();
  });
});

describe("OrdersService — markPaid commits reserved stock", () => {
  /**
   * The reserve/commit inventory primitives existed but no order path called them
   * (issue SEV2). markPaid is where a held reservation becomes a real SALE:
   * on-hand decremented, SALE ledger written. These tests pin that the commit
   * fires exactly on the transition to PAID and never on the idempotent
   * re-delivery of an already-paid order — a second commit would double-decrement.
   */
  let harness: ReturnType<typeof createPrismaFake>;
  let inventory: { commitReservationsForOrder: Mock };
  let service: OrdersService;

  beforeEach(async () => {
    harness = createPrismaFake();
    inventory = createInventoryFake();
    service = await buildService(harness.fake, inventory);
  });

  it("commits the order's reservations once it reaches PAID", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "AWAITING_PAYMENT", version: 3 }))
      .mockResolvedValueOnce(detailRow({ status: "PAID" }));

    await service.markPaid({ orderId: ORDER_ID });

    expect(inventory.commitReservationsForOrder).toHaveBeenCalledTimes(1);
    expect(inventory.commitReservationsForOrder).toHaveBeenCalledWith(ORDER_ID);
  });

  it("does NOT re-commit stock for an order that was already paid", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID" }))
      .mockResolvedValueOnce(detailRow({ status: "PAID" }));

    await service.markPaid({ orderId: ORDER_ID });

    // A redelivered webhook must not decrement stock a second time.
    expect(inventory.commitReservationsForOrder).not.toHaveBeenCalled();
  });
});

describe("OrdersService — refunds", () => {
  let harness: ReturnType<typeof createPrismaFake>;
  let service: OrdersService;

  const payment = { id: "ffffffff-0000-4000-8000-000000000001", status: "SUCCEEDED" };

  beforeEach(async () => {
    harness = createPrismaFake();
    service = await buildService(harness.fake);
  });

  it("refuses to refund more than the order's remaining balance", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "PAID", grandTotal: 10_000, refundedTotal: 0 }),
      payments: [payment],
      refunds: [],
    });

    await expect(
      service.requestRefund(
        ORDER_NUMBER,
        { amount: 10_001, reason: "REQUESTED_BY_CUSTOMER", restockVariantIds: [] },
        STAFF,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(harness.refund.create).not.toHaveBeenCalled();
  });

  /** The double-spend guard: two operators refunding the same order at once. */
  it("counts an in-flight PENDING refund against the balance", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "PAID", grandTotal: 10_000, refundedTotal: 0 }),
      payments: [payment],
      refunds: [{ amount: 6000, status: "PENDING" }],
    });

    await expect(
      service.requestRefund(
        ORDER_NUMBER,
        { amount: 5000, reason: "REQUESTED_BY_CUSTOMER", restockVariantIds: [] },
        STAFF,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("defaults an omitted amount to the remaining refundable balance", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "PAID", grandTotal: 10_000, refundedTotal: 2500 }),
      payments: [payment],
      refunds: [],
    });
    harness.refund.create.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000aa",
      paymentId: payment.id,
      orderId: ORDER_ID,
      status: "PENDING",
      reason: "REQUESTED_BY_CUSTOMER",
      amount: 7500,
      currency: "EUR",
      providerRefundId: null,
      note: null,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      completedAt: null,
    });

    await service.requestRefund(
      ORDER_NUMBER,
      { reason: "REQUESTED_BY_CUSTOMER", restockVariantIds: [] },
      STAFF,
    );

    expect(harness.refund.create.mock.calls[0]?.[0]).toMatchObject({
      data: { amount: 7500, status: "PENDING" },
    });
  });

  /**
   * The request records INTENT. If it also moved refundedTotal or set the order
   * to REFUNDED, the customer would be told their money was returned before it
   * left our account — and they act on that: they leave, they chargeback, they
   * post about it.
   */
  it("does not move money or status when a refund is merely requested", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "PAID", grandTotal: 10_000 }),
      payments: [payment],
      refunds: [],
    });
    harness.refund.create.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000aa",
      paymentId: payment.id,
      orderId: ORDER_ID,
      status: "PENDING",
      reason: "DAMAGED",
      amount: 1000,
      currency: "EUR",
      providerRefundId: null,
      note: null,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      completedAt: null,
    });

    const refund = await service.requestRefund(
      ORDER_NUMBER,
      { amount: 1000, reason: "DAMAGED", restockVariantIds: [] },
      STAFF,
    );

    expect(refund.status).toBe("PENDING");
    expect(harness.order.updateMany).not.toHaveBeenCalled();
    expect(harness.order.update).not.toHaveBeenCalled();
  });

  it("refuses a refund on an order that was never paid", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "AWAITING_PAYMENT" }),
      payments: [],
      refunds: [],
    });

    await expect(
      service.requestRefund(
        ORDER_NUMBER,
        { reason: "REQUESTED_BY_CUSTOMER", restockVariantIds: [] },
        STAFF,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a refund with no settled payment behind it", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "PAID" }),
      payments: [],
      refunds: [],
    });

    await expect(
      service.requestRefund(
        ORDER_NUMBER,
        { reason: "REQUESTED_BY_CUSTOMER", restockVariantIds: [] },
        STAFF,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("moves the order to REFUNDED only when the refund settles in full", async () => {
    harness.refund.findUnique.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000aa",
      orderId: ORDER_ID,
      paymentId: payment.id,
      status: "PENDING",
      amount: 10_000,
      currency: "EUR",
    });
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID", grandTotal: 10_000, version: 4 }))
      .mockResolvedValue(detailRow({ status: "REFUNDED" }));
    harness.refund.update.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000aa",
      paymentId: payment.id,
      orderId: ORDER_ID,
      status: "SUCCEEDED",
      reason: "REQUESTED_BY_CUSTOMER",
      amount: 10_000,
      currency: "EUR",
      providerRefundId: "re_123",
      note: null,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      completedAt: new Date("2026-07-03T00:00:00.000Z"),
    });

    await service.settleRefund({
      refundId: "ffffffff-0000-4000-8000-0000000000aa",
      providerRefundId: "re_123",
    });

    expect(harness.order.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: ORDER_ID, status: "PAID", version: 4 },
      data: { status: "REFUNDED", refundedTotal: 10_000 },
    });
  });

  it("lands on PARTIALLY_REFUNDED for a partial settlement", async () => {
    harness.refund.findUnique.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000ab",
      orderId: ORDER_ID,
      paymentId: payment.id,
      status: "PENDING",
      amount: 2500,
      currency: "EUR",
    });
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID", grandTotal: 10_000, version: 1 }))
      .mockResolvedValue(detailRow({ status: "PARTIALLY_REFUNDED" }));
    harness.refund.update.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000ab",
      paymentId: payment.id,
      orderId: ORDER_ID,
      status: "SUCCEEDED",
      reason: "DAMAGED",
      amount: 2500,
      currency: "EUR",
      providerRefundId: null,
      note: null,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      completedAt: new Date("2026-07-03T00:00:00.000Z"),
    });

    await service.settleRefund({ refundId: "ffffffff-0000-4000-8000-0000000000ab" });

    expect(harness.order.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { status: "PARTIALLY_REFUNDED", refundedTotal: 2500 },
    });
  });

  it("is idempotent for a refund that already settled", async () => {
    harness.refund.findUnique.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000aa",
      paymentId: payment.id,
      orderId: ORDER_ID,
      status: "SUCCEEDED",
      reason: "DAMAGED",
      amount: 2500,
      currency: "EUR",
      providerRefundId: "re_123",
      note: null,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      completedAt: new Date("2026-07-03T00:00:00.000Z"),
    });

    await service.settleRefund({ refundId: "ffffffff-0000-4000-8000-0000000000aa" });

    // The provider re-delivers this event; refundedTotal must not double.
    expect(harness.order.updateMany).not.toHaveBeenCalled();
    expect(harness.order.update).not.toHaveBeenCalled();
  });

  it("refuses to settle a refund that would exceed the order total", async () => {
    harness.refund.findUnique.mockResolvedValue({
      id: "ffffffff-0000-4000-8000-0000000000ac",
      orderId: ORDER_ID,
      paymentId: payment.id,
      status: "PENDING",
      amount: 9000,
      currency: "EUR",
    });
    harness.order.findUnique.mockResolvedValue(
      orderRow({ status: "PARTIALLY_REFUNDED", grandTotal: 10_000, refundedTotal: 5000 }),
    );

    await expect(
      service.settleRefund({ refundId: "ffffffff-0000-4000-8000-0000000000ac" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * REQUIREMENT 3 — "tell the customer about everything" — is a PRODUCER problem.
 * `shipping-confirmation`, `delivery-confirmation` and `order-cancelled` all had
 * a payload schema, a bilingual renderer and fixtures, and not one line of code
 * anywhere enqueued them. These tests are the producers.
 *
 * Every enqueue happens INSIDE the same transaction as the state change it
 * describes. That is the whole point of the outbox: "the parcel is recorded AND
 * the customer will be told" is one atomic fact, not two that can disagree.
 */
const SHIPMENT_ID = "dddddddd-0000-4000-8000-000000000001";
const ORDER_ITEM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

interface ShipmentRowOverrides {
  readonly trackingNumber?: string | null;
  readonly trackingUrl?: string | null;
  readonly quantity?: number;
}

function shipmentRow(overrides: ShipmentRowOverrides = {}): Record<string, unknown> {
  return {
    id: SHIPMENT_ID,
    orderId: ORDER_ID,
    status: "IN_TRANSIT",
    carrier: "SEUR",
    trackingNumber:
      overrides.trackingNumber === undefined ? "SE123456789ES" : overrides.trackingNumber,
    trackingUrl: overrides.trackingUrl ?? null,
    shippedAt: new Date("2026-07-21T09:00:00.000Z"),
    deliveredAt: null,
    createdAt: new Date("2026-07-21T09:00:00.000Z"),
    items: [{ orderItemId: ORDER_ITEM_ID, quantity: overrides.quantity ?? 1 }],
  };
}

/** The `payload` field of the single outbox row an assertion is about. */
function enqueuedEmail(outbox: { readonly create: Mock }, index = 0): Record<string, unknown> {
  const call: unknown = outbox.create.mock.calls[index]?.[0];
  const data =
    typeof call === "object" && call !== null && "data" in call
      ? (call as { data: Record<string, unknown> }).data
      : {};
  const payload = data["payload"];
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

describe("OrdersService — shipping-confirmation producer", () => {
  let harness: ReturnType<typeof createPrismaFake>;
  let service: OrdersService;

  beforeEach(async () => {
    harness = createPrismaFake();
    service = await buildService(harness.fake);
    harness.order.findUnique.mockResolvedValue({
      ...detailRow({ status: "PAID", version: 2 }),
      shipments: [],
    });
    harness.shipment.create.mockResolvedValue(shipmentRow());
  });

  it("enqueues a HYDRATED shipping-confirmation scoped by the SHIPMENT id", async () => {
    await service.createShipment(
      ORDER_NUMBER,
      { carrier: "SEUR", trackingNumber: "SE123456789ES", items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1 }] },
      STAFF,
    );

    expect(harness.outboxMessage.create).toHaveBeenCalledTimes(1);
    const envelope = enqueuedEmail(harness.outboxMessage);
    expect(envelope["templateKey"]).toBe("shipping-confirmation");
    expect(envelope["to"]).toBe("cliente@example.com");
    expect(envelope["orderId"]).toBe(ORDER_ID);
    // WITHOUT this the second parcel's claim collides with the first, `send`
    // reports `duplicate`, the handler counts that as terminal success, and the
    // customer is simply never told about parcel two.
    expect(envelope["dedupeScope"]).toBe(SHIPMENT_ID);
  });

  it("prices the mail's lines by what was SHIPPED, not by what was ordered", async () => {
    await service.createShipment(
      ORDER_NUMBER,
      { carrier: "SEUR", trackingNumber: "SE123456789ES", items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1 }] },
      STAFF,
    );

    const payload = enqueuedEmail(harness.outboxMessage)["payload"];
    const parsed = parseTemplatePayload("shipping-confirmation", payload);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]?.quantity).toBe(1);
    // The order line is 2 x 49,99 = 99,98. This parcel holds ONE unit, so the
    // mail must say 49,99 — quoting the order total on a partial shipment tells
    // the customer the whole order is on its way when half of it is not.
    expect(parsed.lines[0]?.lineTotal).toEqual({ amount: 4999, currency: "EUR" });
    expect(parsed.orderUrl).toBe("https://dash.akai.test/orders/AK-2026-000123");
    expect(parsed.carrier).toBe("SEUR");
  });

  it("still enqueues a schema-valid mail for an UNTRACKED parcel", async () => {
    // `shipment.trackingNumber` is nullable and `trackingUrl` is never written
    // by this path. A required trackingUrl would fail the payload schema, and a
    // payload that fails its schema DEAD-LETTERS — so the customer would hear
    // nothing at all about exactly the parcels that are hardest to chase.
    harness.shipment.create.mockResolvedValue(
      shipmentRow({ trackingNumber: null, trackingUrl: null }),
    );

    await service.createShipment(
      ORDER_NUMBER,
      { carrier: "Correos", trackingNumber: null, items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1 }] },
      STAFF,
    );

    const payload = enqueuedEmail(harness.outboxMessage)["payload"];
    const parsed = parseTemplatePayload("shipping-confirmation", payload);
    expect(parsed.trackingNumber).toBeUndefined();
    expect(parsed.trackingUrl).toBeUndefined();
    expect(parsed.orderUrl).toBe("https://dash.akai.test/orders/AK-2026-000123");
  });
});

describe("OrdersService — delivery-confirmation producer", () => {
  let harness: ReturnType<typeof createPrismaFake>;
  let service: OrdersService;

  beforeEach(async () => {
    harness = createPrismaFake();
    service = await buildService(harness.fake);
    harness.shipment.findUnique.mockResolvedValue(shipmentRow());
    harness.shipment.update.mockResolvedValue({
      ...shipmentRow(),
      status: "DELIVERED",
      deliveredAt: new Date("2026-07-23T14:30:00.000Z"),
    });
  });

  it("mails the customer once every parcel has landed", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "SHIPPED", version: 3 }),
      shipments: [{ status: "DELIVERED" }],
    });
    harness.order.findUnique.mockResolvedValueOnce({
      ...orderRow({ status: "SHIPPED", version: 3 }),
      shipments: [{ status: "DELIVERED" }],
    });

    await service.markShipmentDelivered(SHIPMENT_ID, STAFF);

    expect(harness.outboxMessage.create).toHaveBeenCalledTimes(1);
    const envelope = enqueuedEmail(harness.outboxMessage);
    expect(envelope["templateKey"]).toBe("delivery-confirmation");
    expect(envelope["orderId"]).toBe(ORDER_ID);
    // A reference envelope: deliveredAt and orderUrl are both derivable from
    // the live order, so the payload is assembled at send time.
    expect(envelope["payload"]).toBeUndefined();
  });

  it("says NOTHING while a parcel is still in transit", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "SHIPPED", version: 3 }),
      shipments: [{ status: "DELIVERED" }, { status: "IN_TRANSIT" }],
    });

    await service.markShipmentDelivered(SHIPMENT_ID, STAFF);

    // "Your order was delivered" while half of it is on a van is worse than
    // silence: the customer stops watching for the rest of it.
    expect(harness.outboxMessage.create).not.toHaveBeenCalled();
  });

  it("holds the order short of DELIVERED while another parcel is returned or lost", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "SHIPPED", version: 3 }),
      shipments: [{ status: "DELIVERED" }, { status: "RETURNED" }],
    });

    await service.markShipmentDelivered(SHIPMENT_ID, STAFF);

    expect(harness.outboxMessage.create).not.toHaveBeenCalled();
  });

  it("does not re-mail an already-delivered parcel", async () => {
    harness.shipment.findUnique.mockResolvedValue({
      ...shipmentRow(),
      status: "DELIVERED",
      deliveredAt: new Date("2026-07-23T14:30:00.000Z"),
    });

    await service.markShipmentDelivered(SHIPMENT_ID, STAFF);

    expect(harness.outboxMessage.create).not.toHaveBeenCalled();
  });

  it("accepts NO actor — an automated carrier integration delivers on the carrier's word", async () => {
    harness.order.findUnique.mockResolvedValue({
      ...orderRow({ status: "SHIPPED", version: 3 }),
      shipments: [{ status: "DELIVERED" }],
    });

    await service.markShipmentDelivered(SHIPMENT_ID, null);

    const eventArgs: unknown = harness.orderEvent.create.mock.calls[0]?.[0];
    expect(eventArgs).toMatchObject({ data: { type: "ORDER_DELIVERED", actorId: null } });
    expect(enqueuedEmail(harness.outboxMessage)["templateKey"]).toBe("delivery-confirmation");
  });
});

describe("OrdersService — order-cancelled producer", () => {
  let harness: ReturnType<typeof createPrismaFake>;
  let service: OrdersService;

  beforeEach(async () => {
    harness = createPrismaFake();
    service = await buildService(harness.fake);
  });

  it("writes a CUSTOMER-FACING cancellation event and enqueues the mail", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID", version: 0 }))
      .mockResolvedValueOnce(detailRow({ status: "CANCELLED" }));

    await service.transitionByAdmin(
      ORDER_NUMBER,
      { status: "CANCELLED", note: "suspected reseller" },
      STAFF,
    );

    // The hydrate branch reads a `payment.canceled` OrderEvent for the reason
    // line. NOTHING in the platform wrote one, so every cancellation mail would
    // have fallen back to a contentless generic string.
    const events = harness.orderEvent.create.mock.calls.map((call: unknown[]) => {
      const arg: unknown = call[0];
      return typeof arg === "object" && arg !== null && "data" in arg
        ? (arg as { data: Record<string, unknown> }).data
        : {};
    });
    const customerFacing = events.find((data) => data["type"] === "payment.canceled");
    expect(customerFacing).toBeDefined();
    expect(customerFacing?.["isInternal"]).toBe(false);

    // AND the operator's own note must not be in it. "suspected reseller" is
    // written for a colleague, and this event is rendered into the customer's
    // email and onto their order timeline.
    expect(String(customerFacing?.["message"])).not.toContain("suspected reseller");
    expect(String(customerFacing?.["message"]).length).toBeGreaterThan(0);

    const envelope = enqueuedEmail(harness.outboxMessage);
    expect(envelope["templateKey"]).toBe("order-cancelled");
    expect(envelope["orderId"]).toBe(ORDER_ID);
    // A REFERENCE envelope names the address as `recipient`, not `to`: the
    // handler resolves the real destination from the live order, so this is a
    // hint for the log rather than the address that is actually used.
    expect(envelope["recipient"]).toBe("cliente@example.com");
    expect(envelope["payload"]).toBeUndefined();
  });

  it("enqueues nothing for a transition that is not a cancellation", async () => {
    harness.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: "PAID", version: 0 }))
      .mockResolvedValueOnce(detailRow({ status: "FULFILLING" }));

    await service.transitionByAdmin(ORDER_NUMBER, { status: "FULFILLING" }, STAFF);

    // PAID -> FULFILLING is warehouse bookkeeping. The customer-facing signal
    // is the shipping mail, which fires when a parcel actually exists.
    expect(harness.outboxMessage.create).not.toHaveBeenCalled();
  });
});

describe("OrdersService.createFromCart — packs", () => {
  const CART_ID = "dddddddd-0000-4000-8000-000000000001";
  const PACK_PRODUCT_ID = "10000000-0000-4000-8000-000000000099";
  const PACK_INSTANCE_ID = "99999999-0000-4000-8000-000000000001";
  const VARIANT_A = "20000000-0000-4000-8000-000000000001";
  const VARIANT_B = "20000000-0000-4000-8000-000000000002";
  const VARIANT_C = "20000000-0000-4000-8000-000000000003";

  const ADDRESS = {
    firstName: "Valentina",
    lastName: "Restrepo",
    company: null,
    line1: "Calle 10 # 43-21",
    line2: null,
    city: "Medellín",
    region: "Antioquia",
    postalCode: null,
    countryCode: "CO",
    phone: "3001234567",
  };

  function componentItem(
    id: string,
    variantId: string,
    priceGross: number,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id,
      variantId,
      quantity: 1,
      packProductId: PACK_PRODUCT_ID,
      packInstanceId: PACK_INSTANCE_ID,
      variant: {
        id: variantId,
        sku: `AK-${variantId.slice(-1)}`,
        priceGross,
        currency: "EUR",
        isActive: true,
        deletedAt: null,
        name: { es: "Variante" },
        product: {
          slug: `producto-${variantId.slice(-1)}`,
          taxClass: "STANDARD",
          translations: [{ locale: "es", name: `Producto ${variantId.slice(-1)}` }],
          media: [],
        },
      },
      ...overrides,
    };
  }

  function standaloneItem(id: string, variantId: string, priceGross: number) {
    return {
      id,
      variantId,
      quantity: 1,
      packProductId: null,
      packInstanceId: null,
      variant: {
        id: variantId,
        sku: "AK-STANDALONE",
        priceGross,
        currency: "EUR",
        isActive: true,
        deletedAt: null,
        name: { es: "Variante" },
        product: {
          slug: "producto-suelto",
          taxClass: "STANDARD",
          translations: [{ locale: "es", name: "Producto suelto" }],
          media: [],
        },
      },
    };
  }

  function cartRow(items: unknown[], overrides: Record<string, unknown> = {}) {
    return {
      id: CART_ID,
      customerId: null,
      currency: "EUR",
      discountCode: null,
      items,
      ...overrides,
    };
  }

  /**
   * The pack PRODUCT row `tx.product.findMany` resolves — its own flat
   * price plus its CURRENT recipe (`packComponents`), fetched fresh rather
   * than trusted from the cart. Defaults to the same 3-component recipe
   * (VARIANT_A/B/C, quantity 1 each) every `componentItem` fixture in this
   * file assumes.
   */
  function packRow(
    priceGross: number,
    components: readonly { variantId: string; quantity: number }[] = [
      { variantId: VARIANT_A, quantity: 1 },
      { variantId: VARIANT_B, quantity: 1 },
      { variantId: VARIANT_C, quantity: 1 },
    ],
  ) {
    return {
      id: PACK_PRODUCT_ID,
      variants: [{ priceGross }],
      packComponents: components.map((component) => ({
        componentVariantId: component.variantId,
        quantity: component.quantity,
      })),
    };
  }

  async function buildOrdersHarness() {
    const harness = createPrismaFake();
    harness.order.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        const itemsCreate = (args.data["items"] as { create: Record<string, unknown>[] }).create;
        const eventsCreate = (args.data["events"] as { create: Record<string, unknown>[] }).create;
        return {
          id: "order-uuid-1",
          ...args.data,
          items: itemsCreate.map((item, index) => ({ ...item, id: `oi-${index}` })),
          events: eventsCreate.map((event, index) => ({
            ...event,
            id: `oe-${index}`,
            createdAt: new Date("2026-07-20T10:00:00.000Z"),
          })),
          // What Prisma returns for ORDER_DETAIL_INCLUDE on a fresh order.
          shipments: [],
          placedAt: new Date("2026-07-20T10:00:00.000Z"),
          updatedAt: new Date("2026-07-20T10:00:00.000Z"),
          paidAt: null,
          cancelledAt: null,
          version: 0,
          refundedTotal: 0,
          invoiceNumber: null,
        };
      },
    );
    const service = await buildService(harness.fake);
    return { harness, service };
  }

  function baseInput(cartId: string = CART_ID) {
    return {
      cartId,
      customerId: null,
      email: "cliente@example.com",
      locale: "es" as const,
      shippingAddress: ADDRESS,
      billingAddress: ADDRESS,
      shipping: { net: toMinor(0), taxRateBps: 1900 },
      shippingMethodName: "Envío nacional",
      acceptedTermsVersion: "2026-01",
      customerDocument: { type: "CC" as const, number: "1020304050" },
    };
  }

  it("charges each component its pro-rata SHARE of the pack price, never its own standalone price", async () => {
    const { harness, service } = await buildOrdersHarness();
    // Components priced 1000/2000/3000 standalone; the pack itself sells for
    // 5499 — none of the three lines may be charged its own 1000/2000/3000.
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([
        componentItem("item-a", VARIANT_A, 1000),
        componentItem("item-b", VARIANT_B, 2000),
        componentItem("item-c", VARIANT_C, 3000),
      ]),
    );
    harness.product.findMany.mockResolvedValueOnce([packRow(5499)]);

    const order = await service.createFromCart(baseInput());

    expect(order.items).toHaveLength(3);
    for (const item of order.items) {
      expect([1000, 2000, 3000]).not.toContain(item.unitPriceGross);
      expect(item.packProductId).toBe(PACK_PRODUCT_ID);
      expect(item.packInstanceId).toBe(PACK_INSTANCE_ID);
    }
    // Exactly the flat pack price, no cent lost or gained.
    const total = order.items.reduce((sum, item) => sum + item.lineTotalGross, 0);
    expect(total).toBe(5499);
  });

  it("snapshots the buyer's identity document and the chosen rate onto the order row", async () => {
    const { harness, service } = await buildOrdersHarness();
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([standaloneItem("item-x", VARIANT_A, 4999)]),
    );

    const order = await service.createFromCart({
      ...baseInput(),
      customerDocument: { type: "NIT", number: "800197268-4" },
      shippingRateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });

    const args: unknown = harness.order.create.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      data: {
        documentType: "NIT",
        documentNumber: "800197268-4",
        shippingRateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        shipRegion: "Antioquia",
        shipPostalCode: null,
        shipPhone: "3001234567",
      },
    });
    expect(order.documentType).toBe("NIT");
    expect(order.documentNumber).toBe("800197268-4");
  });

  it("prices proportionally to each component's own live price, not evenly", async () => {
    const { harness, service } = await buildOrdersHarness();
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([
        componentItem("item-a", VARIANT_A, 1000),
        componentItem("item-b", VARIANT_B, 2000),
        componentItem("item-c", VARIANT_C, 3000),
      ]),
    );
    harness.product.findMany.mockResolvedValueOnce([packRow(6000)]);

    const order = await service.createFromCart(baseInput());

    const byVariant = new Map(order.items.map((item) => [item.variantId, item.unitPriceGross]));
    expect(byVariant.get(VARIANT_A)).toBe(1000);
    expect(byVariant.get(VARIANT_B)).toBe(2000);
    expect(byVariant.get(VARIANT_C)).toBe(3000);
  });

  it("throws ConflictException when the pack has vanished (deleted, or no longer kind PACK)", async () => {
    const { harness, service } = await buildOrdersHarness();
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([
        componentItem("item-a", VARIANT_A, 1000),
        componentItem("item-b", VARIANT_B, 2000),
        componentItem("item-c", VARIANT_C, 3000),
      ]),
    );
    // The pack query (`kind: PACK, deletedAt: null`) comes back empty.
    harness.product.findMany.mockResolvedValueOnce([]);

    await expect(service.createFromCart(baseInput())).rejects.toBeInstanceOf(ConflictException);
    expect(harness.order.create).not.toHaveBeenCalled();
  });

  it("leaves an ordinary standalone line priced at its own live variant price", async () => {
    const { harness, service } = await buildOrdersHarness();
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([standaloneItem("item-x", VARIANT_A, 4999)]),
    );

    const order = await service.createFromCart(baseInput());

    expect(order.items).toHaveLength(1);
    expect(order.items[0]?.unitPriceGross).toBe(4999);
    expect(order.items[0]?.packProductId).toBeNull();
    expect(order.items[0]?.packInstanceId).toBeNull();
    // No pack in this cart — the (empty) pack lookup must not even run.
    expect(harness.product.findMany).not.toHaveBeenCalled();
  });

  it("a pack line and an ordinary line for the SAME variant price independently in one order", async () => {
    const { harness, service } = await buildOrdersHarness();
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([
        componentItem("item-a", VARIANT_A, 1000),
        componentItem("item-b", VARIANT_B, 2000),
        componentItem("item-c", VARIANT_C, 3000),
        standaloneItem("item-standalone", VARIANT_A, 1000),
      ]),
    );
    harness.product.findMany.mockResolvedValueOnce([packRow(5499)]);

    const order = await service.createFromCart(baseInput());

    expect(order.items).toHaveLength(4);
    const linesForVariantA = order.items.filter((item) => item.variantId === VARIANT_A);
    expect(linesForVariantA).toHaveLength(2);
    const standaloneLine = linesForVariantA.find((item) => item.packInstanceId === null);
    expect(standaloneLine?.unitPriceGross).toBe(1000);
    const packLine = linesForVariantA.find((item) => item.packInstanceId === PACK_INSTANCE_ID);
    expect(packLine?.unitPriceGross).not.toBe(1000);
  });

  it("a component with quantity > 1 still sums exactly to the pack price, split across at most 2 order lines", async () => {
    const { harness, service } = await buildOrdersHarness();
    // "b" claims 5 units per pack — the cart's stored row already reflects
    // that (quantity: 5, one pack bought).
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([
        componentItem("item-a", VARIANT_A, 1000),
        componentItem("item-b", VARIANT_B, 1000, { quantity: 5 }),
        componentItem("item-c", VARIANT_C, 3000),
      ]),
    );
    harness.product.findMany.mockResolvedValueOnce([
      packRow(5499, [
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_B, quantity: 5 },
        { variantId: VARIANT_C, quantity: 1 },
      ]),
    ]);

    const order = await service.createFromCart(baseInput());

    const bLines = order.items.filter((item) => item.variantId === VARIANT_B);
    expect(bLines.length).toBeLessThanOrEqual(2);
    expect(bLines.reduce((sum, item) => sum + item.quantity, 0)).toBe(5);

    // Exactly the flat pack price, no cent lost or gained, regardless of the
    // split.
    const total = order.items.reduce((sum, item) => sum + item.lineTotalGross, 0);
    expect(total).toBe(5499);
  });

  it("refuses a pack whose recipe changed since it was added, rather than charging against a stale one", async () => {
    const { harness, service } = await buildOrdersHarness();
    harness.cart.findUnique.mockResolvedValueOnce(
      cartRow([
        componentItem("item-a", VARIANT_A, 1000),
        componentItem("item-b", VARIANT_B, 2000),
        componentItem("item-c", VARIANT_C, 3000),
      ]),
    );
    // The live recipe no longer contains ANY of the cart's stored variants —
    // as if the admin replaced every component after this cart's items were
    // added.
    const REPLACED_VARIANT = "20000000-0000-4000-8000-000000000099";
    harness.product.findMany.mockResolvedValueOnce([
      packRow(5499, [{ variantId: REPLACED_VARIANT, quantity: 1 }]),
    ]);

    await expect(service.createFromCart(baseInput())).rejects.toBeInstanceOf(ConflictException);
    expect(harness.order.create).not.toHaveBeenCalled();
  });
});
