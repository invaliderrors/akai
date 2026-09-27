/**
 * Free shipping on orders of €250.00 or more — sets
 * `shipping_rate.freeOverSubtotal = 25000` on EVERY non-deleted rate in EVERY
 * non-deleted zone, per the client's 2026-09-24 request
 * (docs/superpowers/specs/2026-09-24-client-feedback-changes.md §3, D3b).
 *
 * Run with: `pnpm nx run api:seed-shipping-2026-09-24`.
 *
 * WHY A DEDICATED SCRIPT, same reasoning as `seed-shipping-2026-09-19.ts`:
 * `seed.ts` seeds the threshold for a FRESH database, but running it against a
 * live one would also re-run its whole fixture seed (a known admin password,
 * fixture products). This script touches one column of `shipping_rate` and
 * nothing else.
 *
 * INACTIVE RATES ARE INCLUDED, soft-deleted ones are not. An operator who
 * re-activates a paused rate must not silently re-introduce paid shipping on a
 * €300 order; a soft-deleted rate is history and is left exactly as it was.
 *
 * SAFE TO RUN AGAINST A LIVE DATABASE, MORE THAN ONCE: it sets a value rather
 * than incrementing one, so a second run finds every rate already at 25000 and
 * reports "unchanged". It never touches prices, names, zones, orders or any
 * other table. Nothing reads the threshold from anywhere but the rate rows, so
 * the effect is immediate for the next quote and the next checkout.
 */

import { PrismaClient } from "@prisma/client";

import { FREE_SHIPPING_THRESHOLD_MINOR } from "./free-shipping-threshold";

const prisma = new PrismaClient();

/** Mirrors `seed.ts`'s own `seededRateKey` — narrowed, not cast. */
function englishNameOf(name: unknown): string {
  if (typeof name !== "object" || name === null || Array.isArray(name)) return "(unnamed)";
  const en = (name as Record<string, unknown>)["en"];
  return typeof en === "string" ? en : "(unnamed)";
}

async function main(): Promise<void> {
  const rates = await prisma.shippingRate.findMany({
    where: { deletedAt: null, zone: { deletedAt: null } },
    include: { zone: { select: { name: true } } },
    orderBy: [{ zoneId: "asc" }, { priceGross: "asc" }],
  });

  if (rates.length === 0) {
    throw new Error("No shipping rates found — nothing to apply the free-shipping threshold to.");
  }

  for (const rate of rates) {
    const label = `[${rate.zone.name}] ${englishNameOf(rate.name)}`;
    if (rate.freeOverSubtotal === FREE_SHIPPING_THRESHOLD_MINOR) {
      process.stdout.write(`${label}: unchanged (already ${FREE_SHIPPING_THRESHOLD_MINOR})\n`);
      continue;
    }
    await prisma.shippingRate.update({
      where: { id: rate.id },
      data: { freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR },
    });
    process.stdout.write(
      `${label}: freeOverSubtotal ${String(rate.freeOverSubtotal)} -> ${FREE_SHIPPING_THRESHOLD_MINOR}\n`,
    );
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nseed-shipping-2026-09-24 failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
