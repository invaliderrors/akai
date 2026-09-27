import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { ShipmentStatus } from "@akai/contracts";
import type { Prisma } from "@akai/db";
import { multiply, toMinor } from "@akai/money";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../../config/config.module";
import type { EmailPayloadFor } from "../../email/email.templates";
import { LOGGER } from "../../observability/logger.module";
import { assertTransition, canTransition, isPaidStatus } from "../../orders/order-status.machine";
import { applyStatus } from "../../orders/orders.service";
import { OrdersService } from "../../orders/orders.service";
import { carriesGoods, isTerminalShipmentStatus } from "../../orders/shipment-status";
import { PrismaService } from "../../prisma/prisma.service";
import {
  SENDCLOUD_CLIENT,
  WEEKDAYS,
  type SendcloudParcel,
  type SendcloudPort,
} from "../sendcloud/sendcloud.port";
import { mapSendcloudStatus, nextShipmentStatus, provesFirstScan } from "./sendcloud-status.map";

/**
 * ShipmentSyncService — "re-read this shipment from Sendcloud and apply it"
 * (spec 2026-09-24-sendcloud-shipping §3.7, plan Phase 6).
 *
 * THE STATE IS ALWAYS RE-READ, never taken from the webhook: the webhook body is
 * the legacy v2 shape and deliveries arrive out of order (S13), so the sync asks
 * v3 for the parcel's CURRENT status code, maps it (`sendcloud-status.map.ts`),
 * and moves the shipment only FORWARD (`nextShipmentStatus`). A late, duplicate
 * or reordered trigger therefore converges on the same answer.
 *
 * WHAT EACH TRANSITION DOES:
 *  - FIRST SCAN (the first time the parcel is IN_TRANSIT, AWAITING_PICKUP or
 *    DELIVERED — decision D4): `shippedAt` is set, the order walks
 *    PAID → FULFILLING → SHIPPED, and ONE `shipping-confirmation` is enqueued
 *    (with the pickup point for a pickup order). Guarded by `shippedAt IS NULL`
 *    in the same UPDATE, so it happens exactly once however many syncs race.
 *  - AWAITING_PICKUP: one `ready-for-pickup` mail (decision D6), deduped by the
 *    shipment id as its email scope and by the status transition itself.
 *  - DELIVERED: `OrdersService.markShipmentDelivered` — the SAME path staff use,
 *    so the order → DELIVERED rule and `delivery-confirmation` live in one place.
 *  - RETURNED / EXCEPTION: an operator alert on the `notifications` topic (the
 *    Whop payment-mismatch mechanism) plus an internal order event.
 *  - CANCELLED / FAILED (a label cancelled in the panel): the shipment stops
 *    carrying goods, and an order left FULFILLING with nothing else in flight
 *    walks back to PAID over the FULFILLING → PAID edge the label-cancel path
 *    introduced — through the same `assertTransition` + `applyStatus` pair.
 *
 * ORDER STATUS IS WRITTEN ONLY THROUGH `assertTransition` + `applyStatus`
 * (exported by the orders module for fulfilment) or an `OrdersService` method,
 * never by a hand-rolled update.
 */

export type ShipmentSyncOutcome =
  | { readonly status: "missing" | "not-sendcloud" | "not-configured" | "terminal" }
  | {
      readonly status: "synced";
      readonly from: ShipmentStatus;
      readonly to: ShipmentStatus;
      readonly sendcloudStatusCode: string | null;
      readonly firstScan: boolean;
    };

/** The slice of OrdersService this service drives. */
export type ShipmentDeliveryPort = Pick<OrdersService, "markShipmentDelivered">;

type ReadyForPickupPayload = EmailPayloadFor<"ready-for-pickup">;
type ShippingConfirmationPayload = EmailPayloadFor<"shipping-confirmation">;
type OpeningHours = NonNullable<ReadyForPickupPayload["openingHours"]>;

/** Column bounds: never let a vendor value turn into a DB error and a retry storm. */
const MAX_TRACKING_NUMBER = 128;
const MAX_TRACKING_URL = 1024;
const MAX_STATUS_CODE = 64;
const CLOCK_TIME = /^\d{2}:\d{2}$/;

