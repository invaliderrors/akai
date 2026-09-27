import { Inject, Injectable } from "@nestjs/common";
import { type BulkLabelSkipReason, type CurrencyCode, currencyCodeSchema } from "@akai/contracts";
import type { SendcloudConfig, ServerEnv } from "@akai/config";
import { toDecimalString, toMinor } from "@akai/money";
import type { Logger } from "@akai/observability";

import { CLOCK, type Clock } from "../../auth/ports/clock.port";
import { SERVER_CONFIG } from "../../config/config.module";
import { LOGGER } from "../../observability/logger.module";
import { carrierDisplayName } from "../../shipping/carrier-names";
import { FulfilmentError } from "../fulfilment.errors";
import { SendcloudError } from "../sendcloud/sendcloud.errors";
import {
  SENDCLOUD_CLIENT,
  type SendcloudPort,
  type SendcloudShipment,
} from "../sendcloud/sendcloud.port";
import { effectiveShippingOptionCode, servicePointIdForMode } from "../sendcloud/test-mode";
import {
  FULFILMENT_REPOSITORY,
  type FulfilmentRepository,
  type LabelOrder,
} from "./fulfilment.repository";
import { externalReferenceFor, labelSkipReason } from "./label-eligibility";
import { LABEL_STORAGE, type LabelStorage, labelObjectKey } from "./label-storage";
import { SendcloudWriteThrottle } from "./sendcloud-write-throttle";

/** What one `createForOrder` call did. Thrown errors mean "try again later". */
export type LabelOutcome =
  | { readonly kind: "created"; readonly shipmentId: string }
  /** A redelivered job found the label already recorded — nothing bought. */
  | { readonly kind: "already-recorded"; readonly shipmentId: string }
  /** Sendcloud refused; a FAILED shipment holds the detail. The order is untouched. */
  | { readonly kind: "failed"; readonly shipmentId: string; readonly detail: string }
  /** Not eligible (any more): nothing was sent to Sendcloud. */
  | { readonly kind: "skipped"; readonly reason: BulkLabelSkipReason };

/** Parcel status codes that mean the announcement did not produce a label (spike §11a G4). */
const FAILED_PARCEL_CODES: ReadonlySet<string> = new Set(["ANNOUNCEMENT_FAILED"]);

/** `failureReason` is `text`, but the admin DTO caps it at 2000 — cut here, once. */
const MAX_FAILURE_DETAIL = 2000;

/**
 * A vendor fault worth retrying rather than recording as a refused label:
 * rate limits, transient 5xx, no answer, and OUR credentials being refused
 * (401/403 — a configuration fault staff fix once, not a per-order refusal).
 */
function isTransient(error: SendcloudError): boolean {
  return error.retryable || error.status === 401 || error.status === 403 || error.status >= 500;
}

/**
 * Buys ONE Sendcloud label for ONE order — spec §3.5, the only code that does.
 *
 * THE VENDOR CALL IS OUTSIDE ANY TRANSACTION, the database writes are inside
 * one, and the gap between them is healed by the reference, not by luck: a
 * crash after Sendcloud bought the label and before we recorded it leaves no
 * row, so the retried job sends the SAME `external_reference_id`, Sendcloud
 * answers 409 with the label it already sold, and this records THAT. Holding
 * a Postgres transaction open across an HTTP call to a vendor would instead
 * pin a connection for as long as Sendcloud takes to answer.
 *
 * THROWS to mean "retry" (the outbox gives eight attempts with backoff):
 * a transient Sendcloud fault, a label that could not be downloaded or
 * stored, a concurrent status change. RETURNS for every settled answer,
 * including a refusal — a FAILED row is the durable record of it, and
 * retrying a rejected address eight times would only fill the log.
 *
 * It does NOT send the shipping-confirmation mail: an order is "Enviado" at
 * the carrier's first scan (decision D4), which the tracking sync owns.
 */
