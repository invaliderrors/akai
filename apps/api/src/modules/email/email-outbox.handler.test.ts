import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";
import { EmailOutboxHandler } from "./email-outbox.handler";
import type { EmailDispatchResult, EmailService } from "./email.service";
import { parseTemplatePayload } from "./email.templates";
import type { PrismaService } from "../prisma/prisma.service";
import type { OutboxMessage } from "../outbox/outbox.types";

const CONFIG = {
  DASHBOARD_URL: "https://dash.akai.test/",
  EMAIL_FROM: "ops@akai.test",
} as unknown as ServerEnv;

const MESSAGE: OutboxMessage = { id: "ob-1", topic: "email", payload: {}, attempts: 1 };

interface SendCall {
  readonly templateKey: string;
  readonly to: string;
  readonly locale: string;
  readonly data: unknown;
  readonly orderId?: string;
  readonly dedupeScope?: string;
}

function buildOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orderNumber: "AK-2026-000123",
    email: "buyer@example.com",
    locale: "es",
    currency: "EUR",
    subtotal: 4999,
    discountTotal: 0,
    shippingTotal: 500,
    taxTotal: 950,
    grandTotal: 6449,
    refundedTotal: 0,
    shipFirstName: "Marta",
    invoiceNumber: null,
    placedAt: new Date("2026-07-20T10:00:00.000Z"),
    paidAt: new Date("2026-07-20T10:05:00.000Z"),
    cancelledAt: null,
    updatedAt: new Date("2026-07-20T10:06:00.000Z"),
    customer: { firstName: "Marta" },
    items: [
      {
        productName: "BPC-157",
        variantName: "5mg",
        quantity: 2,
        unitPriceGross: 2224,
        lineTotalGross: 4449,
      },
      {
        productName: "TB-500",
        variantName: null,
        quantity: 1,
        unitPriceGross: 2000,
        lineTotalGross: 2000,
      },
    ],
    ...overrides,
  };
}

interface HandlerOptions {
  order?: Record<string, unknown> | null;
  event?: { message: string } | null;
  result?: EmailDispatchResult;
}

function makeHandler(options: HandlerOptions): {
  handler: EmailOutboxHandler;
  sends: SendCall[];
} {
  const sends: SendCall[] = [];
  const emails = {
    sendChecked: vi.fn(async (input: SendCall): Promise<EmailDispatchResult> => {
      sends.push(input);
      return (
        options.result ?? {
          status: "sent",
          eventId: "ev-1",
          providerMessageId: "prov-1",
          attempts: 1,
        }
      );
    }),
  } as unknown as EmailService;

  const prisma = {
    order: {
      findUnique: vi.fn(async () =>
        options.order === undefined ? buildOrder() : options.order,
      ),
    },
    orderEvent: { findFirst: vi.fn(async () => options.event ?? null) },
  } as unknown as PrismaService;

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;

  const handler = new EmailOutboxHandler(emails, prisma, CONFIG, logger);
  return { handler, sends };
}

describe("EmailOutboxHandler — hydrated (auth) rows", () => {
  it("sends a fully-hydrated payload straight through", async () => {
    const { handler, sends } = makeHandler({});
    await handler.handle(
      {
        templateKey: "verify-email",
        to: "buyer@example.com",
        locale: "en",
        payload: {
          firstName: "Marta",
          verifyUrl: "https://dash.akai.test/verify-email?token=abc",
          expiresInHours: 24,
        },
      },
      MESSAGE,
    );

    expect(sends).toHaveLength(1);
    expect(sends[0]?.templateKey).toBe("verify-email");
    expect(sends[0]?.to).toBe("buyer@example.com");
    // No orderId on an auth mail.
    expect(sends[0]?.orderId).toBeUndefined();
  });
});

