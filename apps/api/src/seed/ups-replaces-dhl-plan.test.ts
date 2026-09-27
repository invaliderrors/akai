import { describe, expect, it } from "vitest";
import {
  DHL_RATE_EN,
  EU_ZONE_NAME,
  INPOST_RATE_EN,
  IRELAND_ZONE_NAME,
  type RateSnapshot,
  SPAIN_ZONE_NAME,
  UNMAPPED,
  UPS_INTERNATIONAL_MAPPING,
  UPS_NATIONAL_MAPPING,
  UPS_RATE_EN,
  type ZoneSnapshot,
} from "./sendcloud-shipping-plan";
import { planUpsReplacesDhl, UPS_RATE_PRICE_GROSS } from "./ups-replaces-dhl-plan";

function rate(id: string, nameEn: string, overrides: Partial<RateSnapshot> = {}): RateSnapshot {
  return {
    id,
    nameEn,
    name: { en: nameEn },
    strategy: "FLAT",
    priceGross: 1999,
    currency: "EUR",
    minValue: null,
    maxValue: null,
    freeOverSubtotal: 25000,
    isActive: true,
    deleted: false,
    ...UNMAPPED,
    ...overrides,
  };
}

function zone(id: string, name: string, rates: RateSnapshot[], deleted = false): ZoneSnapshot {
  return { id, name, countryCodes: [], sortOrder: 0, deleted, rates };
}

const production = (): ZoneSnapshot[] => [
  zone("es", SPAIN_ZONE_NAME, [rate("es-dhl", DHL_RATE_EN), rate("es-inpost", INPOST_RATE_EN, { priceGross: 899 })]),
  zone("eu", EU_ZONE_NAME, [rate("eu-dhl", DHL_RATE_EN), rate("eu-inpost", INPOST_RATE_EN, { priceGross: 899 })]),
  zone("ie", IRELAND_ZONE_NAME, [rate("ie-dhl", DHL_RATE_EN)]),
];

describe("planUpsReplacesDhl", () => {
  it("removes DHL and adds UPS at €19.99 in every zone, leaving InPost alone", () => {
    const changes = planUpsReplacesDhl(production());

    expect(changes.filter((c) => c.kind === "remove-dhl").map((c) => c.rateId)).toEqual([
      "es-dhl",
      "eu-dhl",
      "ie-dhl",
    ]);
    const created = changes.flatMap((c) => (c.kind === "create-ups" ? [c] : []));
    expect(created.map((c) => c.zoneId)).toEqual(["es", "eu", "ie"]);
    for (const c of created) {
      expect(c.rate.priceGross).toBe(UPS_RATE_PRICE_GROSS);
      expect(c.rate.freeOverSubtotal).toBe(25000);
      expect(c.rate.name).toEqual({ es: "Envío en punto de recogida UPS", en: UPS_RATE_EN });
      expect(c.rate.sendcloudOptionCode).toBe("ups:standard/service_point");
      expect(c.rate.deliveryType).toBe("SERVICE_POINT");
    }
    expect(created[0]?.rate.transitDaysMax).toBe(UPS_NATIONAL_MAPPING.transitDaysMax);
    expect(created[1]?.rate.transitDaysMax).toBe(UPS_INTERNATIONAL_MAPPING.transitDaysMax);
    expect(changes.some((c) => "rateId" in c && c.rateId.endsWith("inpost"))).toBe(false);
  });

  it("is idempotent: the configuration it produces plans nothing", () => {
    const after = [
      zone("es", SPAIN_ZONE_NAME, [
        rate("es-dhl", DHL_RATE_EN, { deleted: true }),
        rate("es-ups", UPS_RATE_EN, { ...UPS_NATIONAL_MAPPING }),
      ]),
      zone("ie", IRELAND_ZONE_NAME, [rate("ie-ups", UPS_RATE_EN, { ...UPS_INTERNATIONAL_MAPPING })]),
    ];
    expect(planUpsReplacesDhl(after)).toEqual([]);
  });

  it("never reverts a mapped UPS rate that staff edited", () => {
    const edited = [
      zone("es", SPAIN_ZONE_NAME, [rate("es-ups", UPS_RATE_EN, { ...UPS_NATIONAL_MAPPING, transitDaysMax: 5 })]),
    ];
    expect(planUpsReplacesDhl(edited)).toEqual([]);
  });

  it("fills in the mapping on a hand-made, unmapped UPS rate instead of duplicating it", () => {
    const changes = planUpsReplacesDhl([zone("eu", EU_ZONE_NAME, [rate("eu-ups", UPS_RATE_EN)])]);
    expect(changes).toEqual([
      { kind: "map-ups", rateId: "eu-ups", label: `[${EU_ZONE_NAME}] ${UPS_RATE_EN}`, mapping: UPS_INTERNATIONAL_MAPPING },
    ]);
  });

  it("ignores deleted zones and zones it does not know", () => {
    expect(
      planUpsReplacesDhl([
        zone("x", EU_ZONE_NAME, [rate("x-dhl", DHL_RATE_EN)], true),
        zone("y", "Switzerland", [rate("y-dhl", DHL_RATE_EN)]),
      ]),
    ).toEqual([]);
  });
});
