/**
 * Replaces EVERY shipping rate in BOTH the "Spain (mainland)" and "European
 * Union" zones with the same two pickup-point options, per the client's
 * 2026-09-19 request.
 *
 * Run with: `pnpm nx run api:seed-shipping-2026-09-19`.
 *
 * WHY A DEDICATED SCRIPT, same reasoning as `seed-shipping.ts`: `seed.ts`'s
 * `upsertZone` only ever adds or updates a rate named in the list it is
 * given — it never removes a rate that exists in the database but is absent
 * from that list. `seed.ts`'s own `seedShipping()` has already been updated
 * to seed only these two rates per zone going forward, but that alone does
 * nothing for a database that already has the five old rates sitting there
 * active. This script is what actually removes them.
 *
 * SOFT-DELETED, NOT HARD-DELETED. `shipping_rate` carries `deletedAt`
 * specifically so a rate can stop being offered without erasing the row —
 * `order.shippingMethodName` is a plain string snapshot, not a foreign key,
 * so nothing references these rows and nothing breaks either way, but
 * keeping them (inactive) preserves the record of what a past order's price
 * was actually built from. `shipping.repository.ts`'s own candidate query
 * (`isActive: true, deletedAt: null`) is the two-flag gate that keeps them
 * off the checkout page; this script sets both.
 *
 * SAFE TO RUN AGAINST A LIVE DATABASE, MORE THAN ONCE: the two new rates are
 * upserted (matched by stable English name, same convention as `seed.ts`
 * and `seed-shipping.ts`), and the five old rates are matched by NAME and
 * only soft-deleted if still active — a second run finds them already
 * `deletedAt` and does nothing further to them. Touches nothing outside
 * `shipping_rate` rows in these two named zones.
 */

import { PrismaClient } from "@prisma/client";

import { FREE_SHIPPING_THRESHOLD_MINOR } from "./free-shipping-threshold";

const prisma = new PrismaClient();

const ZONE_NAMES = ["Spain (mainland)", "European Union"] as const;

/** Every rate name (English, the seed's stable match key) being retired, across both zones. */
const RETIRED_RATE_NAMES: ReadonlySet<string> = new Set([
  "Standard (2-3 days)",
  "Express (next day)",
  "Pickup point (InPost / SEUR)",
  "Letterbox (up to 2 kg)",
  "Standard (3-6 days)",
]);

interface NewRate {
  readonly en: string;
  readonly es: string;
  readonly priceGross: number;
}

const NEW_RATES: readonly NewRate[] = [
  { en: "DHL pickup-point shipping", es: "Envío en punto de recogida DHL", priceGross: 1999 },
  {
    en: "InPost pickup-point shipping",
    es: "Envío en punto de recogida INPOST",
    priceGross: 899,
  },
];

/** Mirrors `seed.ts`'s own `seededRateKey` — narrowed, not cast. */
function englishNameOf(name: unknown): string | null {
  if (typeof name !== "object" || name === null || Array.isArray(name)) return null;
  const en = (name as Record<string, unknown>)["en"];
  return typeof en === "string" ? en : null;
}

async function main(): Promise<void> {
  for (const zoneName of ZONE_NAMES) {
    const zone = await prisma.shippingZone.findFirst({ where: { name: zoneName } });
    if (zone === null) {
      throw new Error(`Shipping zone "${zoneName}" does not exist.`);
    }

    const existingRates = await prisma.shippingRate.findMany({ where: { zoneId: zone.id } });

    for (const rate of existingRates) {
      const name = englishNameOf(rate.name);
      if (name === null || !RETIRED_RATE_NAMES.has(name)) continue;
      if (rate.deletedAt !== null) continue; // already retired, previous run

      await prisma.shippingRate.update({
        where: { id: rate.id },
        data: { isActive: false, deletedAt: new Date() },
      });
      process.stdout.write(`[${zoneName}] retired shipping rate: ${name}\n`);
    }

    for (const rate of NEW_RATES) {
      const existing = existingRates.find((candidate) => englishNameOf(candidate.name) === rate.en);

      const data = {
        name: { es: rate.es, en: rate.en },
        strategy: "FLAT",
        priceGross: rate.priceGross,
        currency: "EUR",
        minValue: null,
        maxValue: null,
        // Kept in step with seed-shipping-2026-09-24.ts, so re-running this
      // older script can never switch the €250 free-shipping rule back off.
      freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
        isActive: true,
        deletedAt: null,
      };

      if (existing === undefined) {
        await prisma.shippingRate.create({ data: { ...data, zoneId: zone.id } });
        process.stdout.write(`[${zoneName}] created shipping rate: ${rate.en}\n`);
      } else {
        await prisma.shippingRate.update({ where: { id: existing.id }, data });
        process.stdout.write(`[${zoneName}] updated shipping rate: ${rate.en}\n`);
      }
    }
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nseed-shipping-2026-09-19 failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