describe("EmailOutboxHandler — reference (order) rows", () => {
  it("hydrates order-confirmation into a payload that satisfies the template schema", async () => {
    const { handler, sends } = makeHandler({});
    await handler.handle(
      { templateKey: "order-confirmation", orderId: buildOrder()["id"], locale: "es" },
      MESSAGE,
    );

    expect(sends).toHaveLength(1);
    const call = sends[0];
    expect(call?.to).toBe("buyer@example.com");
    // Idempotency key is threaded so a webhook retry cannot double-send.
    expect(call?.orderId).toBe(buildOrder()["id"]);
    // The load-bearing assertion: the built payload is VALID for the template.
    expect(() => parseTemplatePayload("order-confirmation", call?.data)).not.toThrow();
    const parsed = parseTemplatePayload("order-confirmation", call?.data);
    expect(parsed.orderNumber).toBe("AK-2026-000123");
    expect(parsed.lines).toHaveLength(2);
    // Single-variant line drops variantName rather than sending null.
    expect(parsed.lines[1]?.variantName).toBeUndefined();
    expect(parsed.grandTotal).toEqual({ amount: 6449, currency: "EUR" });
    expect(parsed.orderUrl).toBe("https://dash.akai.test/orders/AK-2026-000123");
  });

  it("routes admin-new-order to the ops inbox with a schema-valid payload", async () => {
    const { handler, sends } = makeHandler({});
    await handler.handle(
      { templateKey: "admin-new-order", orderId: buildOrder()["id"], locale: "es" },
      MESSAGE,
    );

    const call = sends[0];
    expect(call?.to).toBe("ops@akai.test");
    const parsed = parseTemplatePayload("admin-new-order", call?.data);
    expect(parsed.customerEmail).toBe("buyer@example.com");
    expect(parsed.itemCount).toBe(3);
  });

  it("builds a schema-valid refund-confirmation from the row amount", async () => {
    const { handler, sends } = makeHandler({});
    await handler.handle(
      {
        templateKey: "refund-confirmation",
        orderId: buildOrder()["id"],
        locale: "es",
        amount: 2000,
        currency: "EUR",
      },
      MESSAGE,
    );

    const parsed = parseTemplatePayload("refund-confirmation", sends[0]?.data);
    expect(parsed.refundAmount).toEqual({ amount: 2000, currency: "EUR" });
    // 2000 < grandTotal 6449, so it is a partial refund.
    expect(parsed.isPartial).toBe(true);
  });

  it("defers payment-receipt until an invoice number exists", async () => {
    const { handler, sends } = makeHandler({ order: buildOrder({ invoiceNumber: null }) });
    await expect(
      handler.handle(
        { templateKey: "payment-receipt", orderId: buildOrder()["id"], locale: "es" },
        MESSAGE,
      ),
    ).rejects.toThrow(/invoice/i);
    expect(sends).toHaveLength(0);
  });

  it("sends payment-receipt once the invoice number is present", async () => {
    const { handler, sends } = makeHandler({
      order: buildOrder({ invoiceNumber: "INV-2026-000045" }),
    });
    await handler.handle(
      { templateKey: "payment-receipt", orderId: buildOrder()["id"], locale: "es" },
      MESSAGE,
    );
    const parsed = parseTemplatePayload("payment-receipt", sends[0]?.data);
    expect(parsed.invoiceNumber).toBe("INV-2026-000045");
  });
});

describe("EmailOutboxHandler — result mapping and validation", () => {
  it("returns without throwing on a duplicate (idempotent success)", async () => {
    const { handler } = makeHandler({
      result: { status: "duplicate", templateKey: "order-confirmation" },
    });
    await expect(
      handler.handle(
        { templateKey: "order-confirmation", orderId: buildOrder()["id"], locale: "es" },
        MESSAGE,
      ),
    ).resolves.toBeUndefined();
  });

  it("returns without throwing on a suppressed recipient", async () => {
    const { handler } = makeHandler({
      result: { status: "suppressed", reason: "hard-bounce" },
    });
    await expect(
      handler.handle(
        { templateKey: "order-confirmation", orderId: buildOrder()["id"], locale: "es" },
        MESSAGE,
      ),
    ).resolves.toBeUndefined();
  });

  it("throws on a transient failure so the dispatcher retries", async () => {
    const { handler } = makeHandler({
      result: { status: "failed", eventId: "ev-1", error: "Resend 503", attempts: 1 },
    });
    await expect(
      handler.handle(
        { templateKey: "order-confirmation", orderId: buildOrder()["id"], locale: "es" },
        MESSAGE,
      ),
    ).rejects.toThrow(/delivery failed/i);
  });

  it("throws on an unrecognised payload shape", async () => {
    const { handler } = makeHandler({});
    await expect(handler.handle({ nonsense: true }, MESSAGE)).rejects.toThrow(/Unrecognised/i);
  });
});

