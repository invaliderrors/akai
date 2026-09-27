import "reflect-metadata";
import type { ServerEnv } from "@akai/config";
import type { OrderStatus, ShipmentStatus } from "@akai/contracts";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseTemplatePayload } from "../../email/email.templates";
import type { PrismaService } from "../../prisma/prisma.service";
import type { SendcloudPort, SendcloudServicePoint, SendcloudShipment } from "../sendcloud/sendcloud.port";
import { ShipmentSyncService, type ShipmentDeliveryPort } from "./shipment-sync.service";

/**
 * ShipmentSyncService against an in-memory model of exactly the Prisma calls it
 * makes. The model honours the two things the service's guarantees rest on —
 * the optimistic `updateMany` (status + `shippedAt IS NULL`) and the order's
 * version check in `applyStatus` — so "exactly once" is asserted against the
 * same conditions Postgres evaluates. The real-database run is the api-e2e
 * suite `sendcloud-tracking.spec.ts`.
 */

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });
const CONFIG = { DASHBOARD_URL: "https://app.akai.test/" } as unknown as ServerEnv;

const ORDER_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const SHIPMENT_ID = "dddddddd-0000-4000-8000-000000000001";
const ITEM_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SC_SHIPMENT_ID = "95524bc9-174f-47c8-a03a-e60b83a24fe1";
const PARCEL_ID = 718530367;

interface ShipmentRow {
  id: string;
  orderId: string;
  status: ShipmentStatus;
  provider: "MANUAL" | "SENDCLOUD";
  carrier: string;
  sendcloudShipmentId: string | null;
  sendcloudParcelId: bigint | null;
  sendcloudStatusCode: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  lastSyncedAt: Date | null;
  shippedAt: Date | null;
  items: { orderItemId: string; quantity: number }[];
}

interface OrderRow {
  id: string;
  orderNumber: string;
  email: string;
  locale: "es" | "en";
  currency: string;
  status: OrderStatus;
  version: number;
  shipFirstName: string;
  servicePointId: string | null;
  servicePointName: string | null;
  servicePointAddress: string | null;
  items: {
    id: string;
    productName: string;
    variantName: string | null;
    quantity: number;
    unitPriceGross: number;
  }[];
}

interface Outboxed {
  topic: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function createWorld(orderOverrides: Partial<OrderRow> = {}) {
  const shipment: ShipmentRow = {
    id: SHIPMENT_ID,
    orderId: ORDER_ID,
    status: "LABEL_CREATED",
    provider: "SENDCLOUD",
    carrier: "InPost",
    sendcloudShipmentId: SC_SHIPMENT_ID,
    sendcloudParcelId: BigInt(PARCEL_ID),
    sendcloudStatusCode: "READY_TO_SEND",
    trackingNumber: null,
    trackingUrl: null,
    lastSyncedAt: null,
    shippedAt: null,
    items: [{ orderItemId: ITEM_ID, quantity: 2 }],
  };
  const order: OrderRow = {
    id: ORDER_ID,
    orderNumber: "AK-2026-000123",
    email: "ana@example.com",
    locale: "es",
    currency: "EUR",
    status: "FULFILLING",
    version: 4,
    shipFirstName: "Ana",
    servicePointId: "10875349",
    servicePointName: "PAPELERIA PILI",
    servicePointAddress: "Calle Delicias 12, 50002 Zaragoza",
    items: [
      { id: ITEM_ID, productName: "Oversized Tee", variantName: "L", quantity: 2, unitPriceGross: 4999 },
    ],
    ...orderOverrides,
  };
  const outbox: Outboxed[] = [];
  const events: { type: string; isInternal: boolean }[] = [];

  const joined = () => ({
    ...shipment,
    order: { ...order, shipments: [{ ...shipment }] },
  });

  const tx = {
    shipment: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches({ ...shipment }, where)) {
          return { count: 0 };
        }
        Object.assign(shipment, data);
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => joined()),
    },
    order: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches({ id: order.id, status: order.status, version: order.version }, where)) {
          return { count: 0 };
        }
        order.status = data["status"] as OrderStatus;
        order.version += 1;
        return { count: 1 };
      }),
    },
    orderEvent: {
      create: vi.fn(async ({ data }: { data: { type: string; isInternal: boolean } }) => {
        events.push(data);
        return data;
      }),
    },
    outboxMessage: {
      create: vi.fn(async ({ data }: { data: Outboxed }) => {
        outbox.push(data);
        return data;
      }),
    },
  };

  const prisma = {
    shipment: { findUnique: vi.fn(async () => ({ ...shipment })) },
    order: { findUnique: vi.fn(async () => ({ servicePointId: order.servicePointId })) },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };

  return { shipment, order, outbox, events, prisma: prisma as unknown as PrismaService };
}

