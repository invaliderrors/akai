import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { SendcloudClient, gramsToKg } from "./sendcloud.client";
import { SendcloudError } from "./sendcloud.errors";
import type { AnnounceShipmentInput } from "./sendcloud.port";

/**
 * The client against the fixtures captured from the REAL account (spec §11a),
 * with `fetch` stubbed at the client's own injection seam. Every test asserts
 * either what goes on the wire or how a real Sendcloud body is narrowed.
 */

const FIXTURES = path.resolve(__dirname, "../__fixtures__");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

const BASE_URL = "https://panel.sendcloud.sc/api/v3";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Reply =
  | { readonly status: number; readonly body?: string | Uint8Array; readonly headers?: Record<string, string> }
  | { readonly throws: Error };

/** A scripted `fetch`: answers replies in order, records every request. */
function scriptedFetch(replies: Reply[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];

  const fake: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders !== undefined && !(rawHeaders instanceof Headers) && !Array.isArray(rawHeaders)) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = typeof value === "string" ? value : value.join(", ");
      }
    }
    const rawBody = init?.body;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined,
    });

    const reply = queue.shift();
    if (reply === undefined) {
      return Promise.reject(new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`));
    }
    if ("throws" in reply) {
      return Promise.reject(reply.throws);
    }
    return Promise.resolve(
      new Response(reply.body ?? "", {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      }),
    );
  };

  return { fetch: fake, requests };
}

function clientWith(replies: Reply[], options: { maxRetries?: number } = {}) {
  const scripted = scriptedFetch(replies);
  const sleeps: number[] = [];
  const client = new SendcloudClient(
    { publicKey: "pub", secretKey: "sec", baseUrl: BASE_URL, maxRetries: options.maxRetries },
    {
      fetch: scripted.fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    },
  );
  return { client, requests: scripted.requests, sleeps };
}

function jsonApiError(status: number, code: string, detail: string): string {
  return JSON.stringify({ errors: [{ status: String(status), code, detail }] });
}

const ANNOUNCE_INPUT: AnnounceShipmentInput = {
  externalReferenceId: "bbbbbbbb-0000-4000-8000-000000000001",
  orderNumber: "AK-2026-000123",
  senderAddressId: 920582,
  recipient: {
    name: "Ana García",
    companyName: null,
    addressLine1: "Calle Mayor",
    houseNumber: "1",
    addressLine2: null,
    postalCode: "50002",
    city: "Zaragoza",
    countryCode: "ES",
    email: "ana@example.com",
    phoneNumber: "+34600000000",
  },
  servicePointId: "12188365",
  shippingOptionCode: "inpost_es:service_point,national_c2c",
  weightGrams: 120,
};

describe("SendcloudClient — transport", () => {
  it("authenticates with HTTP Basic public:secret against the v3 base", async () => {
    const { client, requests } = clientWith([
      { status: 200, body: fixture("service-points.es-inpost-50002.json") },
    ]);

    await client.searchServicePoints({
      countryCode: "ES",
      carrierCodes: ["inpost_es"],
      postalCode: "50002",
    });

    expect(requests[0]?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("pub:sec").toString("base64")}`,
    );
    expect(requests[0]?.url.href.split("?")[0]).toBe(`${BASE_URL}/service-points`);
  });

  it("maps a JSON:API error body to a typed SendcloudError", async () => {
    const { client } = clientWith([
      { status: 404, body: jsonApiError(404, "not_found", "The service point could not be found") },
    ]);

    const error = await client.getServicePoint("1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SendcloudError);
    expect(error).toMatchObject({
      status: 404,
      code: "not_found",
      detail: "The service point could not be found",
    });
  });

  it("retries a 429 and a 503 with jittered backoff, then succeeds", async () => {
    const { client, requests, sleeps } = clientWith([
      { status: 429, body: jsonApiError(429, "throttled", "slow down") },
      { status: 503, body: "" },
      { status: 200, body: JSON.stringify({ data: { is_available: true } }) },
    ]);

    await expect(client.checkServicePointAvailability("12188365")).resolves.toBe(true);
    expect(requests).toHaveLength(3);
    // random() = 0.5 → half of 250·2^n.
    expect(sleeps).toEqual([125, 250]);
  });

  it("honours Retry-After on a 429", async () => {
    const { client, sleeps } = clientWith([
      { status: 429, body: "", headers: { "retry-after": "2" } },
      { status: 200, body: JSON.stringify({ data: { is_available: false } }) },
    ]);

    await expect(client.checkServicePointAvailability("1")).resolves.toBe(false);
    expect(sleeps).toEqual([2000]);
  });

  it("retries a network failure", async () => {
    const { client, requests } = clientWith([
      { throws: new TypeError("fetch failed") },
      { status: 200, body: JSON.stringify({ data: { is_available: true } }) },
    ]);

    await expect(client.checkServicePointAvailability("1")).resolves.toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("gives up after at most 3 retries and surfaces the last status", async () => {
    const { client, requests } = clientWith([
      { status: 503, body: "" },
      { status: 503, body: "" },
      { status: 503, body: "" },
      { status: 503, body: jsonApiError(503, "unavailable", "geocoder down") },
    ]);

    const error = await client
      .searchServicePoints({ countryCode: "ES", carrierCodes: ["ups"], postalCode: "50002" })
      .catch((caught: unknown) => caught);

    expect(requests).toHaveLength(4);
    expect(error).toMatchObject({ status: 503, code: "unavailable", retryable: true });
  });

  it("does NOT retry a 4xx other than 429", async () => {
    const { client, requests } = clientWith([
      { status: 400, body: jsonApiError(400, "invalid", "bad") },
    ]);

    await expect(client.getShipment("x")).rejects.toMatchObject({ status: 400, code: "invalid" });
    expect(requests).toHaveLength(1);
  });

  it("reports a timeout as a retryable status-0 error", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const { client } = clientWith([{ throws: abort }], { maxRetries: 0 });

    await expect(client.getShipment("x")).rejects.toMatchObject({ status: 0, code: "timeout" });
  });

  it("refuses a 200 whose body does not match what we read", async () => {
    const { client } = clientWith([{ status: 200, body: JSON.stringify({ data: { nope: 1 } }) }]);

    await expect(client.checkServicePointAvailability("1")).rejects.toMatchObject({
      code: "malformed_response",
    });
  });
});

