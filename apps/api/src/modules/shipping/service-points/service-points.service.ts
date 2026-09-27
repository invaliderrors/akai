import { Inject, Injectable } from "@nestjs/common";
import {
  type OpeningHours,
  type ServicePoint,
  type ServicePointSearchRequest,
  type ServicePointSearchResponse,
  type ServicePointShopType,
  servicePointSchema,
} from "@akai/contracts";
import type { Logger } from "@akai/observability";

import { LOGGER } from "../../observability/logger.module";
import { FulfilmentError } from "../../fulfilment/fulfilment.errors";
import { SendcloudError } from "../../fulfilment/sendcloud/sendcloud.errors";
import {
  type SendcloudOpeningShift,
  type SendcloudPort,
  type SendcloudServicePoint,
} from "../../fulfilment/sendcloud/sendcloud.port";
import type { RateFulfilment } from "../shipping-rate.selector";
import { SHIPPING_REPOSITORY, type ShippingRepository } from "../shipping.repository";
import { ShippingError } from "../shipping.errors";
import { SENDCLOUD_INTERACTIVE_CLIENT } from "./interactive-sendcloud.client";

/**
 * Pickup points — the search a shopper runs under a SERVICE_POINT method, and
 * the re-verification checkout runs on the point they chose (spec
 * 2026-09-24-sendcloud-shipping §3.2, §3.3).
 *
 * THE BROWSER NEVER TALKS TO SENDCLOUD: the search needs the secret key (S7),
 * so the storefront asks us and we ask Sendcloud. The request names a RATE,
 * never a carrier — the carrier is resolved from the rate here, so no client
 * can be offered (or check out with) another carrier's point.
 *
 * EVERY VENDOR FAILURE IS AN ORDINARY ANSWER, never a 500: a search that cannot
 * reach Sendcloud answers `UNAVAILABLE` (the storefront shows a retry), and a
 * checkout that cannot re-verify the point is refused with
 * SERVICE_POINT_UNAVAILABLE (the customer retries or picks another). Only OUR
 * bugs escape as exceptions.
 */

/** Spec §3.2: 10 km first, widened ONCE to 25 km when nothing is found. */
export const SEARCH_RADIUS_METERS = 10_000;
export const WIDENED_RADIUS_METERS = 25_000;
export const SEARCH_LIMIT = 20;

/** Five minutes, and bounded so a postcode-walking scraper cannot grow the heap. */
export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
export const SEARCH_CACHE_MAX_ENTRIES = 500;

/** DB column widths (`Order.servicePoint*`) — a longer vendor string would 500 the insert. */
const SNAPSHOT_NAME_MAX = 120;
const SNAPSHOT_ADDRESS_MAX = 255;
const SNAPSHOT_CARRIER_ID_MAX = 64;
const SNAPSHOT_ID_MAX = 32;

/** What checkout stamps onto the order for a pickup-point rate. */
export interface ServicePointSnapshot {
  readonly servicePointId: string;
  /** The CARRIER's own id for the point (`ES21366`) — `Order.servicePointCarrierId`. */
  readonly servicePointCarrierId: string | null;
  readonly servicePointName: string;
  /** One formatted line: "street number, postcode city, CC". */
  readonly servicePointAddress: string;
  /** Carrier post number (DHL Packstation-style). Nothing we ship with needs it yet. */
  readonly servicePointPostNumber: string | null;
}

export interface VerifyServicePointInput {
  readonly fulfilment: RateFulfilment;
  readonly servicePointId: string | null;
  /** The SHIPPING address's country. */
  readonly countryCode: string;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly response: ServicePointSearchResponse;
}

export const SERVICE_POINTS_CLOCK = Symbol("SERVICE_POINTS_CLOCK");
export type ServicePointsClock = () => number;

