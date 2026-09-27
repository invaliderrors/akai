/**
 * Upserts ONLY the two Spain shipping-rate changes from the client's
 * 2026-09-15 request — nothing else.
 *
 * Run with: `pnpm nx run api:seed-shipping`.
 *
 * WHY THIS EXISTS SEPARATELY FROM `seed.ts`, same reasoning as
 * `seed-categories.ts`: `seed.ts` runs its ENTIRE seed (a known admin
 * password, three fixture products, every tax rate and shipping zone)
 * unconditionally as a side effect of being imported, and its own
 * production guard checks `NODE_ENV`, which this deployment's live API
 * never trips (it deliberately runs `NODE_ENV=development`). This script
 * touches nothing `seed.ts` seeds except two rows in one shipping zone.
 *
 * SAFE TO RUN AGAINST A LIVE DATABASE: both writes are upserts, matched
 * the same way `seed.ts`'s own `upsertZone` matches a rate — by its
 * stable English name — so running this once, twice, or against a
 * database that already has these two rates is a no-op past the first
 * run. It never touches `Product`, `Order`, `Customer`, `TaxRate`, or any
 * zone/rate other than the two named below.
 *
 * DOES NOT TOUCH THE OTHER SPAIN RATES (standard, letterbox) OR THE EU
 * ZONE — the request named exactly two changes, not a replacement of the
 * whole rate table, and this script does exactly that: an in-place price
 * change on the existing "Express" rate, and one new "pickup point" rate
 * alongside it.
 *
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md` §13
 * records why this is a plain relabeled flat rate rather than a real
 * InPost/SEUR carrier integration: nothing in the request or the existing
 * codebase asks for a location picker, and staff already choose the real
 * pickup point off-system when they mark an order shipped, the same way
 * `Shipment.carrier` is free-text today.
 */

import { PrismaClient } from "@prisma/client";

import { FREE_SHIPPING_THRESHOLD_MINOR } from "./free-shipping-threshold";

const prisma = new PrismaClient();

const SPAIN_ZONE_NAME = "Spain (mainland)";

interface RateChange {
  /** The stable match key — `seed.ts`'s own convention for a shipping rate. */
  readonly en: string;
  readonly es: string;
  readonly strategy: "FLAT";
  readonly priceGross: number;
}

const RATE_CHANGES: readonly RateChange[] = [
  {
    // Was 995 (EUR 9.95) — changed to EUR 19.95 per the client's request.
    en: "Express (next day)",
    es: "Exprés (24 h)",
    strategy: "FLAT",
    priceGross: 1995,
  },
  {
    // NEW.
    en: "Pickup point (InPost / SEUR)",
    es: "Punto de recogida (InPost / SEUR)",
    strategy: "FLAT",
    priceGross: 999,
  },
];

/** Mirrors `seed.ts`'s own `seededRateKey` — narrowed, not cast. */
function englishNameOf(name: unknown): string | null {
  if (typeof name !== "object" || name === null || Array.isArray(name)) return null;
  const en = (name as Record<string, unknown>)["en"];
  return typeof en === "string" ? en : null;
}

async function main(): Promise<void> {
  const zone = await prisma.shippingZone.findFirst({ where: { name: SPAIN_ZONE_NAME } });
  if (zone === null) {
    throw new Error(
      `Shipping zone "${SPAIN_ZONE_NAME}" does not exist — this script only updates an existing zone's rates, it does not create one.`,
    );
  }

  const existingRates = await prisma.shippingRate.findMany({ where: { zoneId: zone.id } });

  for (const change of RATE_CHANGES) {
    const existing = existingRates.find((rate) => englishNameOf(rate.name) === change.en) ?? null;

    const data = {
      name: { es: change.es, en: change.en },
      strategy: change.strategy,
      priceGross: change.priceGross,
      currency: "EUR",
      minValue: null,
      maxValue: null,
      // Kept in step with seed-shipping-2026-09-24.ts, so re-running this
      // older script can never switch the €250 free-shipping rule back off.
      freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
      isActive: true,
      deletedAt: null,
    };

    if (existing === null) {
      await prisma.shippingRate.create({ data: { ...data, zoneId: zone.id } });
      process.stdout.write(`created shipping rate: ${change.en}\n`);
    } else {
      await prisma.shippingRate.update({ where: { id: existing.id }, data });
      process.stdout.write(`updated shipping rate: ${change.en}\n`);
    }
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nseed-shipping failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