describe("SendcloudClient — service points", () => {
  it("sends carrier_code as a repeated param and narrows the real InPost response", async () => {
    const { client, requests } = clientWith([
      { status: 200, body: fixture("service-points.es-inpost-50002.json") },
    ]);

    const result = await client.searchServicePoints({
      countryCode: "ES",
      carrierCodes: ["inpost_es", "ups"],
      postalCode: "50002",
      city: "Zaragoza",
      radiusMeters: 10_000,
      limit: 20,
    });

    const query = requests[0]?.url.searchParams;
    expect(query?.getAll("carrier_code")).toEqual(["inpost_es", "ups"]);
    expect(query?.get("country_code")).toBe("ES");
    expect(query?.get("address_postal_code")).toBe("50002");
    expect(query?.get("address_city")).toBe("Zaragoza");
    expect(query?.get("radius")).toBe("10000");
    expect(query?.get("limit")).toBe("20");

    expect(result.geocodingStatus).toBe("matched");
    expect(result.points).toHaveLength(3);
    const pili = result.points[0];
    expect(pili).toMatchObject({
      id: 12188365,
      name: "PAPELERIA PILI",
      carrierCode: "inpost_es",
      carrierServicePointId: "ES21366",
      shopType: "servicepoint",
      street: "CALLE DE LA BATALLA DE LEPANTO",
      houseNumber: "",
      postalCode: "50002",
      city: "ZARAGOZA",
      countryCode: "ES",
      distanceMeters: 1089,
      isExpired: false,
    });
    // Several shifts a day, and a closed Sunday (spec §11a G2).
    expect(pili?.openingTimes.monday).toEqual([
      { start: "08:00", end: "14:00" },
      { start: "17:00", end: "20:30" },
    ]);
    expect(pili?.openingTimes.sunday).toBeNull();
    // `general_shop_type` tells a locker from a staffed point.
    expect(result.points.map((point) => point.shopType)).toContain("locker");
  });

  it("narrows the real UPS response", async () => {
    const { client } = clientWith([{ status: 200, body: fixture("service-points.es-ups-50002.json") }]);

    const result = await client.searchServicePoints({
      countryCode: "ES",
      carrierCodes: ["ups"],
      postalCode: "50002",
    });

    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points.every((point) => point.carrierCode === "ups")).toBe(true);
  });

  it("reports an ungeocodable address with no points", async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: JSON.stringify({ data: { results: [], geocoding: { status: "not_found" } } }),
      },
    ]);

    const result = await client.searchServicePoints({
      countryCode: "ES",
      carrierCodes: ["ups"],
      postalCode: "00000",
    });
    expect(result).toEqual({ geocodingStatus: "not_found", points: [] });
  });

  it("reads one point by id, and its availability with a POST", async () => {
    const detail = JSON.parse(fixture("service-points.es-inpost-50002.json")) as {
      data: { results: unknown[] };
    };
    const { client, requests } = clientWith([
      { status: 200, body: JSON.stringify({ data: detail.data.results[0] }) },
      { status: 200, body: JSON.stringify({ data: { is_available: true } }) },
    ]);

    const point = await client.getServicePoint("12188365");
    const available = await client.checkServicePointAvailability("12188365");

    expect(point.id).toBe(12188365);
    expect(available).toBe(true);
    expect(requests[0]?.url.pathname).toBe("/api/v3/service-points/12188365");
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url.pathname).toBe("/api/v3/service-points/12188365/check-availability");
  });
});