/**
 * When the first scan and "at the pickup point" are seen by the SAME sync, both
 * mails are enqueued in one transaction and would share an `availableAt` — and
 * the outbox claim does not order rows within a batch. Holding the pickup mail
 * back a minute makes "it is on its way" arrive before "come and collect it".
 */
const PICKUP_MAIL_DELAY_AFTER_SCAN_MS = 60_000;

const ALERT_KIND: Partial<Record<ShipmentStatus, string>> = {
  RETURNED: "shipment-returned",
  EXCEPTION: "shipment-exception",
};

@Injectable()
export class ShipmentSyncService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SENDCLOUD_CLIENT) private readonly sendcloud: SendcloudPort,
    @Inject(OrdersService) private readonly orders: ShipmentDeliveryPort,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async sync(shipmentId: string, now: Date = new Date()): Promise<ShipmentSyncOutcome> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        orderId: true,
        status: true,
        provider: true,
        sendcloudShipmentId: true,
        sendcloudParcelId: true,
        shippedAt: true,
      },
    });

    if (shipment === null) {
      // Deleted with its order (cascade) between enqueue and run. Nothing to do,
      // and throwing would only dead-letter a message that can never succeed.
      this.logger.warn({ shipmentId }, "shipment-sync for a shipment that no longer exists");
      return { status: "missing" };
    }
    if (shipment.provider !== "SENDCLOUD" || shipment.sendcloudShipmentId === null) {
      this.logger.warn({ shipmentId }, "shipment-sync for a shipment Sendcloud does not track");
      return { status: "not-sendcloud" };
    }
    if (isTerminalShipmentStatus(shipment.status)) {
      return { status: "terminal" };
    }
    if (!this.sendcloud.isConfigured) {
      // Keys removed after the label was bought. The sweep re-enqueues once
      // they are back; retrying now would only fail eight times.
      this.logger.warn({ shipmentId }, "shipment-sync skipped: Sendcloud is not configured");
      return { status: "not-configured" };
    }

    // A vendor failure THROWS here, on purpose: the outbox retries it with
    // backoff, and the sweep covers anything that exhausts its retries.
    const remote = await this.sendcloud.getShipment(shipment.sendcloudShipmentId);
    const parcel = pickParcel(remote.parcels, shipment.sendcloudParcelId);
    if (parcel === null) {
      throw new Error(
        `Sendcloud shipment ${shipment.sendcloudShipmentId} has no parcel ` +
          `${shipment.sendcloudParcelId?.toString() ?? "(none recorded)"}`,
      );
    }

    const code = parcel.statusCode === null ? null : parcel.statusCode.slice(0, MAX_STATUS_CODE);
    const reported = mapSendcloudStatus(code);
    if (reported === null) {
      // G4's failure direction: unknown → unchanged + logged, NEVER delivered.
      this.logger.warn(
        { shipmentId, sendcloudStatusCode: code },
        "Unmapped Sendcloud parcel status — shipment status left unchanged",
      );
    }

    const next = nextShipmentStatus(shipment.status, reported);
    if (reported !== null && next === null && reported !== shipment.status) {
      this.logger.warn(
        { shipmentId, current: shipment.status, reported, sendcloudStatusCode: code },
        "Sendcloud reported a status that would move the shipment backwards — ignored",
      );
    }

    const effective = next ?? shipment.status;
    const firstScan = shipment.shippedAt === null && provesFirstScan(effective);

    // Best-effort and OUTSIDE the transaction: a vendor read must never hold a
    // row lock, and a failed read only costs the mail its opening hours.
    const openingHours =
      next === "AWAITING_PICKUP" ? await this.openingHoursFor(shipment.orderId) : undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.shipment.updateMany({
        // Optimistic: the status we decided from, and — for the first scan —
        // `shippedAt IS NULL`, which is what makes the shipping mail exactly-once.
        where: { id: shipment.id, status: shipment.status, ...(firstScan ? { shippedAt: null } : {}) },
        data: {
          sendcloudStatusCode: code,
          lastSyncedAt: now,
          ...trackingColumns(parcel),
          // DELIVERED is written by `markShipmentDelivered` below, not here: that
          // method is a no-op on a shipment already DELIVERED, so writing it here
          // would skip the order transition and the delivery mail.
          ...(next !== null && next !== "DELIVERED" ? { status: next } : {}),
          ...(firstScan ? { shippedAt: now } : {}),
        },
      });
      if (updated.count === 0) {
        throw new ConflictException(
          `Shipment ${shipment.id} changed while it was being synced; the retry re-reads it.`,
        );
      }

      if (firstScan) {
        await this.applyFirstScan(tx, shipment.id, now);
      }
      if (next === "AWAITING_PICKUP") {
        const availableAt = firstScan ? new Date(now.getTime() + PICKUP_MAIL_DELAY_AFTER_SCAN_MS) : now;
        await this.enqueueReadyForPickup(tx, shipment.id, openingHours, availableAt);
      }
      if (next !== null && ALERT_KIND[next] !== undefined) {
        await this.raiseAlert(tx, shipment.id, next, code, now);
      }
      if (next === "CANCELLED" || next === "FAILED") {
        await this.releaseOrder(tx, shipment.id, next);
      }
    });

    if (next === "DELIVERED") {
      await this.orders.markShipmentDelivered(shipment.id, null);
    }

    return { status: "synced", from: shipment.status, to: effective, sendcloudStatusCode: code, firstScan };
  }

  // -------------------------------------------------------------------------
  // First scan: SHIPPED + shipping-confirmation
  // -------------------------------------------------------------------------

  private async applyFirstScan(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    now: Date,
  ): Promise<void> {
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: {
        items: true,
        order: { include: { items: true, shipments: { include: { items: true } } } },
      },
    });
    const order = shipment.order;

    // One Sendcloud parcel per order, carrying every line (spec §3.5). A parcel
    // row with no item rows is read as exactly that rather than as "ships
    // nothing", which would strand the order in FULFILLING forever.
    const wholeOrderParcel = shipment.items.length === 0;
    const shippedByItem = new Map<string, number>();
    for (const row of order.shipments) {
      if (!carriesGoods(row.status) || row.shippedAt === null) {
        continue;
      }
      for (const line of row.items) {
        shippedByItem.set(line.orderItemId, (shippedByItem.get(line.orderItemId) ?? 0) + line.quantity);
      }
    }
    const fullyShipped =
      wholeOrderParcel || order.items.every((item) => (shippedByItem.get(item.id) ?? 0) >= item.quantity);

    let current = order.status;
    let version = order.version;
    if (current === "PAID" && canTransition(current, "FULFILLING")) {
      await applyStatus(tx, {
        id: order.id,
        expectedStatus: current,
        expectedVersion: version,
        nextStatus: "FULFILLING",
      });
      current = "FULFILLING";
      version += 1;
    }
    if (fullyShipped && current === "FULFILLING") {
      assertTransition(current, "SHIPPED");
      await applyStatus(tx, {
        id: order.id,
        expectedStatus: current,
        expectedVersion: version,
        nextStatus: "SHIPPED",
      });
    }

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "SHIPMENT_IN_TRANSIT",
        message:
          `${shipment.carrier} has the parcel` +
          (shipment.trackingNumber === null ? "." : ` (tracking ${shipment.trackingNumber}).`),
        isInternal: false,
        actorId: null,
      },
    });

    if (!isPaidStatus(order.status)) {
      // A parcel moving for a cancelled/failed order is an operator problem, not
      // news for the customer.
      this.logger.error(
        { orderNumber: order.orderNumber, status: order.status, shipmentId },
        "Carrier scanned a parcel for an order that is not paid — no shipping mail sent",
      );
      return;
    }

    const itemById = new Map(order.items.map((item) => [item.id, item]));
    const parcelLines = wholeOrderParcel
      ? order.items.map((item) => ({ item, quantity: item.quantity }))
      : shipment.items.flatMap((line) => {
          const item = itemById.get(line.orderItemId);
          return item === undefined ? [] : [{ item, quantity: line.quantity }];
        });

    const trackingNumber = nonBlank(shipment.trackingNumber);
    const trackingUrl = httpUrl(shipment.trackingUrl);
    const servicePoint = servicePointOf(order);
    const payload: ShippingConfirmationPayload = {
      firstName: order.shipFirstName,
      orderNumber: order.orderNumber,
      carrier: shipment.carrier,
      ...(trackingNumber === null ? {} : { trackingNumber }),
      ...(trackingUrl === null ? {} : { trackingUrl }),
      shippedAt: now.toISOString(),
      orderUrl: this.orderUrl(order.orderNumber),
      lines: parcelLines.map(({ item, quantity }) => ({
        name: item.productName,
        ...(item.variantName === null ? {} : { variantName: item.variantName }),
        quantity,
        unitPrice: { amount: toMinor(item.unitPriceGross), currency: order.currency },
        lineTotal: {
          amount: multiply(toMinor(item.unitPriceGross), quantity),
          currency: order.currency,
        },
      })),
      ...(servicePoint === null ? {} : { servicePoint }),
    };

    await tx.outboxMessage.create({
      data: {
        topic: "email",
        payload: {
          templateKey: "shipping-confirmation",
          to: order.email,
          locale: order.locale,
          orderId: order.id,
          // Per parcel (PER_PARCEL_TEMPLATE_KEYS): the same scope the manual
          // path uses, so the email log's unique claim is a second guard.
          dedupeScope: shipment.id,
          payload,
        },
      },
    });
  }

  // -------------------------------------------------------------------------
  // AWAITING_PICKUP: ready-for-pickup
  // -------------------------------------------------------------------------

  private async enqueueReadyForPickup(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    openingHours: OpeningHours | undefined,
    availableAt: Date,
  ): Promise<void> {
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: { order: true },
    });
    const order = shipment.order;

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "SHIPMENT_AWAITING_PICKUP",
        message: `The parcel is waiting for collection${order.servicePointName === null ? "" : ` at ${order.servicePointName}`}.`,
        isInternal: false,
        actorId: null,
      },
    });

    const trackingNumber = nonBlank(shipment.trackingNumber);
    const trackingUrl = httpUrl(shipment.trackingUrl);
    const servicePoint = servicePointOf(order);
    const payload: ReadyForPickupPayload = {
      firstName: order.shipFirstName,
      orderNumber: order.orderNumber,
      carrier: shipment.carrier,
      ...(trackingNumber === null ? {} : { trackingNumber }),
      ...(trackingUrl === null ? {} : { trackingUrl }),
      orderUrl: this.orderUrl(order.orderNumber),
      ...(servicePoint === null ? {} : { servicePoint }),
      ...(openingHours === undefined ? {} : { openingHours }),
    };

    await tx.outboxMessage.create({
      data: {
        topic: "email",
        availableAt,
        payload: {
          templateKey: "ready-for-pickup",
          to: order.email,
          locale: order.locale,
          orderId: order.id,
          dedupeScope: shipment.id,
          payload,
        },
      },
    });
  }

  /** The point's current-week hours, or undefined when there is no point or the read fails. */
  private async openingHoursFor(orderId: string): Promise<OpeningHours | undefined> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { servicePointId: true },
    });
    if (order === null || order.servicePointId === null) {
      return undefined;
    }
    try {
      const point = await this.sendcloud.getServicePoint(order.servicePointId);
      const days = WEEKDAYS.map((day) => ({
        day,
        shifts: (point.openingTimes[day] ?? []).map((shift) => ({ start: shift.start, end: shift.end })),
      }));
      const wellFormed = days.every((day) =>
        day.shifts.every((shift) => CLOCK_TIME.test(shift.start) && CLOCK_TIME.test(shift.end)),
      );
      return wellFormed ? days : undefined;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error, servicePointId: order.servicePointId },
        "Could not read pickup-point hours; the ready-for-pickup mail goes without them",
      );
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // RETURNED / EXCEPTION: operator alert
  // -------------------------------------------------------------------------

  private async raiseAlert(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    status: ShipmentStatus,
    sendcloudStatusCode: string | null,
    now: Date,
  ): Promise<void> {
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: { order: { select: { id: true, orderNumber: true } } },
    });
    const kind = ALERT_KIND[status] ?? "shipment-alert";

    await tx.orderEvent.create({
      data: {
        orderId: shipment.order.id,
        type: status === "RETURNED" ? "SHIPMENT_RETURNED" : "SHIPMENT_EXCEPTION",
        message: `Carrier reported ${sendcloudStatusCode ?? "an unknown status"} for parcel ${shipment.trackingNumber ?? shipment.id}.`,
        isInternal: true,
        actorId: null,
      },
    });

    // The same operator alert channel the Whop payment-mismatch path uses: a
    // `notifications` outbox row. Its consumer module has not shipped, so the
    // row dead-letters VISIBLY at /admin/jobs — the repo's deliberate convention
    // for a topic whose module is still to come — alongside the error log.
    await tx.outboxMessage.create({
      data: {
        topic: "notifications",
        payload: {
          kind,
          orderId: shipment.order.id,
          orderNumber: shipment.order.orderNumber,
          shipmentId: shipment.id,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          sendcloudStatusCode,
          detectedAt: now.toISOString(),
        },
      },
    });

    this.logger.error(
      { orderNumber: shipment.order.orderNumber, shipmentId, sendcloudStatusCode, kind },
      "Sendcloud reported a parcel problem — operator alert raised",
    );
  }

  // -------------------------------------------------------------------------
  // CANCELLED / FAILED from Sendcloud
  // -------------------------------------------------------------------------

  private async releaseOrder(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    status: "CANCELLED" | "FAILED",
  ): Promise<void> {
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: { order: { include: { shipments: { select: { id: true, status: true } } } } },
    });
    const order = shipment.order;

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: status === "CANCELLED" ? "SHIPMENT_CANCELLED" : "SHIPMENT_FAILED",
        message: `Sendcloud reports the label as ${status.toLowerCase()}.`,
        isInternal: true,
        actorId: null,
      },
    });

    // Back to PAID only when this was the last parcel carrying goods, so
    // "Generar etiqueta" can see the order again. Idempotent with the admin
    // cancel path: if that path already walked the order back, it is PAID here
    // and nothing happens.
    const stillCarrying = order.shipments.some((row) => row.id !== shipment.id && carriesGoods(row.status));
    if (order.status === "FULFILLING" && !stillCarrying && canTransition(order.status, "PAID")) {
      await applyStatus(tx, {
        id: order.id,
        expectedStatus: order.status,
        expectedVersion: order.version,
        nextStatus: "PAID",
      });
    }
  }

  private orderUrl(orderNumber: string): string {
    return `${this.config.DASHBOARD_URL.replace(/\/+$/, "")}/orders/${orderNumber}`;
  }
}

