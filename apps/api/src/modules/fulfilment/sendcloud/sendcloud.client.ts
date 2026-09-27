import type { z } from "zod";
import type { Logger } from "@akai/observability";

import { SendcloudError, isRetryableStatus } from "./sendcloud.errors";
import {
  type SendcloudServicePointWire,
  type SendcloudShipmentWire,
  cancelShipmentResponseSchema,
  sendcloudErrorBodySchema,
  sendcloudErrorObjectSchema,
  servicePointAvailabilityResponseSchema,
  servicePointDetailResponseSchema,
  servicePointSearchResponseSchema,
  shipmentListResponseSchema,
  shipmentResponseSchema,
  shippingOptionsResponseSchema,
  trackingResponseSchema,
} from "./sendcloud.schemas";
import {
  type AnnounceShipmentInput,
  type AnnounceShipmentResult,
  type CancelShipmentResult,
  type SendcloudErrorDetail,
  type SendcloudOpeningShift,
  type SendcloudOpeningTimes,
  type SendcloudPort,
  type SendcloudServicePoint,
  type SendcloudShipment,
  type SendcloudShippingOption,
  type SendcloudTracking,
  type ServicePointSearchParams,
  type ServicePointSearchResult,
  type ShippingOptionsQuery,
  type Weekday,
} from "./sendcloud.port";

/**
 * The ONLY code that speaks HTTP to Sendcloud (spec §3.5).
 *
 *  - `fetch`-based, HTTP Basic (public key : secret key), v3 base only (v2 is
 *    closed to accounts created after 2026-04 — spec §1 S1).
 *  - Every response is zod-parsed and mapped to the narrow types in
 *    `sendcloud.port.ts`; nothing Sendcloud sends reaches a caller unparsed.
 *  - Non-2xx → `SendcloudError{status, code, detail}` from the JSON:API body.
 *  - Retries (at most `maxRetries`, default 3) with jittered exponential
 *    backoff on 429 / 502 / 503 / 504 / network failure / our own timeout,
 *    honouring `Retry-After` on a 429. Sendcloud's write budget is 100/min with
 *    a 15/s burst (spec §1 S3) — backing off is the polite answer to a 429, and
 *    the one retrying a write is SAFE for: `announce` is idempotent by
 *    `external_reference_id` (a replay answers 409 with the existing shipment),
 *    `cancel` of an already-cancelling shipment answers 409 "rejected".
 *  - A per-attempt timeout (default 10 s) via AbortController, so a hung
 *    vendor cannot hold a checkout request or an outbox worker indefinitely.
 */

export interface SendcloudClientConfig {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly baseUrl: string;
  /** Per ATTEMPT, not per call. Default 10 000 ms. */
  readonly timeoutMs?: number | undefined;
  /** Retries after the first attempt. Default 3. */
  readonly maxRetries?: number | undefined;
}

export interface SendcloudClientDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Injected for tests so a retry test does not actually wait. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Injected for tests so jitter is deterministic. [0, 1). */
  readonly random?: (() => number) | undefined;
  readonly logger?: Pick<Logger, "warn"> | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 4_000;
/** A `Retry-After` longer than this is not waited out inline; the caller's own retry (outbox) is. */
const RETRY_AFTER_CAP_MS = 10_000;
/** Vendor prose is for our logs; cap it so a whole HTML error page cannot ride along. */
const DETAIL_MAX_LENGTH = 500;

type HttpMethod = "GET" | "POST";

interface RequestSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: ReadonlyArray<readonly [string, string]> | undefined;
  readonly body?: unknown;
  /** Defaults to application/json. */
  readonly accept?: string | undefined;
}

interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class SendcloudClient implements SendcloudPort {
  readonly isConfigured = true;

  private readonly authorization: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: Pick<Logger, "warn"> | undefined;

  constructor(config: SendcloudClientConfig, deps: SendcloudClientDeps = {}) {
    this.authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? realSleep;
    this.random = deps.random ?? Math.random;
    this.logger = deps.logger;
  }

  // -------------------------------------------------------------------------
  // Service points (spec §1 S7, S8)
  // -------------------------------------------------------------------------

  async searchServicePoints(params: ServicePointSearchParams): Promise<ServicePointSearchResult> {
    const query: Array<readonly [string, string]> = [["country_code", params.countryCode]];
    // `carrier_code` is a form/explode array: one `carrier_code=` per value.
    for (const carrier of params.carrierCodes) {
      query.push(["carrier_code", carrier]);
    }
    query.push(["address_postal_code", params.postalCode]);
    if (params.city !== undefined && params.city !== "") {
      query.push(["address_city", params.city]);
    }
    if (params.radiusMeters !== undefined) {
      query.push(["radius", String(params.radiusMeters)]);
    }
    if (params.limit !== undefined) {
      query.push(["limit", String(params.limit)]);
    }

    const body = await this.requestJson(
      { method: "GET", path: "/service-points", query },
      servicePointSearchResponseSchema,
    );

    return {
      geocodingStatus: body.data.geocoding?.status ?? null,
      points: body.data.results.map(toServicePoint),
    };
  }

  async getServicePoint(id: string): Promise<SendcloudServicePoint> {
    const body = await this.requestJson(
      { method: "GET", path: `/service-points/${encodeURIComponent(id)}` },
      servicePointDetailResponseSchema,
    );
    return toServicePoint(body.data);
  }

  async checkServicePointAvailability(id: string): Promise<boolean> {
    const body = await this.requestJson(
      {
        method: "POST",
        path: `/service-points/${encodeURIComponent(id)}/check-availability`,
        body: {},
      },
      servicePointAvailabilityResponseSchema,
    );
    return body.data.is_available;
  }

  // -------------------------------------------------------------------------
  // Shipping options (spec §1 S6) — the admin rate editor's picker
  // -------------------------------------------------------------------------

  async listShippingOptions(query: ShippingOptionsQuery): Promise<readonly SendcloudShippingOption[]> {
    const body = await this.requestJson(
      {
        method: "POST",
        path: "/shipping-options",
        body: {
          from_address: { country_code: query.fromCountryCode },
          to_address: { country_code: query.toCountryCode },
          parcels: [{ weight: { value: gramsToKg(query.weightGrams), unit: "kg" } }],
          calculate_quotes: true,
        },
      },
      shippingOptionsResponseSchema,
    );

    return (body.data ?? []).map((option) => {
      const total = option.quotes?.[0]?.price?.total ?? null;
      return {
        code: option.code,
        name: option.name,
        carrierCode: option.carrier.code,
        carrierName: option.carrier.name,
        lastMile: option.functionalities?.last_mile ?? null,
        requiresServicePoint: option.requirements?.is_service_point_required ?? false,
        requiredFields: option.requirements?.fields ?? [],
        quoteTotal: total === null ? null : { value: total.value, currency: total.currency },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Shipments (spec §1 S9, S10, S12)
  // -------------------------------------------------------------------------

  /**
   * `POST /shipments/announce` — synchronous; the label comes back inline.
   *
   * THREE success shapes, all returning a shipment object:
   *  - 200/201 with an empty `errors[]` — announced.
   *  - 200/201 WITH `errors[]` and a parcel in `ANNOUNCEMENT_FAILED` — Sendcloud
   *    accepted the request and the carrier refused it (spec §1 S9). NOT thrown:
   *    the caller must record a FAILED shipment with the detail, and a failed
   *    announcement is not billed.
   *  - 409 — `external_reference_id` already used; the body is the EXISTING
   *    shipment (spike §11a G3). Returned with `reused: true`, so a retried job
   *    never buys a second label.
   */
  async announceShipment(input: AnnounceShipmentInput): Promise<AnnounceShipmentResult> {
    const recipient = input.recipient;
    const body: Record<string, unknown> = {
      from_address: { sender_address_id: input.senderAddressId },
      to_address: {
        name: recipient.name,
        company_name: recipient.companyName ?? "",
        address_line_1: recipient.addressLine1,
        house_number: recipient.houseNumber ?? "",
        address_line_2: recipient.addressLine2 ?? "",
        postal_code: recipient.postalCode,
        city: recipient.city,
        country_code: recipient.countryCode,
        email: recipient.email,
        phone_number: recipient.phoneNumber ?? "",
      },
      ship_with: {
        type: "shipping_option_code",
        properties: { shipping_option_code: input.shippingOptionCode },
      },
      parcels: [{ weight: { value: String(input.weightGrams), unit: "g" } }],
      order_number: input.orderNumber,
      external_reference_id: input.externalReferenceId,
      label_details: { mime_type: "application/pdf", dpi: 72 },
    };
    if (input.servicePointId !== null) {
      // A STRING here, although the search API returns an integer (spec §1 S10).
      body["to_service_point"] = { id: input.servicePointId };
    }
    if (input.totalOrderPrice !== undefined) {
      body["total_order_price"] = {
        value: input.totalOrderPrice.value,
        currency: input.totalOrderPrice.currency,
      };
    }

    const raw = await this.send({ method: "POST", path: "/shipments/announce", body });
    const reused = raw.status === 409;
    if (!isSuccess(raw.status) && !reused) {
      throw this.errorFrom(raw);
    }
    const parsed = this.parse(raw, shipmentResponseSchema);
    return { shipment: toShipment(parsed.data), reused };
  }

  async getShipment(id: string): Promise<SendcloudShipment> {
    const body = await this.requestJson(
      { method: "GET", path: `/shipments/${encodeURIComponent(id)}` },
      shipmentResponseSchema,
    );
    return toShipment(body.data);
  }

  /**
   * `GET /shipments?external_reference_id=` — how the label job recovers a
   * shipment it created but did not get to record (a crash between the
   * announce and our commit). A 404 and an empty list both mean "none".
   */
  async findShipmentByExternalReference(
    externalReferenceId: string,
  ): Promise<SendcloudShipment | null> {
    const raw = await this.send({
      method: "GET",
      path: "/shipments",
      query: [["external_reference_id", externalReferenceId]],
    });
    if (raw.status === 404) {
      return null;
    }
    if (!isSuccess(raw.status)) {
      throw this.errorFrom(raw);
    }
    const body = this.parse(raw, shipmentListResponseSchema);
    const match = (body.data ?? []).find(
      (shipment) => shipment.external_reference_id === externalReferenceId,
    );
    return match === undefined ? null : toShipment(match);
  }

  /** 200 cancelled · 202 queued · 409 rejected (returned, not thrown) · anything else throws. */
  async cancelShipment(id: string): Promise<CancelShipmentResult> {
    const raw = await this.send({
      method: "POST",
      path: `/shipments/${encodeURIComponent(id)}/cancel`,
      body: {},
    });

    if (raw.status === 409) {
      const detail = this.errorFrom(raw).detail;
      return { status: "rejected", detail };
    }
    if (raw.status !== 200 && raw.status !== 202) {
      throw this.errorFrom(raw);
    }
    // The status code is the contract; the body's `status` word is a courtesy.
    this.parse(raw, cancelShipmentResponseSchema);
    return { status: raw.status === 200 ? "cancelled" : "queued" };
  }

  // -------------------------------------------------------------------------
  // Documents and tracking (spec §1 S11, S14)
  // -------------------------------------------------------------------------

  async downloadLabel(parcelId: number, paperSize: "A4" | "A5" | "A6" = "A6"): Promise<Uint8Array> {
    const raw = await this.send({
      method: "GET",
      path: `/parcels/${parcelId}/documents/label`,
      query: [["paper_size", paperSize]],
      accept: "application/pdf",
    });
    if (!isSuccess(raw.status)) {
      throw this.errorFrom(raw);
    }
    // A label we cannot print is worse than an error: it would be stored and
    // merged into a batch that fails at the printer. Check the bytes, not only
    // the header — "%PDF" is the file's own signature.
    if (!raw.contentType.includes("application/pdf") || !startsWithPdfSignature(raw.bytes)) {
      throw new SendcloudError(raw.status, "malformed_response", "Label download was not a PDF.");
    }
    return raw.bytes;
  }

  async getTracking(trackingNumber: string): Promise<SendcloudTracking> {
    const body = await this.requestJson(
      { method: "GET", path: `/parcels/tracking/${encodeURIComponent(trackingNumber)}` },
      trackingResponseSchema,
    );
    return {
      expectedDeliveryDate: body.details?.expected_delivery_date ?? null,
      events: (body.events ?? []).map((event) => ({
        at: event.event_at ?? null,
        statusCode: event.status_code ?? null,
        message: event.message ?? null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async requestJson<Output>(
    spec: RequestSpec,
    schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  ): Promise<Output> {
    const raw = await this.send(spec);
    if (!isSuccess(raw.status)) {
      throw this.errorFrom(raw);
    }
    return this.parse(raw, schema);
  }

  /**
   * One logical request: up to `maxRetries + 1` attempts. Returns the FINAL
   * response whatever its status (the caller decides what a 404 or a 409
   * means); throws only when no response was obtained at all.
   */
  private async send(spec: RequestSpec): Promise<RawResponse> {
    const url = this.urlFor(spec);
    let attempt = 0;

    for (;;) {
      let outcome: RawResponse | SendcloudError;
      let retryAfterMs: number | null = null;
      try {
        const response = await this.attempt(url, spec);
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        outcome = {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (error: unknown) {
        outcome = transportError(error);
      }

      const status = outcome.status;
      if (!isRetryableStatus(status) || attempt >= this.maxRetries) {
        if (outcome instanceof SendcloudError) {
          throw outcome;
        }
        return outcome;
      }

      const delay = retryAfterMs ?? this.backoff(attempt);
      this.logger?.warn(
        { vendor: "sendcloud", method: spec.method, path: spec.path, status, attempt, delayMs: delay },
        "Sendcloud request failed transiently; retrying",
      );
      await this.sleep(delay);
      attempt += 1;
    }
  }

  private async attempt(url: string, spec: RequestSpec): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: this.authorization,
        Accept: spec.accept ?? "application/json",
      };
      const init: RequestInit = { method: spec.method, headers, signal: controller.signal };
      if (spec.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(spec.body);
      }
      return await this.fetchImpl(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Full jitter: uniform in [0, min(cap, base · 2^attempt)). */
  private backoff(attempt: number): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.floor(this.random() * ceiling);
  }

  private urlFor(spec: RequestSpec): string {
    const url = new URL(`${this.baseUrl}${spec.path}`);
    for (const [key, value] of spec.query ?? []) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  }

  /**
   * Typed on the schema's OUTPUT rather than as `Schema extends ZodTypeAny`:
   * the latter's `safeParse` result is `any`-typed, which is exactly the
   * unchecked value this adapter exists to keep out.
   */
  private parse<Output>(raw: RawResponse, schema: z.ZodType<Output, z.ZodTypeDef, unknown>): Output {
    const json = parseJson(raw.bytes);
    const result = json.ok ? schema.safeParse(json.value) : null;
    if (result === null || !result.success) {
      this.logger?.warn(
        {
          vendor: "sendcloud",
          status: raw.status,
          issues: result === null ? "not JSON" : result.error.issues.slice(0, 5),
        },
        "Sendcloud answered a shape we cannot read",
      );
      throw new SendcloudError(raw.status, "malformed_response", "Sendcloud response did not match the expected shape.");
    }
    return result.data;
  }

  /** A non-2xx response → the first JSON:API error in its body, or a generic one. */
  private errorFrom(raw: RawResponse): SendcloudError {
    const json = parseJson(raw.bytes);
    const body = json.ok ? sendcloudErrorBodySchema.safeParse(json.value) : null;
    const first = body?.success === true ? body.data.errors[0] : undefined;
    if (first === undefined) {
      return new SendcloudError(raw.status, "unknown", `HTTP ${raw.status}`);
    }
    return new SendcloudError(
      raw.status,
      first.code ?? "unknown",
      truncate(first.detail ?? first.title ?? `HTTP ${raw.status}`),
    );
  }
}

// ---------------------------------------------------------------------------
// Wire → port mapping
// ---------------------------------------------------------------------------

function toOpeningTimes(wire: SendcloudServicePointWire["opening_times"]): SendcloudOpeningTimes {
  const day = (name: Weekday): readonly SendcloudOpeningShift[] | null => {
    const shifts = wire?.[name] ?? null;
    return shifts === null
      ? null
      : shifts.map((shift) => ({ start: shift.start_time, end: shift.end_time }));
  };
  // Spelled out rather than built with Object.fromEntries, whose result would
  // have to be CAST back to a Record — a static type asserted, not earned.
  return {
    monday: day("monday"),
    tuesday: day("tuesday"),
    wednesday: day("wednesday"),
    thursday: day("thursday"),
    friday: day("friday"),
    saturday: day("saturday"),
    sunday: day("sunday"),
  };
}

function toServicePoint(wire: SendcloudServicePointWire): SendcloudServicePoint {
  const openingTimes = toOpeningTimes(wire.opening_times);

  return {
    id: wire.id,
    name: wire.name,
    carrierCode: wire.carrier.code,
    carrierServicePointId: wire.carrier_service_point_id ?? null,
    shopType: wire.general_shop_type ?? null,
    street: wire.address.street ?? "",
    houseNumber: wire.address.house_number ?? "",
    postalCode: wire.address.postal_code ?? "",
    city: wire.address.city ?? "",
    countryCode: wire.address.country_code,
    distanceMeters: wire.distance === null || wire.distance === undefined ? null : Math.round(wire.distance),
    isExpired: wire.is_expired ?? false,
    openingTimes,
  };
}

function toErrorDetail(wire: z.infer<typeof sendcloudErrorObjectSchema>): SendcloudErrorDetail {
  const status = wire.status === null || wire.status === undefined ? null : Number(wire.status);
  return {
    status: status !== null && Number.isInteger(status) ? status : null,
    code: wire.code ?? "unknown",
    detail: truncate(wire.detail ?? wire.title ?? ""),
    pointer: wire.source?.pointer ?? null,
  };
}

function toShipment(wire: SendcloudShipmentWire): SendcloudShipment {
  return {
    id: wire.id,
    externalReferenceId: wire.external_reference_id ?? null,
    orderNumber: wire.order_number ?? null,
    carrierCode: wire.carrier?.code ?? null,
    carrierName: wire.carrier?.name ?? null,
    shippingOptionCode: wire.ship_with?.properties?.shipping_option_code ?? null,
    parcels: (wire.parcels ?? []).map((parcel) => ({
      id: parcel.id,
      statusCode: parcel.status?.code ?? null,
      statusMessage: parcel.status?.message ?? null,
      trackingNumber: emptyToNull(parcel.tracking_number),
      trackingUrl: emptyToNull(parcel.tracking_url),
      labelPdf: decodeLabel(parcel.label_file),
    })),
    errors: (wire.errors ?? []).map(toErrorDetail),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}

function decodeLabel(base64: string | null | undefined): Uint8Array | null {
  if (base64 === null || base64 === undefined || base64 === "") {
    return null;
  }
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** `%PDF` — the first four bytes of every PDF file. */
function startsWithPdfSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** Grams → Sendcloud's kg decimal string ("0.500"), with integer arithmetic only. */
export function gramsToKg(grams: number): string {
  const whole = Math.floor(grams / 1000);
  const fraction = String(grams % 1000).padStart(3, "0");
  return `${whole}.${fraction}`;
}

function truncate(text: string): string {
  return text.length > DETAIL_MAX_LENGTH ? `${text.slice(0, DETAIL_MAX_LENGTH)}…` : text;
}

/** JSON.parse over a vendor body, without letting its `any` return escape. */
function parseJson(bytes: Uint8Array): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/** `Retry-After` in seconds (the only form Sendcloud documents), capped. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

function transportError(error: unknown): SendcloudError {
  if (error instanceof Error && error.name === "AbortError") {
    return new SendcloudError(0, "timeout", "Sendcloud did not answer in time.");
  }
  return new SendcloudError(
    0,
    "network_error",
    truncate(error instanceof Error ? error.message : "Network failure"),
  );
}
