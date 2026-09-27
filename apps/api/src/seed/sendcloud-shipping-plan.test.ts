import { describe, expect, it } from "vitest";

import {
  DHL_RATE_EN,
  EU_ZONE_COUNTRIES,
  EU_ZONE_NAME,
  INPOST_INTERNATIONAL_MAPPING,
  INPOST_NATIONAL_MAPPING,
  INPOST_RATE_EN,
  IRELAND_ZONE_NAME,
  IRELAND_ZONE_SORT_ORDER,
  type PlannedChange,
  type RateSnapshot,
  SPAIN_ZONE_NAME,
  UNMAPPED,
  type ZoneSnapshot,
  countriesInSeveralZones,
  planSendcloudShipping,
} from "./sendcloud-shipping-plan";

function rate(id: string, en: string, priceGross: number, overrides: Partial<RateSnapshot> = {}): RateSnapshot {
  return {
    id,
    nameEn: en,
    name: { en, es: `${en} (es)` },
    strategy: "FLAT",
    priceGross,
    currency: "EUR",
    minValue: null,
    maxValue: null,
    freeOverSubtotal: 25_000,
    isActive: true,
    deleted: false,
    ...UNMAPPED,
    ...overrides,
  };
}

/** The live database as of 2026-09-24: two zones, DHL + InPost in each, IE in the EU zone. */
function today(): ZoneSnapshot[] {
  return [
    {
      id: "zone-es",
      name: SPAIN_ZONE_NAME,
      countryCodes: ["ES"],
      sortOrder: 0,
      deleted: false,
      rates: [rate("es-dhl", DHL_RATE_EN, 1999), rate("es-inpost", INPOST_RATE_EN, 899)],
    },
    {
      id: "zone-eu",
      name: EU_ZONE_NAME,
      countryCodes: ["PT", "FR", "DE", "IT", "NL", "BE", "IE"],
      sortOrder: 1,
      deleted: false,
      rates: [rate("eu-dhl", DHL_RATE_EN, 1999), rate("eu-inpost", INPOST_RATE_EN, 899)],
    },
  ];
}

/** What the database looks like once `plan` has been applied (a hand-rolled `apply`). */
function applied(zones: ZoneSnapshot[], changes: readonly PlannedChange[]): ZoneSnapshot[] {
  let result = zones.map((zone) => ({ ...zone, rates: [...zone.rates] }));
  for (const change of changes) {
    switch (change.kind) {
      case "map-rate":
        result = result.map((zone) => ({
          ...zone,
          rates: zone.rates.map((r) => (r.id === change.rateId ? { ...r, ...change.mapping } : r)),
        }));
        break;
      case "create-ireland-zone":
        result.push({
          id: "zone-ie",
          name: IRELAND_ZONE_NAME,
          countryCodes: ["IE"],
          sortOrder: IRELAND_ZONE_SORT_ORDER,
          deleted: false,
          rates: [],
        });
        break;
      case "restore-ireland-zone":
        result = result.map((zone) =>
          zone.id === change.zoneId
            ? { ...zone, deleted: false, countryCodes: ["IE"], sortOrder: IRELAND_ZONE_SORT_ORDER }
            : zone,
        );
        break;
      case "copy-rate-to-ireland":
        result = result.map((zone) =>
          zone.name === IRELAND_ZONE_NAME
            ? {
                ...zone,
                rates: [
                  ...zone.rates,
                  { ...change.rate, id: "ie-dhl", nameEn: DHL_RATE_EN, deleted: false, ...UNMAPPED },
                ],
              }
            : zone,
        );
        break;
      case "set-eu-countries":
        result = result.map((zone) =>
          zone.id === change.zoneId ? { ...zone, countryCodes: [...EU_ZONE_COUNTRIES] } : zone,
        );
        break;
    }
  }
  return result;
}

