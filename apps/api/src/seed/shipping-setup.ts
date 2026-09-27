/**
 * The shop's shipping setup — zones, rates, their Sendcloud mapping and the
 * STANDARD VAT rate of every country a zone serves — as ONE definition, plus the
 * idempotent writer both `seed.ts` (fresh databases) and `seed-shipping.ts`
 * (re-applying it to an existing one) call.
 *
 * NO TOP-LEVEL SIDE EFFECTS. `seed.ts` runs its whole seed on import, so anything
 * another script needs has to live in a module like this one, which only
 * declares things.
 *
 * What ships where (Sendcloud options from ES, spec
 * docs/superpowers/specs/2026-09-24-sendcloud-shipping.md §11a):
 *
 *   | Zone              | Countries          | UPS Access Point | InPost pickup        |
 *   | Spain (mainland)  | ES                 | 1–3 days         | national, 1–2 days   |
 *   | European Union    | PT FR DE IT NL BE  | 2–4 days         | international, 2–4   |
 *   | Ireland           | IE                 | 2–4 days         | NOT AVAILABLE        |
 *
 * Every zone also gets an UNMAPPED home-delivery rate. The storefront's checkout
 * offers HOME rates only until the API grows pickup-point search, and Akai's own
 * Sendcloud contract (so its home option codes) does not exist yet: staff map
 * the rate in /admin/shipping, and until then label purchase skips it as
 * RATE_NOT_MAPPED rather than guessing a carrier.
 *
 * Ireland is its own zone because a zone's rates are offered to every country in
 * it, and InPost cannot ship to IE. Every rate ships free at or above
 * `FREE_SHIPPING_THRESHOLD_MINOR`. Prices are placeholders for the new shop and
 * are editable in /admin/shipping.
 */

import { type Locale, type PrismaClient, TaxClass } from "@prisma/client";

import { FREE_SHIPPING_THRESHOLD_MINOR } from "./free-shipping-threshold";

export type SeedDeliveryType = "HOME" | "SERVICE_POINT";

/** The Sendcloud mapping of one rate (`shipping_rate` columns of the same names). */
export interface RateMapping {
  readonly deliveryType: SeedDeliveryType;
  readonly carrierCode: string | null;
  readonly sendcloudOptionCode: string | null;
  readonly transitDaysMin: number | null;
  readonly transitDaysMax: number | null;
}

export interface SeedRate {
  /**
   * Per-locale name. BOTH locales are seeded deliberately: the storefront falls
   * back to Spanish, so an English-only rate would silently look correct in the
   * default locale while being wrong for the language it was written for.
   *
   * `en` is also the seed's match key for an existing rate — a seed-local
   * convention, nothing at runtime depends on it.
   */
  readonly name: Readonly<Record<Locale, string>>;
  readonly strategy: "FLAT";
  readonly priceGross: number;
  readonly freeOverSubtotal: number | null;
  readonly mapping: RateMapping;
}

export interface SeedZone {
  /** Zones are matched by name: `shipping_zone` has no natural unique key. */
  readonly name: string;
  readonly countryCodes: readonly string[];
  readonly sortOrder: number;
  readonly rates: readonly SeedRate[];
}

const UPS_NATIONAL: RateMapping = {
  deliveryType: "SERVICE_POINT",
  carrierCode: "ups",
  sendcloudOptionCode: "ups:standard/service_point",
  transitDaysMin: 1,
  transitDaysMax: 3,
};

const UPS_INTERNATIONAL: RateMapping = { ...UPS_NATIONAL, transitDaysMin: 2, transitDaysMax: 4 };

const INPOST_NATIONAL: RateMapping = {
  deliveryType: "SERVICE_POINT",
  carrierCode: "inpost_es",
  sendcloudOptionCode: "inpost_es:service_point,national_c2c",
  transitDaysMin: 1,
  transitDaysMax: 2,
};

const INPOST_INTERNATIONAL: RateMapping = {
  deliveryType: "SERVICE_POINT",
  carrierCode: "inpost_es",
  sendcloudOptionCode: "inpost_es:service_point,international_c2c",
  transitDaysMin: 2,
  transitDaysMax: 4,
};

const HOME_UNMAPPED: RateMapping = {
  deliveryType: "HOME",
  carrierCode: null,
  sendcloudOptionCode: null,
  transitDaysMin: 2,
  transitDaysMax: 5,
};

function homeRate(): SeedRate {
  return {
    name: { es: "Envío a domicilio", en: "Home delivery" },
    strategy: "FLAT",
    priceGross: 699,
    freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
    mapping: HOME_UNMAPPED,
  };
}

function upsRate(mapping: RateMapping): SeedRate {
  return {
    name: { es: "Envío en punto de recogida UPS", en: "UPS pickup-point shipping" },
    strategy: "FLAT",
    priceGross: 1999,
    freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
    mapping,
  };
}

