import type { OrderStatus } from "@akai/contracts";

import type {
  AnnounceShipmentInput,
  AnnounceShipmentResult,
  CancelShipmentResult,
  SendcloudPort,
  SendcloudServicePoint,
  SendcloudShipment,
  SendcloudShippingOption,
  SendcloudTracking,
  ServicePointSearchResult,
} from "../../sendcloud/sendcloud.port";
import type {
  AdminShipment,
  BulkOrder,
  CancelledResult,
  FulfilmentRepository,
  LabelOrder,
  LabelOrderShipment,
  RecordFailureInput,
  RecordLabelInput,
  RecordResult,
} from "../fulfilment.repository";
import type { LabelStorage } from "../label-storage";

/**
 * In-memory doubles for the label pipeline's unit tests. The Prisma
 * implementation is proven against real Postgres in api-e2e; these model the
 * repository's CONTRACT (idempotent by Sendcloud shipment id, PAID ->
 * FULFILLING on a label, back to PAID on a cancel) closely enough that the
 * service's decisions can be asserted without a database.
 */

export const ORDER_ID = "6f1b3c2a-8a4e-4a55-9a51-0f0f5b1c7d11";
export const ACTOR_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

export function labelOrder(overrides: Partial<LabelOrder> = {}): LabelOrder {
  const base: LabelOrder = {
    id: ORDER_ID,
    orderNumber: "AK-2026-000123",
    status: "PAID",
    email: "ana@example.com",
    currency: "EUR",
    grandTotal: 4990,
    shipFirstName: "Ana",
    shipLastName: "García",
    shipCompany: null,
    shipLine1: "Calle Mayor",
    shipLine2: null,
    shipCity: "Zaragoza",
    shipPostalCode: "50002",
    shipCountryCode: "ES",
    shipPhone: "+34600111222",
    shipHouseNumber: "12",
    sendcloudOptionCode: "inpost_es:service_point,national_c2c",
    servicePointId: "10875349",
    parcelWeightGrams: 750,
    shipments: [],
  };
  return { ...base, ...overrides };
}

interface StoredShipment extends LabelOrderShipment {
  readonly orderId: string;
  readonly failureReason: string | null;
  readonly trackingNumber: string | null;
  readonly sendcloudParcelId: number | null;
}

export class InMemoryFulfilmentRepository implements FulfilmentRepository {
  readonly orders = new Map<string, LabelOrder>();
  readonly shipments: StoredShipment[] = [];
  readonly enqueued: { orderId: string; actorId: string }[] = [];
  readonly events: { orderId: string; type: string }[] = [];
  private nextId = 1;

  constructor(orders: readonly LabelOrder[] = []) {
    for (const order of orders) {
      this.orders.set(order.id, order);
    }
  }

  private id(): string {
    const suffix = String(this.nextId).padStart(12, "0");
    this.nextId += 1;
    return `aaaaaaaa-0000-4000-8000-${suffix}`;
  }

  private setStatus(orderId: string, status: OrderStatus): void {
    const order = this.orders.get(orderId);
    if (order !== undefined) {
      this.orders.set(orderId, { ...order, status });
    }
  }

  private shipmentsOf(orderId: string): LabelOrderShipment[] {
    return this.shipments.filter((shipment) => shipment.orderId === orderId);
  }

  async loadOrderForLabel(orderId: string): Promise<LabelOrder | null> {
    const order = this.orders.get(orderId);
    return order === undefined ? null : { ...order, shipments: this.shipmentsOf(orderId) };
  }

  async recordLabel(input: RecordLabelInput): Promise<RecordResult> {
    const existing = this.shipments.find(
      (shipment) => shipment.sendcloudShipmentId === input.sendcloudShipmentId,
    );
    if (existing !== undefined) {
      return { shipmentId: existing.id, created: false };
    }
    const id = this.id();
    this.shipments.push({
      id,
      orderId: input.orderId,
      status: "LABEL_CREATED",
      provider: "SENDCLOUD",
      sendcloudShipmentId: input.sendcloudShipmentId,
      sendcloudParcelId: input.sendcloudParcelId,
      labelObjectKey: input.labelObjectKey,
      trackingNumber: input.trackingNumber,
      failureReason: null,
      createdAt: input.now,
    });
    if (this.orders.get(input.orderId)?.status === "PAID") {
      this.setStatus(input.orderId, "FULFILLING");
    }
    this.events.push({ orderId: input.orderId, type: "LABEL_CREATED" });
    return { shipmentId: id, created: true };
  }