@Injectable()
export class ServicePointsService {
  /** Insertion-ordered, so the oldest entry is evicted first. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(SHIPPING_REPOSITORY) private readonly repository: ShippingRepository,
    @Inject(SENDCLOUD_INTERACTIVE_CLIENT) private readonly sendcloud: SendcloudPort,
    @Inject(LOGGER) private readonly logger: Pick<Logger, "warn">,
    @Inject(SERVICE_POINTS_CLOCK) private readonly now: ServicePointsClock,
  ) {}

  /**
   * `POST /v1/shipping/service-points`.
   *
   * Refusals that ARE the caller's fault throw (coded): an unknown rate or one
   * not offered in this country is `methodUnavailable` (404, like checkout), a
   * HOME rate is SERVICE_POINT_NOT_ALLOWED. Everything else is a 200 status.
   */
  async search(request: ServicePointSearchRequest): Promise<ServicePointSearchResponse> {
    const zone = await this.repository.findZoneForCountry(request.countryCode);
    const rate = zone?.rates.find((row) => row.id === request.rateId) ?? null;
    if (rate === null) {
      throw ShippingError.methodUnavailable();
    }
    if (rate.fulfilment.deliveryType !== "SERVICE_POINT") {
      throw FulfilmentError.from("SERVICE_POINT_NOT_ALLOWED");
    }

    const carrierCode = rate.fulfilment.carrierCode;
    if (carrierCode === null) {
      // An operator mapped a pickup rate without a carrier. Not the shopper's
      // fault and not fixable by them: the same answer as a vendor outage.
      this.logger.warn({ rateId: rate.id }, "Pickup-point rate has no carrier code");
      return unavailable();
    }
    if (!this.sendcloud.isConfigured) {
      return unavailable();
    }

    const key = cacheKey(carrierCode, request);
    const cached = this.readCache(key);
    if (cached !== null) {
      return cached;
    }

    let response: ServicePointSearchResponse;
    try {
      response = await this.searchVendor(carrierCode, request);
    } catch (error: unknown) {
      if (!isVendorFailure(error)) {
        throw error;
      }
      this.logger.warn(
        { err: error, carrierCode, countryCode: request.countryCode },
        "Pickup-point search failed; answering UNAVAILABLE",
      );
      // NOT cached: an outage must not outlive itself by five minutes.
      return unavailable();
    }

    this.writeCache(key, response);
    return response;
  }

  /**
   * Checkout's gate for the point (spec §3.3). Returns the snapshot to stamp on
   * the order, or null for a HOME rate. Runs BEFORE any stock is held, so a
   * refusal here has no side effects.
   */
  async verifyForCheckout(input: VerifyServicePointInput): Promise<ServicePointSnapshot | null> {
    const { fulfilment, servicePointId } = input;

    if (fulfilment.deliveryType === "HOME") {
      if (servicePointId !== null) {
        throw FulfilmentError.from("SERVICE_POINT_NOT_ALLOWED");
      }
      return null;
    }

    if (servicePointId === null) {
      throw FulfilmentError.from("SERVICE_POINT_REQUIRED");
    }
    if (fulfilment.carrierCode === null || !this.sendcloud.isConfigured) {
      throw FulfilmentError.from("SERVICE_POINT_UNAVAILABLE");
    }

    let point: SendcloudServicePoint;
    let available: boolean;
    try {
      point = await this.sendcloud.getServicePoint(servicePointId);
      if (
        point.carrierCode !== fulfilment.carrierCode ||
        point.countryCode.toUpperCase() !== input.countryCode.toUpperCase() ||
        point.isExpired
      ) {
        throw FulfilmentError.from("SERVICE_POINT_UNAVAILABLE");
      }
      // Sendcloud's own advice (S8): re-check just before relying on it.
      available = await this.sendcloud.checkServicePointAvailability(servicePointId);
    } catch (error: unknown) {
      if (error instanceof FulfilmentError) {
        throw error;
      }
      if (!isVendorFailure(error)) {
        throw error;
      }
      this.logger.warn(
        { err: error, servicePointId },
        "Pickup-point verification failed at Sendcloud; refusing the point",
      );
      throw FulfilmentError.from("SERVICE_POINT_UNAVAILABLE");
    }

    if (!available) {
      throw FulfilmentError.from("SERVICE_POINT_UNAVAILABLE");
    }

    return {
      servicePointId: String(point.id).slice(0, SNAPSHOT_ID_MAX),
      servicePointCarrierId:
        point.carrierServicePointId === null || point.carrierServicePointId === ""
          ? null
          : point.carrierServicePointId.slice(0, SNAPSHOT_CARRIER_ID_MAX),
      servicePointName: point.name.slice(0, SNAPSHOT_NAME_MAX),
      servicePointAddress: formatServicePointAddress(point).slice(0, SNAPSHOT_ADDRESS_MAX),
      servicePointPostNumber: null,
    };
  }

  private async searchVendor(
    carrierCode: string,
    request: ServicePointSearchRequest,
  ): Promise<ServicePointSearchResponse> {
    const base = {
      countryCode: request.countryCode,
      carrierCodes: [carrierCode],
      postalCode: request.postalCode,
      city: request.city ?? undefined,
      limit: SEARCH_LIMIT,
    };

    let result = await this.sendcloud.searchServicePoints({
      ...base,
      radiusMeters: SEARCH_RADIUS_METERS,
    });
    if (result.geocodingStatus === "not_found") {
      return { status: "ADDRESS_NOT_FOUND", points: [] };
    }

    let points = this.toContractPoints(result.points);
    // Widen ONCE, and only when the address itself was found: widening a
    // partial or failed geocode would just list points around the wrong place.
    if (points.length === 0 && result.geocodingStatus === "matched") {
      result = await this.sendcloud.searchServicePoints({
        ...base,
        radiusMeters: WIDENED_RADIUS_METERS,
      });
      points = this.toContractPoints(result.points);
    }

    return points.length === 0 ? { status: "NONE_NEARBY", points: [] } : { status: "OK", points };
  }