@Injectable()
export class LabelService {
  constructor(
    @Inject(FULFILMENT_REPOSITORY) private readonly repository: FulfilmentRepository,
    @Inject(SENDCLOUD_CLIENT) private readonly sendcloud: SendcloudPort,
    @Inject(LABEL_STORAGE) private readonly storage: LabelStorage,
    private readonly throttle: SendcloudWriteThrottle,
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerEnv, "sendcloud">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async createForOrder(orderId: string, actorId: string | null): Promise<LabelOutcome> {
    const settings = this.requireSettings();

    const order = await this.repository.loadOrderForLabel(orderId);
    if (order === null) {
      return { kind: "skipped", reason: "NOT_FOUND" };
    }

    // Re-checked at RUN time: minutes can pass between the click and the job,
    // and an order cancelled or labelled by hand meanwhile must not buy one.
    const skip = labelSkipReason(order);
    if (skip !== null) {
      return { kind: "skipped", reason: skip };
    }
    // Narrowed again for the compiler — `labelSkipReason` returned null only
    // because both are present.
    const mappedCode = order.sendcloudOptionCode;
    const weightGrams = order.parcelWeightGrams;
    if (mappedCode === null || weightGrams === null) {
      return { kind: "skipped", reason: mappedCode === null ? "RATE_NOT_MAPPED" : "WEIGHT_MISSING" };
    }

    const optionCode = effectiveShippingOptionCode(settings.mode, mappedCode);
    const now = this.clock.now();

    let announced: SendcloudShipment;
    let reused: boolean;
    try {
      await this.throttle.acquire();
      const result = await this.sendcloud.announceShipment({
        externalReferenceId: externalReferenceFor(order.id, order.shipments),
        orderNumber: order.orderNumber,
        senderAddressId: settings.senderAddressId,
        recipient: {
          name: `${order.shipFirstName} ${order.shipLastName}`.trim(),
          companyName: order.shipCompany,
          addressLine1: order.shipLine1,
          houseNumber: order.shipHouseNumber,
          addressLine2: order.shipLine2,
          postalCode: order.shipPostalCode,
          city: order.shipCity,
          countryCode: order.shipCountryCode,
          email: order.email,
          phoneNumber: order.shipPhone,
        },
        servicePointId: servicePointIdForMode(settings.mode, order.servicePointId),
        shippingOptionCode: optionCode,
        weightGrams,
        totalOrderPrice: {
          value: toDecimalString(toMinor(order.grandTotal), asCurrency(order.currency)),
          currency: order.currency,
        },
      });
      announced = result.shipment;
      reused = result.reused;
    } catch (error) {
      if (error instanceof SendcloudError && !isTransient(error)) {
        // A 4xx refusal of the REQUEST (bad address, unknown option): nothing
        // was created at Sendcloud, so the row carries no vendor ids.
        return this.recordFailure(order, actorId, now, {
          sendcloudShipmentId: null,
          sendcloudParcelId: null,
          carrier: carrierLabel(null, null, mappedCode),
          statusCode: null,
          detail: `${error.code}: ${error.detail}`,
        });
      }
      throw error;
    }

    const parcel = announced.parcels[0];
    const failed =
      announced.errors.length > 0 ||
      parcel === undefined ||
      (parcel.statusCode !== null && FAILED_PARCEL_CODES.has(parcel.statusCode));

    if (failed) {
      // 200 WITH A FAILED ANNOUNCEMENT (spec §1 S9) — or a reused 409 whose
      // existing shipment is itself a failure. Not billed; nothing to print.
      return this.recordFailure(order, actorId, now, {
        sendcloudShipmentId: announced.id,
        sendcloudParcelId: parcel?.id ?? null,
        carrier: carrierLabel(announced.carrierCode, announced.carrierName, mappedCode),
        statusCode: parcel?.statusCode ?? null,
        detail: failureDetail(announced),
      });
    }

    // The label: inline on a synchronous single-parcel announce (and on the
    // 409 reuse — spike §11a G3), otherwise downloaded. A download failure
    // THROWS: the label is bought, and the retry's 409 will hand it back.
    const pdf = parcel.labelPdf ?? (await this.sendcloud.downloadLabel(parcel.id, "A6"));
    const objectKey = labelObjectKey(order.id, parcel.id);
    await this.storage.put(objectKey, pdf);

    const recorded = await this.repository.recordLabel({
      orderId: order.id,
      actorId,
      sendcloudShipmentId: announced.id,
      sendcloudParcelId: parcel.id,
      carrier: carrierLabel(announced.carrierCode, announced.carrierName, mappedCode),
      trackingNumber: parcel.trackingNumber,
      trackingUrl: parcel.trackingUrl,
      statusCode: parcel.statusCode,
      labelObjectKey: objectKey,
      now,
    });

    this.logger.info(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        shipmentId: recorded.shipmentId,
        sendcloudShipmentId: announced.id,
        reused,
        mode: settings.mode,
        optionCode,
      },
      recorded.created ? "Sendcloud label created" : "Sendcloud label already recorded",
    );

    return recorded.created
      ? { kind: "created", shipmentId: recorded.shipmentId }
      : { kind: "already-recorded", shipmentId: recorded.shipmentId };
  }

