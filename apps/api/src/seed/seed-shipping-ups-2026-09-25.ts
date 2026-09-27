/**
 * Decision D2b (2026-09-25): remove the DHL pickup-point rate from every zone and
 * offer UPS pickup-point at the same €19.99 instead. The rules, and why, are in
 * `ups-replaces-dhl-plan.ts`.
 *
 * Run with: `pnpm nx run api:seed-shipping-ups-2026-09-25`.
 * REQUIRES `seed-shipping-sendcloud-2026-09-24` to have run (the Ireland zone).
 *
 * SAFE TO RUN AGAINST A LIVE DATABASE, MORE THAN ONCE: the plan is computed from
 * the current rows, a second run finds nothing to do, and every change is
 * applied in ONE transaction. Touches only the DHL and UPS rates of the three
 * named zones; never orders, never InPost.
 */

import { PrismaClient } from "@prisma/client";

import { EU_ZONE_NAME, IRELAND_ZONE_NAME, SPAIN_ZONE_NAME, type ZoneSnapshot } from "./sendcloud-shipping-plan";
import { planUpsReplacesDhl } from "./ups-replaces-dhl-plan";

const prisma = new PrismaClient();

/** Mirrors `seed.ts`'s own `seededRateKey` — narrowed, not cast. */
function englishNameOf(name: unknown): string | null {
  if (typeof name !== "object" || name === null || Array.isArray(name)) return null;
  const en: unknown = Reflect.get(name, "en");
  return typeof en === "string" ? en : null;
}

async function main(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const zones = await tx.shippingZone.findMany({
      where: { name: { in: [SPAIN_ZONE_NAME, EU_ZONE_NAME, IRELAND_ZONE_NAME] } },
      include: { rates: true },
      orderBy: { createdAt: "asc" },
    });
    const snapshot: ZoneSnapshot[] = zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      countryCodes: zone.countryCodes,
      sortOrder: zone.sortOrder,
      deleted: zone.deletedAt !== null,
      rates: zone.rates.map((rate) => ({
        id: rate.id,
        nameEn: englishNameOf(rate.name),
        name: rate.name,
        strategy: rate.strategy,
        priceGross: rate.priceGross,
        currency: rate.currency,
        minValue: rate.minValue,
        maxValue: rate.maxValue,
        freeOverSubtotal: rate.freeOverSubtotal,
        isActive: rate.isActive,
        deleted: rate.deletedAt !== null,
        deliveryType: rate.deliveryType,
        carrierCode: rate.carrierCode,
        sendcloudOptionCode: rate.sendcloudOptionCode,
        transitDaysMin: rate.transitDaysMin,
        transitDaysMax: rate.transitDaysMax,
      })),
    }));

    const changes = planUpsReplacesDhl(snapshot);
    if (changes.length === 0) {
      process.stdout.write("Nothing to do — DHL already replaced by UPS.\n");
      return;
    }

    const now = new Date();
    for (const change of changes) {
      switch (change.kind) {
        case "remove-dhl":
          await tx.shippingRate.update({
            where: { id: change.rateId },
            data: { isActive: false, deletedAt: now },
          });
          process.stdout.write(`${change.label}: removed\n`);
          break;
        case "create-ups":
          await tx.shippingRate.create({
            data: { zoneId: change.zoneId, ...change.rate, name: { ...change.rate.name } },
          });
          process.stdout.write(
            `${change.label}: created at ${String(change.rate.priceGross)} (${String(change.rate.sendcloudOptionCode)}, ` +
              `${String(change.rate.transitDaysMin)}–${String(change.rate.transitDaysMax)} days)\n`,
          );
          break;
        case "map-ups":
          await tx.shippingRate.update({ where: { id: change.rateId }, data: { ...change.mapping } });
          process.stdout.write(`${change.label}: mapped to ${String(change.mapping.sendcloudOptionCode)}\n`);
          break;
      }
    }
  });
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nseed-shipping-ups-2026-09-25 failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