describe("planSendcloudShipping", () => {
  it("maps InPost national in Spain and international in the EU", () => {
    const changes = planSendcloudShipping(today());

    expect(changes).toContainEqual({
      kind: "map-rate",
      rateId: "es-inpost",
      label: `[${SPAIN_ZONE_NAME}] ${INPOST_RATE_EN}`,
      mapping: INPOST_NATIONAL_MAPPING,
    });
    expect(changes).toContainEqual({
      kind: "map-rate",
      rateId: "eu-inpost",
      label: `[${EU_ZONE_NAME}] ${INPOST_RATE_EN}`,
      mapping: INPOST_INTERNATIONAL_MAPPING,
    });
    expect(INPOST_NATIONAL_MAPPING).toMatchObject({
      deliveryType: "SERVICE_POINT",
      carrierCode: "inpost_es",
      sendcloudOptionCode: "inpost_es:service_point,national_c2c",
      transitDaysMin: 1,
      transitDaysMax: 2,
    });
    expect(INPOST_INTERNATIONAL_MAPPING).toMatchObject({
      sendcloudOptionCode: "inpost_es:service_point,international_c2c",
      transitDaysMin: 2,
      transitDaysMax: 4,
    });
  });

  it("leaves every DHL rate untouched — D2b is still open", () => {
    const changes = planSendcloudShipping(today());
    const touched = changes.flatMap((change) => (change.kind === "map-rate" ? [change.rateId] : []));
    expect(touched).not.toContain("es-dhl");
    expect(touched).not.toContain("eu-dhl");
  });

  it("creates Ireland BEFORE removing IE from the EU zone, with a copy of DHL only", () => {
    const changes = planSendcloudShipping(today());
    const kinds = changes.map((change) => change.kind);

    expect(kinds.indexOf("create-ireland-zone")).toBeLessThan(kinds.indexOf("copy-rate-to-ireland"));
    expect(kinds.indexOf("copy-rate-to-ireland")).toBeLessThan(kinds.indexOf("set-eu-countries"));

    const copy = changes.find((change) => change.kind === "copy-rate-to-ireland");
    expect(copy).toMatchObject({
      rate: { priceGross: 1999, currency: "EUR", freeOverSubtotal: 25_000, strategy: "FLAT" },
    });
    // No InPost in Ireland — it cannot ship there (spike §11a G1).
    expect(changes.filter((change) => change.kind === "copy-rate-to-ireland")).toHaveLength(1);
  });

  it("ends with every country in exactly one live zone", () => {
    const after = applied(today(), planSendcloudShipping(today()));
    expect(countriesInSeveralZones(after)).toEqual([]);
    expect(after.find((zone) => zone.name === EU_ZONE_NAME)?.countryCodes).not.toContain("IE");
    expect(after.find((zone) => zone.name === IRELAND_ZONE_NAME)?.countryCodes).toEqual(["IE"]);
  });

  it("is IDEMPOTENT: a second run plans nothing", () => {
    const after = applied(today(), planSendcloudShipping(today()));
    expect(planSendcloudShipping(after)).toEqual([]);
  });

  it("restores a soft-deleted Ireland zone and re-copies a deleted DHL copy", () => {
    const after = applied(today(), planSendcloudShipping(today())).map((zone) =>
      zone.name === IRELAND_ZONE_NAME
        ? { ...zone, deleted: true, rates: zone.rates.map((r) => ({ ...r, deleted: true })) }
        : zone,
    );

    const kinds = planSendcloudShipping(after).map((change) => change.kind);
    expect(kinds).toEqual(["restore-ireland-zone", "copy-rate-to-ireland"]);
  });

  it("refuses a database it was not written for", () => {
    const withoutInpost = today().map((zone) =>
      zone.name === SPAIN_ZONE_NAME ? { ...zone, rates: zone.rates.filter((r) => r.nameEn !== INPOST_RATE_EN) } : zone,
    );
    expect(() => planSendcloudShipping(withoutInpost)).toThrow(/InPost/);
    expect(() => planSendcloudShipping(today().filter((zone) => zone.name !== EU_ZONE_NAME))).toThrow(
      /European Union/,
    );
  });
});

describe("countriesInSeveralZones", () => {
  it("ignores deleted zones", () => {
    expect(
      countriesInSeveralZones([
        { id: "a", name: "A", countryCodes: ["IE"], sortOrder: 0, deleted: false, rates: [] },
        { id: "b", name: "B", countryCodes: ["IE"], sortOrder: 1, deleted: true, rates: [] },
      ]),
    ).toEqual([]);
  });

  it("reports an overlap", () => {
    const duplicateSpain: ZoneSnapshot = {
      id: "dup",
      name: "Dup",
      countryCodes: ["ES"],
      sortOrder: 5,
      deleted: false,
      rates: [],
    };
    expect(countriesInSeveralZones([...today(), duplicateSpain])).toEqual(["ES"]);
  });
});
