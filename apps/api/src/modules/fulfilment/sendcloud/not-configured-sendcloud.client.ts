import { FulfilmentError } from "../fulfilment.errors";
import type {
  AnnounceShipmentResult,
  CancelShipmentResult,
  SendcloudPort,
  SendcloudServicePoint,
  SendcloudShipment,
  SendcloudShippingOption,
  SendcloudTracking,
  ServicePointSearchResult,
} from "./sendcloud.port";

/**
 * The binding used when `config.sendcloud` is null (no SENDCLOUD_* keys).
 *
 * THE FEATURE IS ABSENT, NOT BROKEN — the DeepL `UnconfiguredTranslationGateway`
 * precedent. Every call rejects with a coded `FulfilmentError`
 * (FULFILMENT_NOT_CONFIGURED, a 409 with a `reason`), which each consumer turns
 * into its own documented answer (spec §3.8): pickup-point search → UNAVAILABLE,
 * checkout of a SERVICE_POINT rate → refused with a clear code, label actions →
 * the coded 409 itself. `isConfigured: false` lets a consumer branch without
 * catching at all.
 *
 * The alternatives are all worse: failing at boot would make an optional
 * integration a deployment prerequisite (and stop every contributor without a
 * Sendcloud account running the API); a plain throw would be a 500 that pages
 * someone; returning empty results would render "no pickup points near you"
 * when the truth is "we cannot look".
 */
export class NotConfiguredSendcloudClient implements SendcloudPort {
  readonly isConfigured = false;

  private refuse<T>(): Promise<T> {
    return Promise.reject(FulfilmentError.from("FULFILMENT_NOT_CONFIGURED"));
  }

  searchServicePoints(): Promise<ServicePointSearchResult> {
    return this.refuse();
  }

  getServicePoint(): Promise<SendcloudServicePoint> {
    return this.refuse();
  }

  checkServicePointAvailability(): Promise<boolean> {
    return this.refuse();
  }

  listShippingOptions(): Promise<readonly SendcloudShippingOption[]> {
    return this.refuse();
  }

  announceShipment(): Promise<AnnounceShipmentResult> {
    return this.refuse();
  }

  getShipment(): Promise<SendcloudShipment> {
    return this.refuse();
  }

  findShipmentByExternalReference(): Promise<SendcloudShipment | null> {
    return this.refuse();
  }

  cancelShipment(): Promise<CancelShipmentResult> {
    return this.refuse();
  }

  downloadLabel(): Promise<Uint8Array> {
    return this.refuse();
  }

  getTracking(): Promise<SendcloudTracking> {
    return this.refuse();
  }
}
