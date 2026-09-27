import "reflect-metadata";
import { readFileSync } from "node:fs";
import path from "node:path";
import { servicePointSearchResponseSchema, type ServicePointSearchRequest } from "@akai/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { FulfilmentError } from "../../fulfilment/fulfilment.errors";
import { NotConfiguredSendcloudClient } from "../../fulfilment/sendcloud/not-configured-sendcloud.client";
import { SendcloudClient } from "../../fulfilment/sendcloud/sendcloud.client";
import { SendcloudError } from "../../fulfilment/sendcloud/sendcloud.errors";
import type {
  SendcloudPort,
  SendcloudServicePoint,
  ServicePointSearchParams,
  ServicePointSearchResult,
} from "../../fulfilment/sendcloud/sendcloud.port";
import { UNMAPPED_FULFILMENT, type RateFulfilment, type ShippingRateRow } from "../shipping-rate.selector";
import type { ShippingRepository, ShippingZoneWithRates } from "../shipping.repository";
import { ShippingError } from "../shipping.errors";
import {
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
  ServicePointsService,
  cacheKey,
  formatServicePointAddress,
} from "./service-points.service";

const FIXTURES = path.resolve(__dirname, "../../fulfilment/__fixtures__");

const PICKUP_RATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOME_RATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNMAPPED_PICKUP_RATE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const INPOST_PICKUP: RateFulfilment = {
  deliveryType: "SERVICE_POINT",
  carrierCode: "inpost_es",
  sendcloudOptionCode: "inpost_es:service_point,national_c2c",
  transitDaysMin: 1,
  transitDaysMax: 2,
};

function rate(id: string, fulfilment: RateFulfilment): ShippingRateRow {
  return {
    id,
    name: { es: "InPost punto de recogida" },
    strategy: "FLAT",
    priceGross: 899,
    currency: "EUR",
    minValue: null,
    maxValue: null,
    freeOverSubtotal: 25_000,
    isActive: true,
    fulfilment,
  };
}

const ES_ZONE: ShippingZoneWithRates = {
  zoneId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  zoneName: "España",
  rates: [
    rate(PICKUP_RATE_ID, INPOST_PICKUP),
    rate(HOME_RATE_ID, UNMAPPED_FULFILMENT),
    rate(UNMAPPED_PICKUP_RATE_ID, { ...INPOST_PICKUP, carrierCode: null }),
  ],
};

class FakeRepository implements ShippingRepository {
  async findZoneForCountry(countryCode: string): Promise<ShippingZoneWithRates | null> {
    return countryCode === "ES" ? ES_ZONE : null;
  }
  async listOfferableRateThresholds(): Promise<[]> {
    return [];
  }
}

/** The real account's InPost search for 50002 Zaragoza, narrowed by the REAL client. */
async function fixtureSearch(): Promise<ServicePointSearchResult> {
  const body = readFileSync(path.join(FIXTURES, "service-points.es-inpost-50002.json"), "utf8");
  const client = new SendcloudClient(
    { publicKey: "pub", secretKey: "sec", baseUrl: "https://panel.sendcloud.sc/api/v3" },
    {
      fetch: () =>
        Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } })),
    },
  );
  return client.searchServicePoints({ countryCode: "ES", carrierCodes: ["inpost_es"], postalCode: "50002" });
}

type SearchReply = ServicePointSearchResult | Error;

/** An in-memory port: scripted search replies, one point per id for the checkout reads. */
class FakeSendcloud implements SendcloudPort {
  isConfigured = true;
  readonly searches: ServicePointSearchParams[] = [];
  readonly searchReplies: SearchReply[] = [];
  readonly points = new Map<string, SendcloudServicePoint | Error>();
  readonly availability = new Map<string, boolean | Error>();
  readonly gets: string[] = [];
  readonly availabilityChecks: string[] = [];