describe("EmailOutboxHandler — per-parcel dedupe scope", () => {
  it("threads the producer's dedupeScope through to the send", async () => {
    const { handler, sends } = makeHandler({});
    await handler.handle(
      {
        templateKey: "shipping-confirmation",
        to: "buyer@example.com",
        locale: "es",
        orderId: buildOrder()["id"],
        dedupeScope: "33333333-3333-4333-8333-333333333301",
        payload: {
          firstName: "Marta",
          orderNumber: "AK-2026-000123",
          carrier: "SEUR",
          trackingNumber: "SE1",
          trackingUrl: "https://seur.com/track/SE1",
          shippedAt: "2026-07-21T09:00:00.000Z",
          orderUrl: "https://dash.akai.test/orders/AK-2026-000123",
          lines: [
            {
              name: "BPC-157",
              quantity: 1,
              unitPrice: { amount: 2224, currency: "EUR" },
              lineTotal: { amount: 2224, currency: "EUR" },
            },
          ],
        },
      },
      MESSAGE,
    );

    // Without this the second parcel's claim collides with the first and the
    // handler treats the swallowed send as a terminal success.
    expect(sends[0]?.dedupeScope).toBe("33333333-3333-4333-8333-333333333301");
  });

  it("leaves the scope unset for an order-scoped template", async () => {
    const { handler, sends } = makeHandler({});
    await handler.handle(
      { templateKey: "order-confirmation", orderId: buildOrder()["id"], locale: "es" },
      MESSAGE,
    );
    expect(sends[0]?.dedupeScope).toBeUndefined();
  });
});

describe("EmailOutboxHandler — delivery-confirmation", () => {
  it("builds a schema-valid payload from the order reference alone", async () => {
    const { handler, sends } = makeHandler({
      order: buildOrder({
        shipments: [
          { deliveredAt: new Date("2026-07-22T09:00:00.000Z") },
          { deliveredAt: new Date("2026-07-23T14:30:00.000Z") },
        ],
      }),
    });

    await handler.handle(
      {
        templateKey: "delivery-confirmation",
        orderId: buildOrder()["id"],
        locale: "es",
      },
      MESSAGE,
    );

    const parsed = parseTemplatePayload("delivery-confirmation", sends[0]?.data);
    // The LAST parcel to land is when the order was actually delivered.
    expect(parsed.deliveredAt).toBe("2026-07-23T14:30:00.000Z");
    expect(parsed.orderUrl).toBe("https://dash.akai.test/orders/AK-2026-000123");
    expect(sends[0]?.to).toBe("buyer@example.com");
  });

  it("falls back to the order timestamp when no parcel carries a delivery time", async () => {
    const { handler, sends } = makeHandler({ order: buildOrder({ shipments: [] }) });
    await handler.handle(
      { templateKey: "delivery-confirmation", orderId: buildOrder()["id"], locale: "en" },
      MESSAGE,
    );
    const parsed = parseTemplatePayload("delivery-confirmation", sends[0]?.data);
    expect(parsed.deliveredAt).toBe("2026-07-20T10:06:00.000Z");
  });
});

describe("EmailOutboxHandler — order-cancelled", () => {
  it("uses the customer-facing payment.canceled event as the reason", async () => {
    const { handler, sends } = makeHandler({
      order: buildOrder({ cancelledAt: new Date("2026-07-21T08:00:00.000Z") }),
      event: { message: "Cancelado a peticion del cliente." },
    });

    await handler.handle(
      { templateKey: "order-cancelled", orderId: buildOrder()["id"], locale: "es" },
      MESSAGE,
    );

    const parsed = parseTemplatePayload("order-cancelled", sends[0]?.data);
    expect(parsed.reason).toBe("Cancelado a peticion del cliente.");
    expect(parsed.cancelledAt).toBe("2026-07-21T08:00:00.000Z");
  });
});