  private requireSettings(): SendcloudConfig {
    const settings = this.config.sendcloud;
    if (settings === null || !this.sendcloud.isConfigured) {
      throw FulfilmentError.from("FULFILMENT_NOT_CONFIGURED");
    }
    return settings;
  }

  private async recordFailure(
    order: LabelOrder,
    actorId: string | null,
    now: Date,
    failure: {
      readonly sendcloudShipmentId: string | null;
      readonly sendcloudParcelId: number | null;
      readonly carrier: string;
      readonly statusCode: string | null;
      readonly detail: string;
    },
  ): Promise<LabelOutcome> {
    const detail = failure.detail.slice(0, MAX_FAILURE_DETAIL);
    const recorded = await this.repository.recordFailure({
      orderId: order.id,
      actorId,
      sendcloudShipmentId: failure.sendcloudShipmentId,
      sendcloudParcelId: failure.sendcloudParcelId,
      carrier: failure.carrier,
      statusCode: failure.statusCode,
      failureReason: detail,
      now,
    });
    this.logger.warn(
      { orderId: order.id, orderNumber: order.orderNumber, shipmentId: recorded.shipmentId, detail },
      "Sendcloud refused the label",
    );
    return { kind: "failed", shipmentId: recorded.shipmentId, detail };
  }
}

/**
 * The carrier as the CUSTOMER reads it later (the shipping mail prints this
 * column): our display name for the code, else Sendcloud's name, else the
 * code the rate was mapped to. Capped at the column's 64.
 */
function carrierLabel(code: string | null, name: string | null, mappedCode: string): string {
  const fromMapping = mappedCode.split(":")[0] ?? mappedCode;
  const label = carrierDisplayName(code) ?? name ?? carrierDisplayName(fromMapping) ?? code ?? fromMapping;
  return label.slice(0, 64);
}

/** Sendcloud's own words, for STAFF (never a customer): every error, else the parcel's message. */
function failureDetail(shipment: SendcloudShipment): string {
  if (shipment.errors.length > 0) {
    return shipment.errors
      .map(
        (error) =>
          `${error.code}: ${error.detail}` + (error.pointer === null ? "" : ` (${error.pointer})`),
      )
      .join("; ");
  }
  const parcel = shipment.parcels[0];
  if (parcel === undefined) {
    return "Sendcloud returned no parcel for the shipment.";
  }
  return parcel.statusMessage ?? `Parcel status ${parcel.statusCode ?? "unknown"}.`;
}

/**
 * The order's currency column is `char(3)` written by checkout from a
 * validated code; `toDecimalString` wants the branded type. Narrowed through
 * the contract schema rather than cast.
 */
function asCurrency(value: string): CurrencyCode {
  return currencyCodeSchema.parse(value);
}