  async searchServicePoints(params: ServicePointSearchParams): Promise<ServicePointSearchResult> {
    this.searches.push(params);
    const reply = this.searchReplies.shift();
    if (reply === undefined) throw new Error("Unscripted search");
    if (reply instanceof Error) throw reply;
    return reply;
  }
  async getServicePoint(id: string): Promise<SendcloudServicePoint> {
    this.gets.push(id);
    const point = this.points.get(id);
    if (point === undefined) throw new SendcloudError(404, "not_found", "No such point");
    if (point instanceof Error) throw point;
    return point;
  }
  async checkServicePointAvailability(id: string): Promise<boolean> {
    this.availabilityChecks.push(id);
    const reply = this.availability.get(id) ?? true;
    if (reply instanceof Error) throw reply;
    return reply;
  }
  listShippingOptions(): never {
    throw new Error("not used");
  }
  announceShipment(): never {
    throw new Error("not used");
  }
  getShipment(): never {
    throw new Error("not used");
  }
  findShipmentByExternalReference(): never {
    throw new Error("not used");
  }
  cancelShipment(): never {
    throw new Error("not used");
  }
  downloadLabel(): never {
    throw new Error("not used");
  }
  getTracking(): never {
    throw new Error("not used");
  }
}

const silentLogger = { warn: (): void => undefined };

function searchRequest(overrides: Partial<ServicePointSearchRequest> = {}): ServicePointSearchRequest {
  return { rateId: PICKUP_RATE_ID, countryCode: "ES", postalCode: "50002", city: null, ...overrides };
}

const EMPTY_MATCHED: ServicePointSearchResult = { geocodingStatus: "matched", points: [] };

