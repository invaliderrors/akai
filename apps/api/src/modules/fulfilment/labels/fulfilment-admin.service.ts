import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { BulkLabelResult, CancelLabelResult } from "@akai/contracts";
import { RecordNotFoundError } from "@akai/db";
import type { Logger } from "@akai/observability";

import { LOGGER } from "../../observability/logger.module";
import { FulfilmentError } from "../fulfilment.errors";
import { SendcloudError } from "../sendcloud/sendcloud.errors";
import { SENDCLOUD_CLIENT, type SendcloudPort } from "../sendcloud/sendcloud.port";
import { FULFILMENT_REPOSITORY, type FulfilmentRepository } from "./fulfilment.repository";
import { labelSkipReason } from "./label-eligibility";
import { LABEL_STORAGE, type LabelStorage } from "./label-storage";
import { mergePdfs } from "./pdf-merge";
import { SendcloudWriteThrottle } from "./sendcloud-write-throttle";

export interface PrintedLabels {
  readonly pdf: Uint8Array;
  readonly count: number;
  /** Requested order ids with no stored label, in request order. */
  readonly skippedOrderIds: readonly string[];
}

/**
 * The staff actions on labels (spec §3.5 cancel, §3.6 bulk generate/print,
 * §5 endpoints). The controller is thin; every rule is here.
 */