  async recordFailure(input: RecordFailureInput): Promise<RecordResult> {
    if (input.sendcloudShipmentId !== null) {
      const existing = this.shipments.find(
        (shipment) => shipment.sendcloudShipmentId === input.sendcloudShipmentId,
      );
      if (existing !== undefined) {
        return { shipmentId: existing.id, created: false };
      }
    }
    const id = this.id();
    this.shipments.push({
      id,
      orderId: input.orderId,
      status: "FAILED",
      provider: "SENDCLOUD",
      sendcloudShipmentId: input.sendcloudShipmentId,
      sendcloudParcelId: input.sendcloudParcelId,
      labelObjectKey: null,
      trackingNumber: null,
      failureReason: input.failureReason,
      createdAt: input.now,
    });
    this.events.push({ orderId: input.orderId, type: "LABEL_FAILED" });
    return { shipmentId: id, created: true };
  }

  async loadOrdersForBulk(orderIds: readonly string[]): Promise<readonly BulkOrder[]> {
    return orderIds.flatMap((id) => {
      const order = this.orders.get(id);
      return order === undefined ? [] : [{ ...order, shipments: this.shipmentsOf(id) }];
    });
  }

  async enqueueCreateLabel(orderIds: readonly string[], actorId: string): Promise<void> {
    for (const orderId of orderIds) {
      this.enqueued.push({ orderId, actorId });
    }
  }

  async loadShipment(shipmentId: string): Promise<AdminShipment | null> {
    const shipment = this.shipments.find((candidate) => candidate.id === shipmentId);
    if (shipment === undefined) {
      return null;
    }
    return {
      id: shipment.id,
      orderId: shipment.orderId,
      orderNumber: this.orders.get(shipment.orderId)?.orderNumber ?? "AK-0000-000000",
      status: shipment.status,
      provider: shipment.provider,
      sendcloudShipmentId: shipment.sendcloudShipmentId,
      labelObjectKey: shipment.labelObjectKey,
    };
  }

  async markCancelled(shipmentId: string): Promise<CancelledResult | null> {
    const index = this.shipments.findIndex((candidate) => candidate.id === shipmentId);
    const shipment = this.shipments[index];
    if (shipment === undefined || shipment.status !== "LABEL_CREATED") {
      return null;
    }
    this.shipments[index] = { ...shipment, status: "CANCELLED" };
    const order = this.orders.get(shipment.orderId);
    let orderStatus: OrderStatus = order?.status ?? "PAID";
    const stillShipping = this.shipments.some(
      (other) =>
        other.orderId === shipment.orderId &&
        other.id !== shipmentId &&
        other.status !== "CANCELLED" &&
        other.status !== "FAILED",
    );
    if (orderStatus === "FULFILLING" && !stillShipping) {
      this.setStatus(shipment.orderId, "PAID");
      orderStatus = "PAID";
    }
    return { shipmentStatus: "CANCELLED", orderStatus };
  }

  async recordCancelRejected(shipmentId: string, _actorId: string, detail: string): Promise<void> {
    const index = this.shipments.findIndex((candidate) => candidate.id === shipmentId);
    const shipment = this.shipments[index];
    if (shipment !== undefined) {
      this.shipments[index] = { ...shipment, failureReason: detail };
    }
  }

  async loadPrintableLabels(orderIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const map = new Map<string, string>();
    for (const shipment of this.shipments) {
      if (
        orderIds.includes(shipment.orderId) &&
        shipment.labelObjectKey !== null &&
        shipment.status !== "CANCELLED" &&
        shipment.status !== "FAILED"
      ) {
        map.set(shipment.orderId, shipment.labelObjectKey);
      }
    }
    return map;
  }
}

