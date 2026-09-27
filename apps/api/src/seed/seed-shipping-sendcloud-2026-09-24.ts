/**
 * Sendcloud rate mapping + the Ireland zone split, per spec
 * docs/superpowers/specs/2026-09-24-sendcloud-shipping.md §11a / §12 (D8, D2b).
 * What it does, and why, is documented once in `sendcloud-shipping-plan.ts`.
 *
 * Run with: `pnpm nx run api:seed-shipping-sendcloud-2026-09-24`.
 * REQUIRES migration 20260925120000_sendcloud_shipping to be applied first.
 *
 * WHY A DEDICATED SCRIPT, same reasoning as the other dated shipping seeds:
 * `seed.ts` carries this configuration for a FRESH database, but running it
 * against a live one would also re-run its whole fixture seed. This touches
 * `shipping_zone` / `shipping_rate` rows in the three named zones only.
 *
 * SAFE TO RUN AGAINST A LIVE DATABASE, MORE THAN ONCE: `planSendcloudShipping`
 * computes the changes still needed from the current rows, and a second run
 * finds none ("nothing to do"). All changes are applied in ONE transaction.
 * It never touches prices, names, orders, or any rate other than the two
 * InPost rates (mapped) and the Ireland copy of DHL (created). The DHL rates
 * are left unmapped on purpose — decision D2b is still open.
 *
 * Prints every change, and refuses to finish if any country would be served
 * by two live zones.
 */

import { type Prisma, PrismaClient } from "@prisma/client";

import {
  EU_ZONE_COUNTRIES,
  EU_ZONE_NAME,
  IRELAND_ZONE_COUNTRIES,
  IRELAND_ZONE_NAME,
  IRELAND_ZONE_SORT_ORDER,
  type PlannedChange,
  SPAIN_ZONE_NAME,
  UNMAPPED,
  type ZoneSnapshot,
  countriesInSeveralZones,
  planSendcloudShipping,
} from "./sendcloud-shipping-plan";

const prisma = new PrismaClient();

const ZONE_NAMES = [SPAIN_ZONE_NAME, EU_ZONE_NAME, IRELAND_ZONE_NAME];

/** Mirrors `seed.ts`'s own `seededRateKey` — narrowed, not cast. */
function englishNameOf(name: unknown): string | null {
  if (typeof name !== "object" || name === null || Array.isArray(name)) return null;
  const en: unknown = Reflect.get(name, "en");
  return typeof en === "string" ? en : null;
}

/** The Json column's value, re-typed for a write without a cast. */
function jsonInput(value: unknown): Prisma.InputJsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Refusing to copy a rate whose name is not a locale record.");
  }
  const record: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === "string") record[key] = text;
  }
  return record;
}

async function snapshot(tx: Prisma.TransactionClient): Promise<ZoneSnapshot[]> {
  const zones = await tx.shippingZone.findMany({
    where: { name: { in: ZONE_NAMES } },
    include: { rates: true },
    orderBy: { createdAt: "asc" },
  });
  return zones.map((zone) => ({
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
}

async function apply(tx: Prisma.TransactionClient, changes: readonly PlannedChange[]): Promise<void> {
  let irelandZoneId: string | null =
    (await tx.shippingZone.findFirst({ where: { name: IRELAND_ZONE_NAME }, orderBy: { createdAt: "asc" } }))
      ?.id ?? null;

  for (const change of changes) {
    switch (change.kind) {
      case "map-rate":
        await tx.shippingRate.update({ where: { id: change.rateId }, data: { ...change.mapping } });
        process.stdout.write(
          `${change.label}: ${change.mapping.deliveryType} ${String(change.mapping.sendcloudOptionCode)} ` +
            `(${String(change.mapping.transitDaysMin)}–${String(change.mapping.transitDaysMax)} days)\n`,
        );
        break;
      case "create-ireland-zone": {
        const created = await tx.shippingZone.create({
          data: {
            name: IRELAND_ZONE_NAME,
            countryCodes: [...IRELAND_ZONE_COUNTRIES],
            sortOrder: IRELAND_ZONE_SORT_ORDER,
          },
        });
        irelandZoneId = created.id;
        process.stdout.write(`[${IRELAND_ZONE_NAME}] zone created for ${IRELAND_ZONE_COUNTRIES.join(",")}\n`);
        break;
      }
      case "restore-ireland-zone":
        await tx.shippingZone.update({
          where: { id: change.zoneId },
          data: {
            countryCodes: [...IRELAND_ZONE_COUNTRIES],
            sortOrder: IRELAND_ZONE_SORT_ORDER,
            deletedAt: null,
          },
        });
        irelandZoneId = change.zoneId;
        process.stdout.write(`[${IRELAND_ZONE_NAME}] zone restored to ${IRELAND_ZONE_COUNTRIES.join(",")}\n`);
        break;
      case "copy-rate-to-ireland": {
        if (irelandZoneId === null) {
          throw new Error("Planner ordering bug: Ireland zone missing when copying its rate.");
        }
        await tx.shippingRate.create({
          data: {
            zoneId: irelandZoneId,
            ...change.rate,
            name: jsonInput(change.rate.name),
            ...UNMAPPED,
          },
        });
        process.stdout.write(`${change.label}: created (copy of the EU rate, unmapped — D2b open)\n`);
        break;
      }
      case "set-eu-countries":
        await tx.shippingZone.update({
          where: { id: change.zoneId },
          data: { countryCodes: [...EU_ZONE_COUNTRIES] },
        });
        process.stdout.write(
          `[${EU_ZONE_NAME}] countries ${change.from.join(",")} -> ${EU_ZONE_COUNTRIES.join(",")}\n`,
        );
        break;
    }
  }
}

async function main(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const changes = planSendcloudShipping(await snapshot(tx));
    if (changes.length === 0) {
      process.stdout.write("Nothing to do — already on the 2026-09-24 Sendcloud configuration.\n");
      return;
    }

    await apply(tx, changes);

    // Every live zone, not only the three named: a country in two live zones
    // anywhere is the violation the zones admin forbids.
    const allZones = await tx.shippingZone.findMany({ where: { deletedAt: null } });
    const overlapping = countriesInSeveralZones(
      allZones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        countryCodes: zone.countryCodes,
        sortOrder: zone.sortOrder,
        deleted: false,
        rates: [],
      })),
    );
    if (overlapping.length > 0) {
      // Throwing inside the transaction rolls every change above back.
      throw new Error(`Countries served by more than one live zone: ${overlapping.join(", ")}. Rolled back.`);
    }
  });
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nseed-shipping-sendcloud-2026-09-24 failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