function inpostRate(mapping: RateMapping): SeedRate {
  return {
    name: { es: "Envío en punto de recogida INPOST", en: "InPost pickup-point shipping" },
    strategy: "FLAT",
    priceGross: 899,
    freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
    mapping,
  };
}

export const SHIPPING_ZONES: readonly SeedZone[] = [
  {
    name: "Spain (mainland)",
    countryCodes: ["ES"],
    sortOrder: 0,
    rates: [homeRate(), upsRate(UPS_NATIONAL), inpostRate(INPOST_NATIONAL)],
  },
  {
    name: "European Union",
    countryCodes: ["PT", "FR", "DE", "IT", "NL", "BE"],
    sortOrder: 1,
    rates: [homeRate(), upsRate(UPS_INTERNATIONAL), inpostRate(INPOST_INTERNATIONAL)],
  },
  {
    name: "Ireland",
    countryCodes: ["IE"],
    sortOrder: 2,
    rates: [homeRate(), upsRate(UPS_INTERNATIONAL)],
  },
];

/**
 * The STANDARD VAT rate, in basis points, of every country a zone serves.
 * Clothing is standard-rated in all of them.
 *
 * REQUIRED, not decorative: `PrismaShippingTaxResolver` THROWS when a served
 * destination has no STANDARD rate — deliberately, since defaulting shipping to
 * 0% is an invisible under-remittance. A zone without its rate turns a shipping
 * quote into a configuration error.
 */
export const STANDARD_VAT_BPS: Readonly<Record<string, number>> = {
  ES: 2100,
  PT: 2300,
  FR: 2000,
  DE: 1900,
  IT: 2200,
  NL: 2100,
  BE: 2100,
  IE: 2300,
};

/** `validFrom` is part of the tax rate's natural key, so it is pinned. */
export const TAX_VALID_FROM = new Date("2020-01-01T00:00:00.000Z");

/**
 * The English name of a persisted rate, or null if the column holds anything
 * else. NARROWED, not cast: a Json column is external data like any other, and
 * a row this cannot read simply does not match, so a fresh rate is created.
 */
function englishNameOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const en: unknown = Reflect.get(value, "en");
  return typeof en === "string" ? en : null;
}

async function upsertZone(prisma: PrismaClient, zone: SeedZone): Promise<void> {
  const existing = await prisma.shippingZone.findFirst({ where: { name: zone.name } });

  const row =
    existing === null
      ? await prisma.shippingZone.create({
          data: {
            name: zone.name,
            countryCodes: [...zone.countryCodes],
            sortOrder: zone.sortOrder,
          },
        })
      : await prisma.shippingZone.update({
          where: { id: existing.id },
          data: {
            countryCodes: [...zone.countryCodes],
            sortOrder: zone.sortOrder,
            deletedAt: null,
          },
        });

  // Matched in memory rather than with a Json path filter: a zone has a handful
  // of rates. Only ADDS or UPDATES the rates named here — a rate an operator
  // created in /admin/shipping is never touched.
  const existingRates = await prisma.shippingRate.findMany({ where: { zoneId: row.id } });

  for (const rate of zone.rates) {
    const match =
      existingRates.find((candidate) => englishNameOf(candidate.name) === rate.name.en) ?? null;

    const data = {
      name: { ...rate.name },
      strategy: rate.strategy,
      priceGross: rate.priceGross,
      currency: "EUR",
      minValue: null,
      maxValue: null,
      freeOverSubtotal: rate.freeOverSubtotal,
      isActive: true,
      deletedAt: null,
      ...rate.mapping,
    };

    if (match === null) {
      await prisma.shippingRate.create({ data: { ...data, zoneId: row.id } });
    } else {
      await prisma.shippingRate.update({ where: { id: match.id }, data });
    }
  }
}

/**
 * Write the whole setup. IDEMPOTENT: every write is an upsert keyed on a natural
 * key (country + class + validFrom, zone name, rate English name), so a second
 * run is a no-op.
 */
export async function applyShippingSetup(prisma: PrismaClient): Promise<void> {
  for (const [countryCode, rateBps] of Object.entries(STANDARD_VAT_BPS)) {
    await prisma.taxRate.upsert({
      where: {
        countryCode_taxClass_validFrom: {
          countryCode,
          taxClass: TaxClass.STANDARD,
          validFrom: TAX_VALID_FROM,
        },
      },
      update: { rateBps },
      create: { countryCode, taxClass: TaxClass.STANDARD, rateBps, validFrom: TAX_VALID_FROM },
    });
  }

  for (const zone of SHIPPING_ZONES) {
    await upsertZone(prisma, zone);
  }
}