describe("SendcloudClient — shipping options", () => {
  it("asks for ES → destination at the given weight and narrows the real response", async () => {
    const { client, requests } = clientWith([
      { status: 200, body: fixture("shipping-options.es-es.json") },
    ]);

    const options = await client.listShippingOptions({
      fromCountryCode: "ES",
      toCountryCode: "ES",
      weightGrams: 500,
    });

    expect(requests[0]?.body).toMatchObject({
      from_address: { country_code: "ES" },
      to_address: { country_code: "ES" },
      parcels: [{ weight: { value: "0.500", unit: "kg" } }],
    });

    const inpost = options.find((option) => option.code === "inpost_es:service_point,national_c2c");
    expect(inpost).toMatchObject({
      carrierCode: "inpost_es",
      lastMile: "service_point",
      requiredFields: ["to_email"],
    });
    const letter = options.find((option) => option.code === "sendcloud:letter");
    expect(letter?.quoteTotal).toEqual({ value: "0", currency: "EUR" });
  });

  it("parses the IE response, where InPost is absent", async () => {
    const { client } = clientWith([{ status: 200, body: fixture("shipping-options.es-ie.json") }]);

    const options = await client.listShippingOptions({
      fromCountryCode: "ES",
      toCountryCode: "IE",
      weightGrams: 500,
    });

    expect(options.some((option) => option.carrierCode === "inpost_es")).toBe(false);
    expect(options.some((option) => option.code === "ups:standard/service_point")).toBe(true);
  });
});