/** The parcel we recorded, or — when none was recorded — the only one. */
function pickParcel(parcels: readonly SendcloudParcel[], parcelId: bigint | null): SendcloudParcel | null {
  if (parcelId === null) {
    return parcels.length === 1 ? (parcels[0] ?? null) : null;
  }
  return parcels.find((parcel) => BigInt(parcel.id) === parcelId) ?? null;
}

/** Tracking fields Sendcloud has now — written only when present and storable. */
function trackingColumns(parcel: SendcloudParcel): { trackingNumber?: string; trackingUrl?: string } {
  const number = nonBlank(parcel.trackingNumber);
  const url = httpUrl(parcel.trackingUrl);
  return {
    ...(number !== null && number.length <= MAX_TRACKING_NUMBER ? { trackingNumber: number } : {}),
    ...(url !== null && url.length <= MAX_TRACKING_URL ? { trackingUrl: url } : {}),
  };
}

function nonBlank(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Only an http(s) URL may reach a mail's `href` (the payload schema re-checks). */
function httpUrl(value: string | null): string | null {
  const candidate = nonBlank(value);
  if (candidate === null) {
    return null;
  }
  try {
    const { protocol } = new URL(candidate);
    return protocol === "http:" || protocol === "https:" ? candidate : null;
  } catch {
    return null;
  }
}

function servicePointOf(order: {
  readonly servicePointName: string | null;
  readonly servicePointAddress: string | null;
}): { name: string; address: string } | null {
  const name = nonBlank(order.servicePointName);
  const address = nonBlank(order.servicePointAddress);
  return name === null || address === null ? null : { name, address };
}