@Injectable()
export class FulfilmentAdminService {
  constructor(
    @Inject(FULFILMENT_REPOSITORY) private readonly repository: FulfilmentRepository,
    @Inject(SENDCLOUD_CLIENT) private readonly sendcloud: SendcloudPort,
    @Inject(LABEL_STORAGE) private readonly storage: LabelStorage,
    private readonly throttle: SendcloudWriteThrottle,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * "Generar etiquetas": split the request into accepted / skipped with the
   * SAME eligibility the job re-applies at run time, and enqueue one
   * `order-fulfilment` message per accepted order. Answers immediately — the
   * outbox supplies retries, backoff, the Sendcloud throttle and a dead-letter
   * row at /admin/jobs.
   *
   * Refused outright (409 FULFILMENT_NOT_CONFIGURED) on a deployment with no
   * Sendcloud keys: enqueuing jobs that can only dead-letter would turn a
   * configuration question into a wall of red at /admin/jobs.
   */
  async enqueueLabels(orderIds: readonly string[], actorId: string): Promise<BulkLabelResult> {
    if (!this.sendcloud.isConfigured) {
      throw FulfilmentError.from("FULFILMENT_NOT_CONFIGURED");
    }

    const orders = new Map(
      (await this.repository.loadOrdersForBulk(orderIds)).map((order) => [order.id, order]),
    );

    const accepted: { id: string; orderNumber: string }[] = [];
    const skipped: BulkLabelResult["skipped"][number][] = [];
    // Request order, so the toast and its detail read in the order staff selected.
    for (const orderId of orderIds) {
      const order = orders.get(orderId);
      if (order === undefined) {
        skipped.push({ orderId, orderNumber: null, reason: "NOT_FOUND" });
        continue;
      }
      const reason = labelSkipReason(order);
      if (reason === null) {
        accepted.push({ id: order.id, orderNumber: order.orderNumber });
      } else {
        skipped.push({ orderId, orderNumber: order.orderNumber, reason });
      }
    }

    await this.repository.enqueueCreateLabel(
      accepted.map((order) => order.id),
      actorId,
    );

    return { accepted: accepted.map((order) => order.orderNumber), skipped };
  }

  /** "Reintentar": a FAILED Sendcloud label, re-enqueued as a fresh attempt. */
  async retry(shipmentId: string, actorId: string): Promise<BulkLabelResult> {
    const shipment = await this.requireShipment(shipmentId);
    if (shipment.provider !== "SENDCLOUD" || shipment.status !== "FAILED") {
      throw new ConflictException(
        `Shipment ${shipmentId} is ${shipment.provider} ${shipment.status}; only a FAILED Sendcloud label can be retried.`,
      );
    }
    return this.enqueueLabels([shipment.orderId], actorId);
  }

  /**
   * "Cancelar etiqueta" (spec §3.5, §1 S12). 200 cancelled / 202 queued →
   * CANCELLED here and the order back to PAID (when nothing else ships it);
   * 409 → the carrier refused, recorded for staff, answered CANCEL_REJECTED.
   *
   * Only a LABEL_CREATED label: once the carrier has scanned the parcel the
   * order is SHIPPED, and a label cancel cannot un-ship goods.
   */
  async cancel(shipmentId: string, actorId: string): Promise<CancelLabelResult> {
    const shipment = await this.requireShipment(shipmentId);
    if (
      shipment.provider !== "SENDCLOUD" ||
      shipment.sendcloudShipmentId === null ||
      shipment.status !== "LABEL_CREATED"
    ) {
      throw FulfilmentError.from("CANCEL_REJECTED");
    }

    let outcome: Awaited<ReturnType<SendcloudPort["cancelShipment"]>>;
    try {
      await this.throttle.acquire();
      outcome = await this.sendcloud.cancelShipment(shipment.sendcloudShipmentId);
    } catch (error) {
      if (error instanceof SendcloudError) {
        this.logger.warn({ shipmentId, err: error.message }, "Sendcloud cancel failed");
        throw FulfilmentError.from("VENDOR_UNAVAILABLE");
      }
      throw error;
    }

    if (outcome.status === "rejected") {
      await this.repository.recordCancelRejected(shipmentId, actorId, outcome.detail);
      throw FulfilmentError.from("CANCEL_REJECTED");
    }

    const result = await this.repository.markCancelled(
      shipmentId,
      actorId,
      // Sendcloud's own vocabulary: 202 means it is still being cancelled
      // upstream; the tracking sync will read CANCELLED later either way.
      outcome.status === "queued" ? "CANCELLING" : "CANCELLED",
    );
    if (result === null) {
      // The tracking sync moved the parcel on between our read and our write.
      throw FulfilmentError.from("CANCEL_REJECTED");
    }

    return { shipmentId, status: result.shipmentStatus, orderStatus: result.orderStatus };
  }

  /** The short-lived signed URL the admin download 302s to. */
  async labelUrl(shipmentId: string): Promise<string> {
    const shipment = await this.requireShipment(shipmentId);
    if (shipment.labelObjectKey === null) {
      throw FulfilmentError.from("LABEL_NOT_AVAILABLE");
    }
    return this.storage.signedUrl(shipment.labelObjectKey);
  }

  /**
   * "Imprimir etiquetas": OUR stored PDFs merged in request order. No vendor
   * call — reprints are free and work while Sendcloud is down. Orders with no
   * stored label are reported, not fatal; a request in which NONE has one is
   * LABEL_NOT_AVAILABLE rather than an empty PDF.
   */
  async print(orderIds: readonly string[]): Promise<PrintedLabels> {
    const keys = await this.repository.loadPrintableLabels(orderIds);

    const objectKeys: string[] = [];
    const skippedOrderIds: string[] = [];
    for (const orderId of orderIds) {
      const key = keys.get(orderId);
      if (key === undefined) {
        skippedOrderIds.push(orderId);
      } else {
        objectKeys.push(key);
      }
    }

    if (objectKeys.length === 0) {
      throw FulfilmentError.from("LABEL_NOT_AVAILABLE");
    }

    const pdfs: Uint8Array[] = [];
    for (const key of objectKeys) {
      pdfs.push(await this.storage.get(key));
    }

    return { pdf: await mergePdfs(pdfs), count: objectKeys.length, skippedOrderIds };
  }

  private async requireShipment(shipmentId: string) {
    const shipment = await this.repository.loadShipment(shipmentId);
    if (shipment === null) {
      throw new RecordNotFoundError("Shipment");
    }
    return shipment;
  }
}