describe("SendcloudClient — shipments", () => {
  let letter: string;

  beforeEach(() => {
    letter = fixture("shipment-announce.letter.json");
  });

  it("announces with our order id as external_reference_id and the point id as a STRING", async () => {
    const { client, requests } = clientWith([{ status: 200, body: letter }]);

    await client.announceShipment(ANNOUNCE_INPUT);

    expect(requests[0]?.url.pathname).toBe("/api/v3/shipments/announce");
    expect(requests[0]?.body).toEqual({
      from_address: { sender_address_id: 920582 },
      to_address: {
        name: "Ana García",
        company_name: "",
        address_line_1: "Calle Mayor",
        house_number: "1",
        address_line_2: "",
        postal_code: "50002",
        city: "Zaragoza",
        country_code: "ES",
        email: "ana@example.com",
        phone_number: "+34600000000",
      },
      to_service_point: { id: "12188365" },
      ship_with: {
        type: "shipping_option_code",
        properties: { shipping_option_code: "inpost_es:service_point,national_c2c" },
      },
      parcels: [{ weight: { value: "120", unit: "g" } }],
      order_number: "AK-2026-000123",
      external_reference_id: "bbbbbbbb-0000-4000-8000-000000000001",
      label_details: { mime_type: "application/pdf", dpi: 72 },
    });
  });

  it("omits to_service_point for a home delivery", async () => {
    const { client, requests } = clientWith([{ status: 200, body: letter }]);

    await client.announceShipment({ ...ANNOUNCE_INPUT, servicePointId: null });

    expect(requests[0]?.body).not.toHaveProperty("to_service_point");
  });

  it("narrows the real letter announce: parcel id, status, tracking, inline label", async () => {
    const { client } = clientWith([{ status: 200, body: letter }]);

    const { shipment, reused } = await client.announceShipment(ANNOUNCE_INPUT);

    expect(reused).toBe(false);
    expect(shipment).toMatchObject({
      id: "95524bc9-174f-47c8-a03a-e60b83a24fe1",
      externalReferenceId: "spike-2026-09-24-1",
      carrierCode: "sendcloud",
      shippingOptionCode: "sendcloud:letter",
      errors: [],
    });
    const parcel = shipment.parcels[0];
    expect(parcel).toMatchObject({
      id: 718530367,
      statusCode: "READY_TO_SEND",
      trackingNumber: "SCCWF3P9K4PJ",
    });
    expect(parcel?.trackingUrl).toMatch(/^https:\/\/tracking\./);
    // The fixture's label bytes are truncated to the PDF header ("%PDF-1.4\n").
    expect(Buffer.from(parcel?.labelPdf ?? new Uint8Array()).toString("latin1")).toBe("%PDF-1.4\n");
  });

  it("treats a 409 as the EXISTING shipment — a retried job never buys twice", async () => {
    const { client } = clientWith([{ status: 409, body: letter }]);

    const { shipment, reused } = await client.announceShipment(ANNOUNCE_INPUT);

    expect(reused).toBe(true);
    expect(shipment.id).toBe("95524bc9-174f-47c8-a03a-e60b83a24fe1");
  });

  it("returns (does not throw) a 200 whose announcement FAILED, with the vendor detail", async () => {
    const failed = JSON.parse(letter) as {
      data: { errors: unknown[]; parcels: Array<Record<string, unknown>> };
    };
    failed.data.errors = [
      {
        status: "500",
        code: "parcel_announcement_error",
        detail: "Service error: An error occurred while connecting to the carrier.",
      },
    ];
    const firstParcel = failed.data.parcels[0];
    if (firstParcel === undefined) throw new Error("fixture has no parcel");
    firstParcel["status"] = { code: "ANNOUNCEMENT_FAILED", message: "Announcement Failed" };
    firstParcel["label_file"] = null;

    const { client } = clientWith([{ status: 200, body: JSON.stringify(failed) }]);
    const { shipment } = await client.announceShipment(ANNOUNCE_INPUT);

    expect(shipment.errors).toEqual([
      {
        status: 500,
        code: "parcel_announcement_error",
        detail: "Service error: An error occurred while connecting to the carrier.",
        pointer: null,
      },
    ]);
    expect(shipment.parcels[0]?.statusCode).toBe("ANNOUNCEMENT_FAILED");
    expect(shipment.parcels[0]?.labelPdf).toBeNull();
  });

  it("throws a 400 validation failure with its detail", async () => {
    const { client } = clientWith([
      {
        status: 400,
        body: JSON.stringify({
          errors: [
            {
              detail: "This field is required.",
              status: "400",
              source: { pointer: "/to_address/name" },
              code: "required",
            },
          ],
        }),
      },
    ]);

    await expect(client.announceShipment(ANNOUNCE_INPUT)).rejects.toMatchObject({
      status: 400,
      code: "required",
      detail: "This field is required.",
    });
  });

  it("gets a shipment by id", async () => {
    const { client, requests } = clientWith([{ status: 200, body: letter }]);

    const shipment = await client.getShipment("95524bc9-174f-47c8-a03a-e60b83a24fe1");

    expect(requests[0]?.url.pathname).toBe("/api/v3/shipments/95524bc9-174f-47c8-a03a-e60b83a24fe1");
    expect(shipment.parcels[0]?.id).toBe(718530367);
  });

  it("finds a shipment by external_reference_id, or null", async () => {
    const one = JSON.parse(letter) as { data: unknown };
    const { client, requests } = clientWith([
      { status: 200, body: JSON.stringify({ data: [one.data] }) },
      { status: 200, body: JSON.stringify({ data: [] }) },
      { status: 404, body: jsonApiError(404, "not_found", "Not found") },
    ]);

    const found = await client.findShipmentByExternalReference("spike-2026-09-24-1");
    const none = await client.findShipmentByExternalReference("other");
    const missing = await client.findShipmentByExternalReference("gone");

    expect(requests[0]?.url.searchParams.get("external_reference_id")).toBe("spike-2026-09-24-1");
    expect(found?.id).toBe("95524bc9-174f-47c8-a03a-e60b83a24fe1");
    expect(none).toBeNull();
    expect(missing).toBeNull();
  });

  it("maps cancel 200 → cancelled, 202 → queued, 409 → rejected with the detail", async () => {
    const { client, requests } = clientWith([
      { status: 200, body: JSON.stringify({ data: { status: "cancelled", message: "ok" } }) },
      { status: 202, body: JSON.stringify({ data: { status: "queued", message: "queued" } }) },
      { status: 409, body: jsonApiError(409, "invalid", "This shipment is already being cancelled.") },
    ]);

    await expect(client.cancelShipment("s1")).resolves.toEqual({ status: "cancelled" });
    await expect(client.cancelShipment("s1")).resolves.toEqual({ status: "queued" });
    await expect(client.cancelShipment("s1")).resolves.toEqual({
      status: "rejected",
      detail: "This shipment is already being cancelled.",
    });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.pathname).toBe("/api/v3/shipments/s1/cancel");
  });

  it("throws on a cancel 404", async () => {
    const { client } = clientWith([{ status: 404, body: jsonApiError(404, "not_found", "Not found") }]);
    await expect(client.cancelShipment("nope")).rejects.toMatchObject({ status: 404, isNotFound: true });
  });
});

