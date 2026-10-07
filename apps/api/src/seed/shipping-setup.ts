/**
 * The shop's shipping setup — its one zone, its one rate, and the STANDARD tax
 * rate of the country it serves — as ONE definition, plus the idempotent writer
 * both `seed.ts` (fresh databases) and `seed-shipping.ts` (re-applying it to an
 * existing one) call.
 *
 * NO TOP-LEVEL SIDE EFFECTS. `seed.ts` runs its whole seed on import, so anything
 * another script needs has to live in a module like this one, which only
 * declares things.
 *
 * Akai sells in COLOMBIA ONLY, so the setup is deliberately simple:
 *
 *   | Zone     | Countries | Rate                                 | Price     |
 *   | Colombia | CO        | Envío nacional / National shipping   | $ 15.000  |
 *
 * free at or above `FREE_SHIPPING_THRESHOLD_MINOR` ($ 300.000). Staff ship by
 * hand (carrier and tracking number typed into the order), so a rate carries no
 * carrier mapping. Prices are placeholders, editable in /admin/shipping.
 */

import { type PrismaClient, TaxClass } from "@prisma/client";

import { FREE_SHIPPING_THRESHOLD_MINOR } from "./free-shipping-threshold";

/** The currency every seeded amount is in. Minor units are centavos. */
export const SEED_CURRENCY = "COP";

export interface SeedRate {
  /**
   * The rate's display name. Also the seed's match key for an existing rate in
   * the zone — a seed-local convention, nothing at runtime depends on it.
   */
  readonly name: string;
  readonly strategy: "FLAT";
  /** Centavos: 1_500_000 is $ 15.000. */
  readonly priceGross: number;
  readonly freeOverSubtotal: number | null;
  readonly transitDaysMin: number | null;
  readonly transitDaysMax: number | null;
}

export interface SeedZone {
  /** Zones are matched by name: `shipping_zone` has no natural unique key. */
  readonly name: string;
  readonly countryCodes: readonly string[];
  readonly sortOrder: number;
  readonly rates: readonly SeedRate[];
}

/** $ 15.000 COP, in centavos. */
export const NATIONAL_SHIPPING_PRICE_MINOR = 1_500_000;

export const SHIPPING_ZONES: readonly SeedZone[] = [
  {
    name: "Colombia",
    countryCodes: ["CO"],
    sortOrder: 0,
    rates: [
      {
        name: "Envío nacional",
        strategy: "FLAT",
        priceGross: NATIONAL_SHIPPING_PRICE_MINOR,
        freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
        transitDaysMin: 2,
        transitDaysMax: 5,
      },
    ],
  },
];

/**
 * The STANDARD tax rate, in basis points, of every country a zone serves:
 * Colombia's general IVA rate, 19%. Clothing is standard-rated.
 *
 * REQUIRED, not decorative: `PrismaShippingTaxResolver` THROWS when a served
 * destination has no STANDARD rate — deliberately, since defaulting shipping to
 * 0% is an invisible under-remittance. A zone without its rate turns a shipping
 * quote into a configuration error.
 */
export const STANDARD_VAT_BPS: Readonly<Record<string, number>> = {
  CO: 1900,
};

/** The store's own country — the one its catalogue prices are taxed in. */
export const STORE_COUNTRY = "CO";

/** `validFrom` is part of the tax rate's natural key, so it is pinned. */
export const TAX_VALID_FROM = new Date("2020-01-01T00:00:00.000Z");

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
      existingRates.find((candidate) => candidate.name === rate.name) ?? null;

    const data = {
      name: rate.name,
      strategy: rate.strategy,
      priceGross: rate.priceGross,
      currency: SEED_CURRENCY,
      minValue: null,
      maxValue: null,
      freeOverSubtotal: rate.freeOverSubtotal,
      isActive: true,
      deletedAt: null,
      transitDaysMin: rate.transitDaysMin,
      transitDaysMax: rate.transitDaysMax,
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
 * key (country + class + validFrom, zone name, rate name), so a second
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
