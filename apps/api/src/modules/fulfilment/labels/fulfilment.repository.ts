import { Injectable } from "@nestjs/common";
import type { OrderStatus, ShipmentProvider, ShipmentStatus } from "@akai/contracts";
import { Prisma } from "@akai/db";

import { PrismaService } from "../../prisma/prisma.service";
import { assertTransition } from "../../orders/order-status.machine";
import { applyStatus } from "../../orders/orders.service";
import { carriesGoods } from "../../orders/shipment-status";
import { ORDER_FULFILMENT_TOPIC, type OrderFulfilmentPayload } from "./order-fulfilment.types";

/**
 * Every database read and write the label pipeline makes, behind one port.
 *
 * WHY A PORT: the label service's branches (409 reuse, 200-with-errors,
 * eligibility at run time, test mode) are about what it DECIDES, and each is
 * unit-tested against an in-memory double. The SQL — the transaction, the
 * unique-key dedupe, the optimistic status write — is proven against real
 * Postgres in `apps/api-e2e/src/sendcloud-labels.spec.ts`.
 *
 * STATUS WRITES GO THROUGH THE ORDERS STATE MACHINE: `assertTransition` for
 * legality, then the orders module's own `applyStatus` for the optimistic
 * version check. This file never writes `order.status` any other way.
 */

export const FULFILMENT_REPOSITORY = Symbol("FULFILMENT_REPOSITORY");

export interface LabelOrderShipment {
  readonly id: string;
  readonly status: ShipmentStatus;
  readonly provider: ShipmentProvider;
  readonly sendcloudShipmentId: string | null;
  readonly labelObjectKey: string | null;
  readonly createdAt: Date;
}

/** The order as the label needs it: the SNAPSHOT, never the live rate or product. */
export interface LabelOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly email: string;
  readonly currency: string;
  readonly grandTotal: number;
  readonly shipFirstName: string;
  readonly shipLastName: string;
  readonly shipCompany: string | null;
  readonly shipLine1: string;
  readonly shipLine2: string | null;
  readonly shipCity: string;
  readonly shipPostalCode: string;
  readonly shipCountryCode: string;
  readonly shipPhone: string | null;
  readonly shipHouseNumber: string | null;
  readonly sendcloudOptionCode: string | null;
  readonly servicePointId: string | null;
  readonly parcelWeightGrams: number | null;
  /** Oldest first. */
  readonly shipments: readonly LabelOrderShipment[];
}

export interface RecordLabelInput {
  readonly orderId: string;
  readonly actorId: string | null;
  readonly sendcloudShipmentId: string;
  readonly sendcloudParcelId: number;
  readonly carrier: string;
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
  readonly statusCode: string | null;
  readonly labelObjectKey: string;
  readonly now: Date;
}

export interface RecordFailureInput {
  readonly orderId: string;
  readonly actorId: string | null;
  /** Null when Sendcloud refused before creating anything (a 4xx). */
  readonly sendcloudShipmentId: string | null;
  readonly sendcloudParcelId: number | null;
  readonly carrier: string;
  readonly statusCode: string | null;
  readonly failureReason: string;
  readonly now: Date;
}

export interface RecordResult {
  readonly shipmentId: string;
  /** False when a row for this Sendcloud shipment already existed (a redelivered job). */
  readonly created: boolean;
}

/** One shipment, as the admin actions on it need it. */
export interface AdminShipment {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: ShipmentStatus;
  readonly provider: ShipmentProvider;
  readonly sendcloudShipmentId: string | null;
  readonly labelObjectKey: string | null;
}

export interface CancelledResult {
  readonly shipmentStatus: ShipmentStatus;
  readonly orderStatus: OrderStatus;
}

/** An order a bulk request named, with what eligibility needs. */
export interface BulkOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly sendcloudOptionCode: string | null;
  readonly parcelWeightGrams: number | null;
  readonly shipments: readonly { readonly status: ShipmentStatus }[];
}

export interface FulfilmentRepository {
  loadOrderForLabel(orderId: string): Promise<LabelOrder | null>;
  /** Idempotent by `sendcloudShipmentId`; moves PAID -> FULFILLING. */
  recordLabel(input: RecordLabelInput): Promise<RecordResult>;
  /** A FAILED row with the vendor detail. The order is not touched. */
  recordFailure(input: RecordFailureInput): Promise<RecordResult>;

  loadOrdersForBulk(orderIds: readonly string[]): Promise<readonly BulkOrder[]>;
  enqueueCreateLabel(orderIds: readonly string[], actorId: string): Promise<void>;