describe("SendcloudClient — documents and tracking", () => {
  it("downloads a label as PDF bytes, A6 by default", async () => {
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF", "latin1"));
    const { client, requests } = clientWith([
      { status: 200, body: pdf, headers: { "content-type": "application/pdf" } },
    ]);

    const bytes = await client.downloadLabel(718530367);

    expect(requests[0]?.url.pathname).toBe("/api/v3/parcels/718530367/documents/label");
    expect(requests[0]?.url.searchParams.get("paper_size")).toBe("A6");
    expect(requests[0]?.headers["accept"]).toBe("application/pdf");
    expect(Buffer.from(bytes).toString("latin1")).toBe("%PDF-1.4\n%%EOF");
  });

  it("refuses a 'label' that is not a PDF", async () => {
    const { client } = clientWith([
      { status: 200, body: "<html>login</html>", headers: { "content-type": "text/html" } },
    ]);
    await expect(client.downloadLabel(1)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("reads tracking events, wrapped in data or not", async () => {
    const body = {
      details: { expected_delivery_date: "2026-09-27" },
      events: [{ event_at: "2026-09-25T08:00:00Z", status_code: "accepted" }],
    };
    const { client } = clientWith([
      { status: 200, body: JSON.stringify(body) },
      { status: 200, body: JSON.stringify({ data: body }) },
    ]);

    const expected = {
      expectedDeliveryDate: "2026-09-27",
      events: [{ at: "2026-09-25T08:00:00Z", statusCode: "accepted", message: null }],
    };
    await expect(client.getTracking("SCCWF3P9K4PJ")).resolves.toEqual(expected);
    await expect(client.getTracking("SCCWF3P9K4PJ")).resolves.toEqual(expected);
  });
});

describe("gramsToKg", () => {
  it("formats grams as a kg decimal string with integer arithmetic", () => {
    expect(gramsToKg(500)).toBe("0.500");
    expect(gramsToKg(1500)).toBe("1.500");
    expect(gramsToKg(7)).toBe("0.007");
    expect(gramsToKg(30001)).toBe("30.001");
  });
});