function remote(code: string | null, tracking = true): SendcloudShipment {
  return {
    id: SC_SHIPMENT_ID,
    externalReferenceId: ORDER_ID,
    orderNumber: "AK-2026-000123",
    carrierCode: "inpost_es",
    carrierName: "InPost",
    shippingOptionCode: "inpost_es:service_point,national_c2c",
    errors: [],
    parcels: [
      {
        id: PARCEL_ID,
        statusCode: code,
        statusMessage: null,
        trackingNumber: tracking ? "IP123456789" : null,
        trackingUrl: tracking ? "https://tracking.sendcloud.sc/forward?code=IP123456789" : null,
        labelPdf: null,
      },
    ],
  };
}

const POINT: SendcloudServicePoint = {
  id: 10875349,
  name: "PAPELERIA PILI",
  carrierCode: "inpost_es",
  carrierServicePointId: "ES21366",
  shopType: "servicepoint",
  street: "Calle Delicias",
  houseNumber: "12",
  postalCode: "50002",
  city: "Zaragoza",
  countryCode: "ES",
  distanceMeters: null,
  isExpired: false,
  openingTimes: {
    monday: [
      { start: "08:00", end: "14:00" },
      { start: "17:00", end: "20:30" },
    ],
    tuesday: [{ start: "08:00", end: "14:00" }],
    wednesday: [{ start: "08:00", end: "14:00" }],
    thursday: [{ start: "08:00", end: "14:00" }],
    friday: [{ start: "08:00", end: "14:00" }],
    saturday: null,
    sunday: null,
  },
};

function fakeSendcloud(initialCode: string | null) {
  let code = initialCode;
  const port = {
    isConfigured: true,
    getShipment: vi.fn(async () => remote(code)),
    getServicePoint: vi.fn(async () => POINT),
  };
  return {
    port: port as unknown as SendcloudPort,
    raw: port,
    setCode(next: string | null) {
      code = next;
    },
  };
}

function emailsOf(outbox: readonly Outboxed[], templateKey: string): Outboxed[] {
  return outbox.filter((row) => row.topic === "email" && row.payload["templateKey"] === templateKey);
}