  loadShipment(shipmentId: string): Promise<AdminShipment | null>;
  /**
   * LABEL_CREATED -> CANCELLED, and the order FULFILLING -> PAID when nothing
   * else ships it. Null when the shipment was no longer LABEL_CREATED.
   */
  markCancelled(shipmentId: string, actorId: string, statusCode: string): Promise<CancelledResult | null>;
  recordCancelRejected(shipmentId: string, actorId: string, detail: string): Promise<void>;

  /** The newest label-bearing live Sendcloud shipment per order, keyed by order id. */
  loadPrintableLabels(orderIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** Postgres unique violation, surfaced by Prisma as P2002. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const LABEL_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  email: true,
  currency: true,
  grandTotal: true,
  shipFirstName: true,
  shipLastName: true,
  shipCompany: true,
  shipLine1: true,
  shipLine2: true,
  shipCity: true,
  shipPostalCode: true,
  shipCountryCode: true,
  shipPhone: true,
  shipHouseNumber: true,
  sendcloudOptionCode: true,
  servicePointId: true,
  parcelWeightGrams: true,
  shipments: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      provider: true,
      sendcloudShipmentId: true,
      labelObjectKey: true,
      createdAt: true,
    },
  },
} satisfies Prisma.OrderSelect;

@Injectable()
export class PrismaFulfilmentRepository implements FulfilmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async loadOrderForLabel(orderId: string): Promise<LabelOrder | null> {
    return this.prisma.order.findUnique({ where: { id: orderId }, select: LABEL_ORDER_SELECT });
  }

  async recordLabel(input: RecordLabelInput): Promise<RecordResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // A redelivered job (or two jobs for one order) resolves the SAME
        // Sendcloud shipment through the 409 reuse; the second must land on
        // the first's row, not beside it. The unique index is the backstop.
        const existing = await tx.shipment.findUnique({
          where: { sendcloudShipmentId: input.sendcloudShipmentId },
          select: { id: true },
        });
        if (existing !== null) {
          return { shipmentId: existing.id, created: false };
        }

        const order = await tx.order.findUniqueOrThrow({
          where: { id: input.orderId },
          select: { id: true, status: true, version: true, items: { select: { id: true, quantity: true } } },
        });

        const shipment = await tx.shipment.create({
          data: {
            orderId: order.id,
            provider: "SENDCLOUD",
            status: "LABEL_CREATED",
            carrier: input.carrier,
            trackingNumber: input.trackingNumber,
            trackingUrl: input.trackingUrl,
            sendcloudShipmentId: input.sendcloudShipmentId,
            sendcloudParcelId: BigInt(input.sendcloudParcelId),
            sendcloudStatusCode: input.statusCode,
            labelObjectKey: input.labelObjectKey,
            lastSyncedAt: input.now,
            // ONE PARCEL PER ORDER (multicollo is out of scope): every line,
            // in full. Eligibility refused any order with a live parcel, so
            // nothing of it has shipped yet.
            items: {
              create: order.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity })),
            },
          },
          select: { id: true },
        });

        // A label is bought: the order is being fulfilled. NOT shipped — that
        // is the carrier's first scan (decision D4), and the
        // shipping-confirmation mail belongs to that moment, not this one.
        //
        // Only from PAID. The label is recorded whatever the order became
        // meanwhile (it was bought; staff must be able to see and cancel it).
        if (order.status === "PAID") {
          assertTransition(order.status, "FULFILLING");
          await applyStatus(tx, {
            id: order.id,
            expectedStatus: order.status,
            expectedVersion: order.version,
            nextStatus: "FULFILLING",
          });
        }

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "LABEL_CREATED",
            message:
              `Shipping label bought via Sendcloud (${input.carrier}` +
              (input.trackingNumber === null ? ")." : `, tracking ${input.trackingNumber}).`),
            isInternal: true,
            actorId: input.actorId,
          },
        });

        return { shipmentId: shipment.id, created: true };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Lost a race with a concurrent job recording the same shipment.
        const winner = await this.prisma.shipment.findUnique({
          where: { sendcloudShipmentId: input.sendcloudShipmentId },
          select: { id: true },
        });
        if (winner !== null) {
          return { shipmentId: winner.id, created: false };
        }
      }
      throw error;
    }
  }

  async recordFailure(input: RecordFailureInput): Promise<RecordResult> {
    return this.prisma.$transaction(async (tx) => {
      if (input.sendcloudShipmentId !== null) {
        const existing = await tx.shipment.findUnique({
          where: { sendcloudShipmentId: input.sendcloudShipmentId },
          select: { id: true },
        });
        if (existing !== null) {
          return { shipmentId: existing.id, created: false };
        }
      }

      const shipment = await tx.shipment.create({
        data: {
          orderId: input.orderId,
          provider: "SENDCLOUD",
          status: "FAILED",
          carrier: input.carrier,
          sendcloudShipmentId: input.sendcloudShipmentId,
          sendcloudParcelId: input.sendcloudParcelId === null ? null : BigInt(input.sendcloudParcelId),
          sendcloudStatusCode: input.statusCode,
          failureReason: input.failureReason,
          lastSyncedAt: input.now,
        },
        select: { id: true },
      });

      await tx.orderEvent.create({
        data: {
          orderId: input.orderId,
          type: "LABEL_FAILED",
          message: `Sendcloud refused the label: ${input.failureReason}`.slice(0, 1000),
          isInternal: true,
          actorId: input.actorId,
        },
      });

      return { shipmentId: shipment.id, created: true };
    });
  }

  async loadOrdersForBulk(orderIds: readonly string[]): Promise<readonly BulkOrder[]> {
    return this.prisma.order.findMany({
      where: { id: { in: [...orderIds] } },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        sendcloudOptionCode: true,
        parcelWeightGrams: true,
        shipments: { select: { status: true } },
      },
    });
  }

  async enqueueCreateLabel(orderIds: readonly string[], actorId: string): Promise<void> {
    if (orderIds.length === 0) {
      return;
    }
    await this.prisma.outboxMessage.createMany({
      data: orderIds.map((orderId) => {
        const payload: OrderFulfilmentPayload = { action: "create-label", orderId, actorId };
        return { topic: ORDER_FULFILMENT_TOPIC, payload };
      }),
    });
  }

  async loadShipment(shipmentId: string): Promise<AdminShipment | null> {
    const row = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        orderId: true,
        status: true,
        provider: true,
        sendcloudShipmentId: true,
        labelObjectKey: true,
        order: { select: { orderNumber: true } },
      },
    });
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order.orderNumber,
      status: row.status,
      provider: row.provider,
      sendcloudShipmentId: row.sendcloudShipmentId,
      labelObjectKey: row.labelObjectKey,
    };
  }

  async markCancelled(
    shipmentId: string,
    actorId: string,
    statusCode: string,
  ): Promise<CancelledResult | null> {
    return this.prisma.$transaction(async (tx) => {
      // Conditional on the status the admin saw: a tracking sync that moved
      // the parcel to IN_TRANSIT meanwhile must win, not be overwritten.
      const updated = await tx.shipment.updateMany({
        where: { id: shipmentId, status: "LABEL_CREATED" },
        data: { status: "CANCELLED", sendcloudStatusCode: statusCode, failureReason: null },
      });
      if (updated.count === 0) {
        return null;
      }

      const shipment = await tx.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        select: {
          order: {
            select: {
              id: true,
              status: true,
              version: true,
              shipments: { select: { id: true, status: true } },
            },
          },
        },
      });
      const order = shipment.order;

      // Back to PAID only when NOTHING else ships the order — a manual parcel
      // or a second label keeps it FULFILLING.
      const stillShipping = order.shipments.some(
        (other) => other.id !== shipmentId && carriesGoods(other.status),
      );
      let orderStatus: OrderStatus = order.status;
      if (order.status === "FULFILLING" && !stillShipping) {
        assertTransition(order.status, "PAID");
        await applyStatus(tx, {
          id: order.id,
          expectedStatus: order.status,
          expectedVersion: order.version,
          nextStatus: "PAID",
        });
        orderStatus = "PAID";
      }

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "LABEL_CANCELLED",
          message: "Sendcloud label cancelled.",
          isInternal: true,
          actorId,
        },
      });

      return { shipmentStatus: "CANCELLED", orderStatus };
    });
  }

  async recordCancelRejected(shipmentId: string, actorId: string, detail: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.update({
        where: { id: shipmentId },
        data: { failureReason: detail },
        select: { orderId: true },
      });
      await tx.orderEvent.create({
        data: {
          orderId: shipment.orderId,
          type: "LABEL_CANCEL_REJECTED",
          message: `Sendcloud refused to cancel the label: ${detail}`.slice(0, 1000),
          isInternal: true,
          actorId,
        },
      });
    });
  }

  async loadPrintableLabels(orderIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const rows = await this.prisma.shipment.findMany({
      where: {
        orderId: { in: [...orderIds] },
        provider: "SENDCLOUD",
        labelObjectKey: { not: null },
        status: { notIn: ["CANCELLED", "FAILED"] },
      },
      orderBy: { createdAt: "asc" },
      select: { orderId: true, labelObjectKey: true },
    });
    // Oldest first, so the NEWEST label per order is the one left in the map.
    const byOrder = new Map<string, string>();
    for (const row of rows) {
      if (row.labelObjectKey !== null) {
        byOrder.set(row.orderId, row.labelObjectKey);
      }
    }
    return byOrder;
  }
}
