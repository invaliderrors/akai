/**
 * The Sendcloud v3 surface this system uses — and ONLY that surface.
 *
 * Every consumer (pickup-point search, checkout verification, labels, the
 * tracking sync, the admin option picker) depends on this interface, never on
 * `SendcloudClient`, so each is unit-testable against an in-memory double and
 * `NotConfiguredSendcloudClient` can stand in when SENDCLOUD_* is unset.
 *
 * The types below are OUR narrow, camelCase view of Sendcloud's objects, not
 * the vendor's JSON: the client parses each response through zod and maps it
 * here, so a field we do not read cannot become a dependency by accident.
 *
 * Spec: docs/superpowers/specs/2026-09-24-sendcloud-shipping.md §1, §3, §11a.
 */

export const SENDCLOUD_CLIENT = Symbol("SENDCLOUD_CLIENT");

export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export const WEEKDAYS: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** One opening shift, "HH:MM" strings exactly as Sendcloud sends them. */
export interface SendcloudOpeningShift {
  readonly start: string;
  readonly end: string;
}

/** `null` = closed that day. The CURRENT week's hours (spec §1 S7). */
export type SendcloudOpeningTimes = Readonly<Record<Weekday, readonly SendcloudOpeningShift[] | null>>;

export interface SendcloudServicePoint {
  /** Sendcloud's id — an INTEGER here; the shipment API takes it as a string. */
  readonly id: number;
  readonly name: string;
  readonly carrierCode: string;
  /** The carrier's own id for the point (`ES21366`). */
  readonly carrierServicePointId: string | null;
  /** `servicepoint` | `locker` | `post_office` | whatever Sendcloud adds. Raw. */
  readonly shopType: string | null;
  readonly street: string;
  /** Often `""` — Sendcloud folds it into `street` for many points. */
  readonly houseNumber: string;
  readonly postalCode: string;
  readonly city: string;
  readonly countryCode: string;
  /** Metres from the searched address; null on a by-id read. */
  readonly distanceMeters: number | null;
  readonly isExpired: boolean;
  readonly openingTimes: SendcloudOpeningTimes;
}

/**
 * `matched` / `partially_matched` / `not_found`, or whatever Sendcloud adds —
 * kept as a string so a new status degrades in the caller, not in the parse.
 * Null when the response carried no geocoding block (a search by coordinates).
 */
export type SendcloudGeocodingStatus = string | null;

export interface ServicePointSearchParams {
  readonly countryCode: string;
  /** Only these carriers' points. Never empty in practice — a rate has ONE carrier. */
  readonly carrierCodes: readonly string[];
  readonly postalCode: string;
  readonly city?: string | undefined;
  /** Metres; Sendcloud caps it at 50 000. */
  readonly radiusMeters?: number | undefined;
  /** Sendcloud caps it at 200. */
  readonly limit?: number | undefined;
}

export interface ServicePointSearchResult {
  readonly geocodingStatus: SendcloudGeocodingStatus;
  readonly points: readonly SendcloudServicePoint[];
}

/** One parcel of a shipment. We announce exactly one per order (spec §3.5). */
export interface SendcloudParcel {
  /** Sendcloud parcel id. A JSON number; persisted as BigInt (`Shipment.sendcloudParcelId`). */
  readonly id: number;
  /** The v3 status code (`READY_TO_SEND`, `ANNOUNCEMENT_FAILED`, … — spec §11a G4). */
  readonly statusCode: string | null;
  readonly statusMessage: string | null;
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
  /**
   * The label, when Sendcloud returned it inline (a synchronous single-parcel
   * announce does, as base64 — decoded here). Null otherwise: download it with
   * `downloadLabel`.
   */
  readonly labelPdf: Uint8Array | null;
}

/**
 * A JSON:API error object as Sendcloud sends it — inside a 4xx/5xx body, and
 * ALSO inside a 200 announce whose announcement failed (spec §1 S9).
 */
export interface SendcloudErrorDetail {
  readonly status: number | null;
  readonly code: string;
  readonly detail: string;
  /** JSON pointer into our request body (`/to_address/name`), when given. */
  readonly pointer: string | null;
}