describe("ServicePointsService.search", () => {
  let sendcloud: FakeSendcloud;
  let now: number;
  let service: ServicePointsService;
  let fixture: ServicePointSearchResult;

  beforeEach(async () => {
    sendcloud = new FakeSendcloud();
    now = 1_000_000;
    service = new ServicePointsService(new FakeRepository(), sendcloud, silentLogger, () => now);
    fixture = await fixtureSearch();
  });

  it("OK: maps the real fixture to the public contract (string id, shifts as from/to, rounded distance)", async () => {
    sendcloud.searchReplies.push(fixture);

    const response = await service.search(searchRequest());

    expect(servicePointSearchResponseSchema.parse(response)).toEqual(response);
    expect(response.status).toBe("OK");
    expect(response.points.map((point) => point.name)).toEqual([
      "PAPELERIA PILI",
      "ATM ORDENADORES",
      "urbanwash",
    ]);
    const pili = response.points[0];
    expect(pili).toMatchObject({
      id: "12188365",
      shopType: "servicepoint",
      street: "CALLE DE LA BATALLA DE LEPANTO",
      houseNumber: "",
      postalCode: "50002",
      city: "ZARAGOZA",
      countryCode: "ES",
      distanceMeters: 1089,
    });
    expect(pili?.openingHours.monday).toEqual([
      { from: "08:00", to: "14:00" },
      { from: "17:00", to: "20:30" },
    ]);
    expect(pili?.openingHours.saturday).toEqual([{ from: "08:00", to: "14:00" }]);
    expect(pili?.openingHours.sunday).toBeNull();
    expect(response.points[2]?.shopType).toBe("locker");
  });

  it("asks Sendcloud for THE RATE'S carrier only, 10 km, 20 results", async () => {
    sendcloud.searchReplies.push(fixture);

    await service.search(searchRequest({ city: "Zaragoza" }));

    expect(sendcloud.searches).toEqual([
      {
        countryCode: "ES",
        carrierCodes: ["inpost_es"],
        postalCode: "50002",
        city: "Zaragoza",
        limit: 20,
        radiusMeters: 10_000,
      },
    ]);
  });

  it("drops expired points and maps unknown shop types to `other`", async () => {
    const [first, second] = fixture.points;
    if (first === undefined || second === undefined) throw new Error("fixture changed");
    sendcloud.searchReplies.push({
      geocodingStatus: "matched",
      points: [{ ...first, isExpired: true }, { ...second, shopType: "kiosk" }],
    });

    const response = await service.search(searchRequest());

    expect(response.points.map((point) => [point.id, point.shopType])).toEqual([["12186143", "other"]]);
  });

  it("ADDRESS_NOT_FOUND when Sendcloud cannot geocode the postcode — and does not widen", async () => {
    sendcloud.searchReplies.push({ geocodingStatus: "not_found", points: [] });

    await expect(service.search(searchRequest())).resolves.toEqual({
      status: "ADDRESS_NOT_FOUND",
      points: [],
    });
    expect(sendcloud.searches).toHaveLength(1);
  });

  it("widens ONCE to 25 km on an empty matched result, and answers OK when that finds points", async () => {
    sendcloud.searchReplies.push(EMPTY_MATCHED, fixture);

    const response = await service.search(searchRequest());

    expect(response.status).toBe("OK");
    expect(sendcloud.searches.map((search) => search.radiusMeters)).toEqual([10_000, 25_000]);
  });

  it("NONE_NEARBY when the widened search is empty too — never a third call", async () => {
    sendcloud.searchReplies.push(EMPTY_MATCHED, EMPTY_MATCHED);

    await expect(service.search(searchRequest())).resolves.toEqual({ status: "NONE_NEARBY", points: [] });
    expect(sendcloud.searches).toHaveLength(2);
  });

  it("widens when every nearby point is expired (empty AFTER the filter)", async () => {
    const expired = fixture.points.map((point) => ({ ...point, isExpired: true }));
    sendcloud.searchReplies.push({ geocodingStatus: "matched", points: expired }, EMPTY_MATCHED);

    await expect(service.search(searchRequest())).resolves.toMatchObject({ status: "NONE_NEARBY" });
    expect(sendcloud.searches).toHaveLength(2);
  });

  it("does not widen a partially matched geocode", async () => {
    sendcloud.searchReplies.push({ geocodingStatus: "partially_matched", points: [] });

    await expect(service.search(searchRequest())).resolves.toMatchObject({ status: "NONE_NEARBY" });
    expect(sendcloud.searches).toHaveLength(1);
  });

  it("UNAVAILABLE on a Sendcloud 503 (geocoder down), a timeout, or a malformed answer", async () => {
    for (const error of [
      new SendcloudError(503, "service_unavailable", "Geocoder down"),
      new SendcloudError(0, "timeout", "Timed out"),
      new SendcloudError(200, "malformed_response", "Bad body"),
    ]) {
      sendcloud.searchReplies.push(error);
      await expect(service.search(searchRequest({ postalCode: `5000${sendcloud.searches.length}` }))).resolves.toEqual({
        status: "UNAVAILABLE",
        points: [],
      });
    }
  });

  it("UNAVAILABLE when fulfilment is not configured, without calling anyone", async () => {
    service = new ServicePointsService(new FakeRepository(), new NotConfiguredSendcloudClient(), silentLogger, () => now);

    await expect(service.search(searchRequest())).resolves.toEqual({ status: "UNAVAILABLE", points: [] });
  });

  it("UNAVAILABLE for a pickup rate an operator left without a carrier", async () => {
    await expect(service.search(searchRequest({ rateId: UNMAPPED_PICKUP_RATE_ID }))).resolves.toEqual({
      status: "UNAVAILABLE",
      points: [],
    });
    expect(sendcloud.searches).toEqual([]);
  });

  it("refuses a HOME rate with SERVICE_POINT_NOT_ALLOWED", async () => {
    const error = await service.search(searchRequest({ rateId: HOME_RATE_ID })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FulfilmentError);
    expect(error).toMatchObject({ reason: "SERVICE_POINT_NOT_ALLOWED", code: "VALIDATION_FAILED" });
  });

  it("refuses an unknown rate, or a rate whose zone does not serve the country, as methodUnavailable", async () => {
    await expect(
      service.search(searchRequest({ rateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" })),
    ).rejects.toBeInstanceOf(ShippingError);
    await expect(service.search(searchRequest({ countryCode: "FR" }))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(sendcloud.searches).toEqual([]);
  });

  it("rethrows a non-vendor error (our bug is a 500, not a silent UNAVAILABLE)", async () => {
    sendcloud.searchReplies.push(new TypeError("boom"));
    await expect(service.search(searchRequest())).rejects.toBeInstanceOf(TypeError);
  });

  describe("cache", () => {
    it("serves a repeat search for five minutes, keyed on carrier|country|postcode|city", async () => {
      sendcloud.searchReplies.push(fixture, fixture);

      await service.search(searchRequest());
      await service.search(searchRequest({ postalCode: " 50002 " }));
      expect(sendcloud.searches).toHaveLength(1);

      now += SEARCH_CACHE_TTL_MS - 1;
      await service.search(searchRequest());
      expect(sendcloud.searches).toHaveLength(1);

      now += 1;
      await service.search(searchRequest());
      expect(sendcloud.searches).toHaveLength(2);
    });

    it("a different city is a different entry", async () => {
      sendcloud.searchReplies.push(fixture, fixture);

      await service.search(searchRequest());
      await service.search(searchRequest({ city: "Zaragoza" }));

      expect(sendcloud.searches).toHaveLength(2);
    });

    it("caches NONE_NEARBY and ADDRESS_NOT_FOUND, but NEVER an outage", async () => {
      sendcloud.searchReplies.push(new SendcloudError(503, "unavailable", "down"), fixture);

      await expect(service.search(searchRequest())).resolves.toMatchObject({ status: "UNAVAILABLE" });
      await expect(service.search(searchRequest())).resolves.toMatchObject({ status: "OK" });

      sendcloud.searchReplies.push({ geocodingStatus: "not_found", points: [] });
      await service.search(searchRequest({ postalCode: "00000" }));
      await service.search(searchRequest({ postalCode: "00000" }));
      expect(sendcloud.searches).toHaveLength(3);
    });

    it("is bounded: the oldest entry is evicted past the cap", async () => {
      for (let index = 0; index <= SEARCH_CACHE_MAX_ENTRIES; index += 1) {
        sendcloud.searchReplies.push(EMPTY_MATCHED, EMPTY_MATCHED);
        await service.search(searchRequest({ postalCode: `P${index}` }));
      }
      const calls = sendcloud.searches.length;

      // The newest is still cached; the first one was evicted.
      await service.search(searchRequest({ postalCode: `P${SEARCH_CACHE_MAX_ENTRIES}` }));
      expect(sendcloud.searches).toHaveLength(calls);
      sendcloud.searchReplies.push(EMPTY_MATCHED, EMPTY_MATCHED);
      await service.search(searchRequest({ postalCode: "P0" }));
      expect(sendcloud.searches.length).toBeGreaterThan(calls);
    });

    it("normalises the key", () => {
      expect(cacheKey("ups", searchRequest({ postalCode: " 50002", city: "  zaragoza  " }))).toBe(
        "ups|ES|50002|ZARAGOZA",
      );
    });
  });
});

describe("ServicePointsService.verifyForCheckout", () => {
  let sendcloud: FakeSendcloud;
  let service: ServicePointsService;
  let pili: SendcloudServicePoint;

  beforeEach(async () => {
    sendcloud = new FakeSendcloud();
    service = new ServicePointsService(new FakeRepository(), sendcloud, silentLogger, () => 0);
    const found = (await fixtureSearch()).points[0];
    if (found === undefined) throw new Error("fixture changed");
    // A by-id read carries no distance (port docs).
    pili = { ...found, distanceMeters: null };
    sendcloud.points.set("12188365", pili);
  });

  async function reasonOf(promise: Promise<unknown>): Promise<string | null> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    return error instanceof FulfilmentError ? error.reason : null;
  }

  it("HOME rate with no point: no snapshot, no vendor call", async () => {
    await expect(
      service.verifyForCheckout({ fulfilment: UNMAPPED_FULFILMENT, servicePointId: null, countryCode: "ES" }),
    ).resolves.toBeNull();
    expect(sendcloud.gets).toEqual([]);
  });

  it("HOME rate WITH a point: SERVICE_POINT_NOT_ALLOWED", async () => {
    expect(
      await reasonOf(
        service.verifyForCheckout({ fulfilment: UNMAPPED_FULFILMENT, servicePointId: "12188365", countryCode: "ES" }),
      ),
    ).toBe("SERVICE_POINT_NOT_ALLOWED");
    expect(sendcloud.gets).toEqual([]);
  });

  it("pickup rate with no point: SERVICE_POINT_REQUIRED", async () => {
    expect(
      await reasonOf(service.verifyForCheckout({ fulfilment: INPOST_PICKUP, servicePointId: null, countryCode: "ES" })),
    ).toBe("SERVICE_POINT_REQUIRED");
  });

  it("verifies carrier, country, expiry and availability, then snapshots the point", async () => {
    const snapshot = await service.verifyForCheckout({
      fulfilment: INPOST_PICKUP,
      servicePointId: "12188365",
      countryCode: "ES",
    });

    expect(snapshot).toEqual({
      servicePointId: "12188365",
      servicePointCarrierId: "ES21366",
      servicePointName: "PAPELERIA PILI",
      servicePointAddress: "CALLE DE LA BATALLA DE LEPANTO, 50002 ZARAGOZA, ES",
      servicePointPostNumber: null,
    });
    expect(sendcloud.gets).toEqual(["12188365"]);
    expect(sendcloud.availabilityChecks).toEqual(["12188365"]);
  });

  it.each([
    ["another carrier's point", (p: SendcloudServicePoint) => ({ ...p, carrierCode: "ups" }), "ES"],
    ["a point in another country", (p: SendcloudServicePoint) => ({ ...p, countryCode: "PT" }), "ES"],
    ["an expired point", (p: SendcloudServicePoint) => ({ ...p, isExpired: true }), "ES"],
  ])("refuses %s with SERVICE_POINT_UNAVAILABLE, before the availability check", async (_label, mutate, country) => {
    sendcloud.points.set("12188365", mutate(pili));

    expect(
      await reasonOf(
        service.verifyForCheckout({ fulfilment: INPOST_PICKUP, servicePointId: "12188365", countryCode: country }),
      ),
    ).toBe("SERVICE_POINT_UNAVAILABLE");
    expect(sendcloud.availabilityChecks).toEqual([]);
  });

  it("refuses a point Sendcloud says is not available", async () => {
    sendcloud.availability.set("12188365", false);
    expect(
      await reasonOf(
        service.verifyForCheckout({ fulfilment: INPOST_PICKUP, servicePointId: "12188365", countryCode: "ES" }),
      ),
    ).toBe("SERVICE_POINT_UNAVAILABLE");
  });

  it("an unknown point id (Sendcloud 404) is SERVICE_POINT_UNAVAILABLE, not a 500", async () => {
    expect(
      await reasonOf(service.verifyForCheckout({ fulfilment: INPOST_PICKUP, servicePointId: "999", countryCode: "ES" })),
    ).toBe("SERVICE_POINT_UNAVAILABLE");
  });

  it("a Sendcloud outage on either call is SERVICE_POINT_UNAVAILABLE, not a 500", async () => {
    sendcloud.points.set("1", new SendcloudError(503, "unavailable", "down"));
    expect(
      await reasonOf(service.verifyForCheckout({ fulfilment: INPOST_PICKUP, servicePointId: "1", countryCode: "ES" })),
    ).toBe("SERVICE_POINT_UNAVAILABLE");

    sendcloud.availability.set("12188365", new SendcloudError(0, "timeout", "slow"));
    expect(
      await reasonOf(
        service.verifyForCheckout({ fulfilment: INPOST_PICKUP, servicePointId: "12188365", countryCode: "ES" }),
      ),
    ).toBe("SERVICE_POINT_UNAVAILABLE");
  });

  it("not configured, or a pickup rate with no carrier: SERVICE_POINT_UNAVAILABLE", async () => {
    expect(
      await reasonOf(
        service.verifyForCheckout({
          fulfilment: { ...INPOST_PICKUP, carrierCode: null },
          servicePointId: "12188365",
          countryCode: "ES",
        }),
      ),
    ).toBe("SERVICE_POINT_UNAVAILABLE");

    const unconfigured = new ServicePointsService(
      new FakeRepository(),
      new NotConfiguredSendcloudClient(),
      silentLogger,
      () => 0,
    );
    expect(
      await reasonOf(
        unconfigured.verifyForCheckout({ fulfilment: INPOST_PICKUP, servicePointId: "12188365", countryCode: "ES" }),
      ),
    ).toBe("SERVICE_POINT_UNAVAILABLE");
  });

  it("truncates vendor strings to the snapshot columns' widths", async () => {
    sendcloud.points.set("12188365", { ...pili, name: "N".repeat(300), street: "S".repeat(300) });

    const snapshot = await service.verifyForCheckout({
      fulfilment: INPOST_PICKUP,
      servicePointId: "12188365",
      countryCode: "ES",
    });

    expect(snapshot?.servicePointName).toHaveLength(120);
    expect(snapshot?.servicePointAddress).toHaveLength(255);
  });
});

describe("formatServicePointAddress", () => {
  it("joins street + number, postcode + city, country — skipping blanks", () => {
    expect(
      formatServicePointAddress({
        street: "Calle Mayor",
        houseNumber: "1",
        postalCode: "50002",
        city: "Zaragoza",
        countryCode: "es",
      }),
    ).toBe("Calle Mayor 1, 50002 Zaragoza, ES");
    expect(
      formatServicePointAddress({ street: "Calle Mayor", houseNumber: "", postalCode: "", city: "Zaragoza", countryCode: "ES" }),
    ).toBe("Calle Mayor, Zaragoza, ES");
  });
});