/** A label PDF's first bytes — enough to recognise in assertions. */
export const LABEL_BYTES = new Uint8Array([37, 80, 68, 70, 45, 49]);

export function announcedShipment(overrides: Partial<SendcloudShipment> = {}): SendcloudShipment {
  const base: SendcloudShipment = {
    id: "sc-shipment-1",
    externalReferenceId: ORDER_ID,
    orderNumber: "AK-2026-000123",
    carrierCode: "inpost_es",
    carrierName: "InPost ES",
    shippingOptionCode: "inpost_es:service_point,national_c2c",
    parcels: [
      {
        id: 412345678,
        statusCode: "READY_TO_SEND",
        statusMessage: "Ready to send",
        trackingNumber: "INP000123",
        trackingUrl: "https://tracking.example/INP000123",
        labelPdf: LABEL_BYTES,
      },
    ],
    errors: [],
  };
  return { ...base, ...overrides };
}

type AnnounceScript = AnnounceShipmentResult | Error;

/** A scripted `SendcloudPort`. Unscripted calls throw, loudly. */
export class FakeSendcloud implements SendcloudPort {
  readonly isConfigured: boolean;
  readonly announceCalls: AnnounceShipmentInput[] = [];
  readonly cancelCalls: string[] = [];
  readonly downloadCalls: number[] = [];
  private readonly announceScript: AnnounceScript[] = [];
  cancelResult: CancelShipmentResult | Error = { status: "cancelled" };
  downloadResult: Uint8Array = LABEL_BYTES;

  constructor(isConfigured = true) {
    this.isConfigured = isConfigured;
  }

  scriptAnnounce(...results: AnnounceScript[]): this {
    this.announceScript.push(...results);
    return this;
  }

  async announceShipment(input: AnnounceShipmentInput): Promise<AnnounceShipmentResult> {
    this.announceCalls.push(input);
    const next = this.announceScript.shift();
    if (next === undefined) {
      throw new Error("FakeSendcloud: no announce scripted");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async cancelShipment(id: string): Promise<CancelShipmentResult> {
    this.cancelCalls.push(id);
    if (this.cancelResult instanceof Error) {
      throw this.cancelResult;
    }
    return this.cancelResult;
  }

  async downloadLabel(parcelId: number): Promise<Uint8Array> {
    this.downloadCalls.push(parcelId);
    return this.downloadResult;
  }

  searchServicePoints(): Promise<ServicePointSearchResult> {
    throw new Error("FakeSendcloud: not scripted");
  }
  getServicePoint(): Promise<SendcloudServicePoint> {
    throw new Error("FakeSendcloud: not scripted");
  }
  checkServicePointAvailability(): Promise<boolean> {
    throw new Error("FakeSendcloud: not scripted");
  }
  listShippingOptions(): Promise<readonly SendcloudShippingOption[]> {
    throw new Error("FakeSendcloud: not scripted");
  }
  getShipment(): Promise<SendcloudShipment> {
    throw new Error("FakeSendcloud: not scripted");
  }
  findShipmentByExternalReference(): Promise<SendcloudShipment | null> {
    throw new Error("FakeSendcloud: not scripted");
  }
  getTracking(): Promise<SendcloudTracking> {
    throw new Error("FakeSendcloud: not scripted");
  }
}

export class InMemoryLabelStorage implements LabelStorage {
  readonly objects = new Map<string, Uint8Array>();
  failPut = false;

  async put(objectKey: string, pdf: Uint8Array): Promise<void> {
    if (this.failPut) {
      throw new Error("storage down");
    }
    this.objects.set(objectKey, pdf);
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const bytes = this.objects.get(objectKey);
    if (bytes === undefined) {
      throw new Error(`no object ${objectKey}`);
    }
    return bytes;
  }

  signedUrl(objectKey: string): string {
    return `https://s3.test/akai-private/${objectKey}?X-Amz-Signature=abc`;
  }
}