export interface SendcloudShipment {
  /** Sendcloud's shipment id (a UUID string in v3). */
  readonly id: string;
  /** Ours — the order id. Unique per Sendcloud account. */
  readonly externalReferenceId: string | null;
  readonly orderNumber: string | null;
  readonly carrierCode: string | null;
  readonly carrierName: string | null;
  readonly shippingOptionCode: string | null;
  readonly parcels: readonly SendcloudParcel[];
  /** Non-empty on a 200 whose announcement FAILED. Check it (and each parcel's status). */
  readonly errors: readonly SendcloudErrorDetail[];
}

/** The destination as a label needs it — from the order snapshot. */
export interface SendcloudRecipient {
  readonly name: string;
  readonly companyName: string | null;
  readonly addressLine1: string;
  readonly houseNumber: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string;
  readonly city: string;
  readonly countryCode: string;
  readonly email: string;
  readonly phoneNumber: string | null;
}

export interface AnnounceShipmentInput {
  /** Our order id. Re-announcing the same one returns the EXISTING shipment (409). */
  readonly externalReferenceId: string;
  readonly orderNumber: string;
  readonly senderAddressId: number;
  readonly recipient: SendcloudRecipient;
  /** The pickup point, as a STRING id (spec §1 S10). Null for home delivery. */
  readonly servicePointId: string | null;
  /**
   * The option code to ship with. Pass it through `effectiveShippingOptionCode`
   * first so TEST mode buys `sendcloud:letter` instead — see `test-mode.ts`.
   */
  readonly shippingOptionCode: string;
  readonly weightGrams: number;
  /**
   * Sendcloud's `total_order_price`, as a MAJOR-unit decimal string produced by
   * `libs/money`'s `toDecimalString` (never a float). Optional.
   */
  readonly totalOrderPrice?: { readonly value: string; readonly currency: string } | undefined;
}

export interface AnnounceShipmentResult {
  readonly shipment: SendcloudShipment;
  /**
   * True when Sendcloud answered 409 because `externalReferenceId` was already
   * used, and handed back the EXISTING shipment. A retried job therefore never
   * buys a second label.
   */
  readonly reused: boolean;
}

/** `cancelled` (200), `queued` (202, done within 14 days) or `rejected` (409). */
export type CancelShipmentResult =
  | { readonly status: "cancelled" | "queued" }
  | { readonly status: "rejected"; readonly detail: string };

export interface SendcloudTrackingEvent {
  readonly at: string | null;
  readonly statusCode: string | null;
  readonly message: string | null;
}

export interface SendcloudTracking {
  readonly events: readonly SendcloudTrackingEvent[];
  /** ISO date (`2024-01-03`) or null. */
  readonly expectedDeliveryDate: string | null;
}

export interface ShippingOptionsQuery {
  readonly fromCountryCode: string;
  readonly toCountryCode: string;
  readonly weightGrams: number;
}

export interface SendcloudShippingOption {
  readonly code: string;
  readonly name: string;
  readonly carrierCode: string;
  readonly carrierName: string;
  /** `service_point`, `home_delivery`, … — raw. */
  readonly lastMile: string | null;
  readonly requiresServicePoint: boolean;
  readonly requiredFields: readonly string[];
  /** The merchant's quoted cost as Sendcloud's decimal string, or null. */
  readonly quoteTotal: { readonly value: string; readonly currency: string } | null;
}

export interface SendcloudPort {
  /** False for the NOT_CONFIGURED binding. Lets a caller branch without catching. */
  readonly isConfigured: boolean;

  searchServicePoints(params: ServicePointSearchParams): Promise<ServicePointSearchResult>;
  getServicePoint(id: string): Promise<SendcloudServicePoint>;
  checkServicePointAvailability(id: string): Promise<boolean>;

  listShippingOptions(query: ShippingOptionsQuery): Promise<readonly SendcloudShippingOption[]>;

  announceShipment(input: AnnounceShipmentInput): Promise<AnnounceShipmentResult>;
  getShipment(id: string): Promise<SendcloudShipment>;
  /** Null when no shipment carries that reference. */
  findShipmentByExternalReference(externalReferenceId: string): Promise<SendcloudShipment | null>;
  cancelShipment(id: string): Promise<CancelShipmentResult>;

  /** The label PDF bytes (A6 unless another size is asked for). */
  downloadLabel(parcelId: number, paperSize?: "A4" | "A5" | "A6"): Promise<Uint8Array>;
  getTracking(trackingNumber: string): Promise<SendcloudTracking>;
}