describe("ShipmentSyncService", () => {
  let world: ReturnType<typeof createWorld>;
  let sendcloud: ReturnType<typeof fakeSendcloud>;
  let delivered: ReturnType<typeof vi.fn<ShipmentDeliveryPort["markShipmentDelivered"]>>;
  let service: ShipmentSyncService;

  function build(): void {
    delivered = vi.fn<ShipmentDeliveryPort["markShipmentDelivered"]>(async () => {
      world.shipment.status = "DELIVERED";
      return {} as Awaited<ReturnType<ShipmentDeliveryPort["markShipmentDelivered"]>>;
    });
    service = new ShipmentSyncService(world.prisma, sendcloud.port, { markShipmentDelivered: delivered }, CONFIG, logger);
  }

  beforeEach(() => {
    world = createWorld();
    sendcloud = fakeSendcloud("READY_TO_SEND");
    build();
  });

  it("records the code and sync time even when nothing changes", async () => {
    const now = new Date("2026-09-25T10:00:00.000Z");
    const outcome = await service.sync(SHIPMENT_ID, now);

    expect(outcome).toMatchObject({ status: "synced", from: "LABEL_CREATED", to: "LABEL_CREATED", firstScan: false });
    expect(world.shipment.lastSyncedAt).toEqual(now);
    expect(world.shipment.sendcloudStatusCode).toBe("READY_TO_SEND");
    expect(world.shipment.trackingNumber).toBe("IP123456789");
    expect(world.outbox).toHaveLength(0);
    expect(world.order.status).toBe("FULFILLING");
  });

  describe("first scan", () => {
    it("moves the order to SHIPPED and enqueues ONE shipping-confirmation naming the pickup point", async () => {
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      const now = new Date("2026-09-25T10:00:00.000Z");
      const outcome = await service.sync(SHIPMENT_ID, now);

      expect(outcome).toMatchObject({ to: "IN_TRANSIT", firstScan: true });
      expect(world.shipment.status).toBe("IN_TRANSIT");
      expect(world.shipment.shippedAt).toEqual(now);
      expect(world.order.status).toBe("SHIPPED");

      const mails = emailsOf(world.outbox, "shipping-confirmation");
      expect(mails).toHaveLength(1);
      const envelope = mails[0]?.payload ?? {};
      expect(envelope["dedupeScope"]).toBe(SHIPMENT_ID);
      expect(envelope["to"]).toBe("ana@example.com");
      // The producer's payload must pass the template's own strict schema.
      const payload = parseTemplatePayload("shipping-confirmation", envelope["payload"]);
      expect(payload.servicePoint).toEqual({
        name: "PAPELERIA PILI",
        address: "Calle Delicias 12, 50002 Zaragoza",
      });
      expect(payload.trackingNumber).toBe("IP123456789");
      expect(payload.orderUrl).toBe("https://app.akai.test/orders/AK-2026-000123");
      expect(payload.lines).toEqual([
        expect.objectContaining({ name: "Oversized Tee", quantity: 2 }),
      ]);
    });

    it("is exactly once: a second sync at the same state mails nothing", async () => {
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      await service.sync(SHIPMENT_ID);
      sendcloud.setCode("SORTED");
      await service.sync(SHIPMENT_ID);
      await service.sync(SHIPMENT_ID);

      expect(emailsOf(world.outbox, "shipping-confirmation")).toHaveLength(1);
      expect(world.order.status).toBe("SHIPPED");
    });

    it("walks a still-PAID order through FULFILLING to SHIPPED", async () => {
      world = createWorld({ status: "PAID", version: 2 });
      build();
      sendcloud.setCode("TO_SORTING");
      await service.sync(SHIPMENT_ID);

      expect(world.order.status).toBe("SHIPPED");
      expect(world.order.version).toBe(4);
    });

    it("omits the pickup point for a home-delivery order", async () => {
      world = createWorld({ servicePointId: null, servicePointName: null, servicePointAddress: null });
      build();
      sendcloud.setCode("DRIVER_ON_ROUTE");
      await service.sync(SHIPMENT_ID);

      const payload = parseTemplatePayload(
        "shipping-confirmation",
        emailsOf(world.outbox, "shipping-confirmation")[0]?.payload["payload"],
      );
      expect(payload.servicePoint).toBeUndefined();
    });
  });

  describe("ready for pickup", () => {
    it("sends the shipping mail first, then ONE ready-for-pickup with the point's hours", async () => {
      sendcloud.setCode("AWAITING_CUSTOMER_PICKUP");
      await service.sync(SHIPMENT_ID);

      expect(world.shipment.status).toBe("AWAITING_PICKUP");
      expect(world.order.status).toBe("SHIPPED");
      const templates = world.outbox.filter((row) => row.topic === "email").map((row) => row.payload["templateKey"]);
      expect(templates).toEqual(["shipping-confirmation", "ready-for-pickup"]);

      const envelope = emailsOf(world.outbox, "ready-for-pickup")[0]?.payload ?? {};
      expect(envelope["dedupeScope"]).toBe(SHIPMENT_ID);
      const payload = parseTemplatePayload("ready-for-pickup", envelope["payload"]);
      expect(payload.servicePoint?.name).toBe("PAPELERIA PILI");
      expect(payload.openingHours?.[0]).toEqual({
        day: "monday",
        shifts: [
          { start: "08:00", end: "14:00" },
          { start: "17:00", end: "20:30" },
        ],
      });
      expect(payload.openingHours?.[6]).toEqual({ day: "sunday", shifts: [] });
    });

    it("holds the pickup mail back a minute when the same sync also sent the shipping mail", async () => {
      sendcloud.setCode("AWAITING_CUSTOMER_PICKUP");
      const now = new Date("2026-09-25T10:00:00.000Z");
      await service.sync(SHIPMENT_ID, now);

      const row = world.outbox.find((entry) => entry.payload["templateKey"] === "ready-for-pickup");
      expect(row?.availableAt).toEqual(new Date("2026-09-25T10:01:00.000Z"));
    });

    it("does not delay the pickup mail when the parcel was already in transit", async () => {
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      await service.sync(SHIPMENT_ID);
      sendcloud.setCode("AWAITING_CUSTOMER_PICKUP");
      const now = new Date("2026-09-26T10:00:00.000Z");
      await service.sync(SHIPMENT_ID, now);

      const row = world.outbox.find((entry) => entry.payload["templateKey"] === "ready-for-pickup");
      expect(row?.availableAt).toEqual(now);
    });

    it("is sent once, however many syncs see the parcel waiting", async () => {
      sendcloud.setCode("AWAITING_CUSTOMER_PICKUP");
      await service.sync(SHIPMENT_ID);
      await service.sync(SHIPMENT_ID);

      expect(emailsOf(world.outbox, "ready-for-pickup")).toHaveLength(1);
      expect(sendcloud.raw.getServicePoint).toHaveBeenCalledTimes(1);
    });

    it("still mails, without hours, when the point cannot be read", async () => {
      sendcloud.raw.getServicePoint.mockRejectedValueOnce(new Error("503"));
      sendcloud.setCode("AWAITING_CUSTOMER_PICKUP");
      await service.sync(SHIPMENT_ID);

      const payload = parseTemplatePayload(
        "ready-for-pickup",
        emailsOf(world.outbox, "ready-for-pickup")[0]?.payload["payload"],
      );
      expect(payload.openingHours).toBeUndefined();
    });
  });

  describe("delivered", () => {
    it("goes through OrdersService.markShipmentDelivered with no actor", async () => {
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      await service.sync(SHIPMENT_ID);
      sendcloud.setCode("DELIVERED");
      await service.sync(SHIPMENT_ID);

      expect(delivered).toHaveBeenCalledTimes(1);
      expect(delivered).toHaveBeenCalledWith(SHIPMENT_ID, null);
    });

    it("does not write DELIVERED itself, so the orders path still sees a live parcel", async () => {
      delivered.mockImplementationOnce(async () => {
        expect(world.shipment.status).toBe("IN_TRANSIT");
        return {} as Awaited<ReturnType<ShipmentDeliveryPort["markShipmentDelivered"]>>;
      });
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      await service.sync(SHIPMENT_ID);
      sendcloud.setCode("COLLECTED_BY_CUSTOMER");
      await service.sync(SHIPMENT_ID);
      expect(delivered).toHaveBeenCalledTimes(1);
    });

    it("when DELIVERED is the first thing seen: ships (one mail), then delivers", async () => {
      sendcloud.setCode("DELIVERED");
      await service.sync(SHIPMENT_ID);

      expect(world.order.status).toBe("SHIPPED");
      expect(emailsOf(world.outbox, "shipping-confirmation")).toHaveLength(1);
      expect(delivered).toHaveBeenCalledTimes(1);
    });
  });

  describe("out of order", () => {
    it("never moves a delivered parcel, and does not even call Sendcloud for it", async () => {
      world.shipment.status = "DELIVERED";
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      const outcome = await service.sync(SHIPMENT_ID);

      expect(outcome).toEqual({ status: "terminal" });
      expect(sendcloud.raw.getShipment).not.toHaveBeenCalled();
      expect(world.outbox).toHaveLength(0);
    });

    it("does not pull a parcel at the pickup point back into transit", async () => {
      sendcloud.setCode("AWAITING_CUSTOMER_PICKUP");
      await service.sync(SHIPMENT_ID);
      const mailed = world.outbox.length;
      sendcloud.setCode("SORTED");
      await service.sync(SHIPMENT_ID);

      expect(world.shipment.status).toBe("AWAITING_PICKUP");
      expect(world.shipment.sendcloudStatusCode).toBe("SORTED");
      expect(world.outbox).toHaveLength(mailed);
    });
  });

  describe("unknown codes", () => {
    it.each([["UNKNOWN"], ["SOMETHING_NEW"], [null]])("leaves the status alone for %j — never delivered", async (code) => {
      sendcloud.setCode(code);
      await service.sync(SHIPMENT_ID);

      expect(world.shipment.status).toBe("LABEL_CREATED");
      expect(world.shipment.sendcloudStatusCode).toBe(code);
      expect(world.shipment.lastSyncedAt).not.toBeNull();
      expect(delivered).not.toHaveBeenCalled();
      expect(world.outbox).toHaveLength(0);
    });
  });

  describe("problems", () => {
    it.each([
      ["RETURNED_TO_SENDER", "RETURNED", "shipment-returned"],
      ["DELIVERY_FAILED", "EXCEPTION", "shipment-exception"],
    ])("%s → %s raises ONE operator alert", async (code, status, kind) => {
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      await service.sync(SHIPMENT_ID);
      sendcloud.setCode(code);
      await service.sync(SHIPMENT_ID);
      await service.sync(SHIPMENT_ID);

      expect(world.shipment.status).toBe(status);
      const alerts = world.outbox.filter((row) => row.topic === "notifications");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.payload).toMatchObject({ kind, shipmentId: SHIPMENT_ID, sendcloudStatusCode: code });
      expect(world.events.some((event) => event.isInternal)).toBe(true);
    });

    it("a label cancelled in the panel releases a FULFILLING order back to PAID", async () => {
      sendcloud.setCode("CANCELLED");
      await service.sync(SHIPMENT_ID);

      expect(world.shipment.status).toBe("CANCELLED");
      expect(world.order.status).toBe("PAID");
      expect(world.outbox.filter((row) => row.topic === "email")).toHaveLength(0);
    });

    it("ignores a cancellation reported after the carrier scanned the parcel", async () => {
      sendcloud.setCode("SHIPMENT_ON_ROUTE");
      await service.sync(SHIPMENT_ID);
      sendcloud.setCode("CANCELLED");
      await service.sync(SHIPMENT_ID);

      expect(world.shipment.status).toBe("IN_TRANSIT");
      expect(world.order.status).toBe("SHIPPED");
    });
  });

  describe("guards", () => {
    it("retries (throws) when the shipment changed under it", async () => {
      sendcloud.raw.getShipment.mockImplementationOnce(async () => {
        world.shipment.status = "IN_TRANSIT";
        return remote("SHIPMENT_ON_ROUTE");
      });
      await expect(service.sync(SHIPMENT_ID)).rejects.toThrow(/changed while it was being synced/);
    });

    it("propagates a vendor failure so the outbox backs off", async () => {
      sendcloud.raw.getShipment.mockRejectedValueOnce(new Error("Sendcloud 503"));
      await expect(service.sync(SHIPMENT_ID)).rejects.toThrow("Sendcloud 503");
    });

    it("skips a shipment Sendcloud does not track", async () => {
      world.shipment.provider = "MANUAL";
      expect(await service.sync(SHIPMENT_ID)).toEqual({ status: "not-sendcloud" });
      expect(sendcloud.raw.getShipment).not.toHaveBeenCalled();
    });

    it("skips quietly when Sendcloud is not configured", async () => {
      sendcloud.raw.isConfigured = false;
      expect(await service.sync(SHIPMENT_ID)).toEqual({ status: "not-configured" });
    });

    it("answers 'missing' for a shipment that no longer exists", async () => {
      const prisma = world.prisma as unknown as { shipment: { findUnique: ReturnType<typeof vi.fn> } };
      prisma.shipment.findUnique.mockResolvedValueOnce(null);
      expect(await service.sync(SHIPMENT_ID)).toEqual({ status: "missing" });
    });
  });
});