  /**
   * Expired points dropped; each survivor mapped and then PARSED through the
   * public contract, so one malformed vendor row (a 200-character name, a
   * "8:00" shift) is dropped here rather than failing the storefront's strict
   * parse of the whole list.
   */
  private toContractPoints(points: readonly SendcloudServicePoint[]): ServicePoint[] {
    const mapped: ServicePoint[] = [];
    for (const point of points) {
      if (point.isExpired) {
        continue;
      }
      const parsed = servicePointSchema.safeParse(toContractPoint(point));
      if (parsed.success) {
        mapped.push(parsed.data);
      } else {
        this.logger.warn({ servicePointId: point.id }, "Dropping a pickup point that does not fit the contract");
      }
    }
    return mapped;
  }

  private readCache(key: string): ServicePointSearchResponse | null {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.response;
  }

  private writeCache(key: string, response: ServicePointSearchResponse): void {
    this.cache.delete(key);
    while (this.cache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, { expiresAt: this.now() + SEARCH_CACHE_TTL_MS, response });
  }
}

function unavailable(): ServicePointSearchResponse {
  return { status: "UNAVAILABLE", points: [] };
}

/** A Sendcloud fault, or the not-configured binding's coded refusal. */
function isVendorFailure(error: unknown): boolean {
  return error instanceof SendcloudError || error instanceof FulfilmentError;
}

/** carrier|country|postcode|city, normalised so "50002 " and "50002" share an entry. */
export function cacheKey(carrierCode: string, request: ServicePointSearchRequest): string {
  const normalise = (value: string): string => value.trim().replace(/\s+/g, " ").toUpperCase();
  return [
    carrierCode,
    request.countryCode.toUpperCase(),
    normalise(request.postalCode),
    request.city === null ? "" : normalise(request.city),
  ].join("|");
}

const SHOP_TYPES: readonly ServicePointShopType[] = ["servicepoint", "locker", "post_office"];

function toShopType(raw: string | null): ServicePointShopType {
  return SHOP_TYPES.find((type) => type === raw) ?? "other";
}

/** "8:00" / "08:00:00" → "08:00"; anything unreadable → null (the shift is dropped). */
function toClock(raw: string): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const hours = match[1] ?? "";
  const minutes = match[2] ?? "";
  return `${hours.padStart(2, "0")}:${minutes}`;
}

function toShifts(
  shifts: readonly SendcloudOpeningShift[] | null,
): Array<{ from: string; to: string }> | null {
  if (shifts === null) {
    return null;
  }
  const mapped: Array<{ from: string; to: string }> = [];
  for (const shift of shifts) {
    const from = toClock(shift.start);
    const to = toClock(shift.end);
    if (from !== null && to !== null) {
      mapped.push({ from, to });
    }
  }
  // A day whose every shift was unreadable, or that Sendcloud sent as `[]`,
  // is closed as far as a customer can act on it.
  return mapped.length === 0 ? null : mapped;
}

function toOpeningHours(point: SendcloudServicePoint): OpeningHours {
  const times = point.openingTimes;
  return {
    monday: toShifts(times.monday),
    tuesday: toShifts(times.tuesday),
    wednesday: toShifts(times.wednesday),
    thursday: toShifts(times.thursday),
    friday: toShifts(times.friday),
    saturday: toShifts(times.saturday),
    sunday: toShifts(times.sunday),
  };
}

function toContractPoint(point: SendcloudServicePoint): ServicePoint {
  return {
    id: String(point.id),
    name: point.name,
    shopType: toShopType(point.shopType),
    street: point.street,
    houseNumber: point.houseNumber,
    postalCode: point.postalCode,
    city: point.city,
    countryCode: point.countryCode.toUpperCase(),
    distanceMeters:
      point.distanceMeters === null ? null : Math.max(0, Math.round(point.distanceMeters)),
    openingHours: toOpeningHours(point),
  };
}

/** "CALLE MAYOR 1, 50002 ZARAGOZA, ES" — the one line the order keeps. */
export function formatServicePointAddress(
  point: Pick<SendcloudServicePoint, "street" | "houseNumber" | "postalCode" | "city" | "countryCode">,
): string {
  const street = [point.street.trim(), point.houseNumber.trim()].filter((part) => part !== "").join(" ");
  const locality = [point.postalCode.trim(), point.city.trim()].filter((part) => part !== "").join(" ");
  return [street, locality, point.countryCode.trim().toUpperCase()]
    .filter((part) => part !== "")
    .join(", ");
}
