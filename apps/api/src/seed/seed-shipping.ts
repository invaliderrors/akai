/**
 * Applies ONLY the shipping setup (the Colombia zone, its rate and Colombia's
 * STANDARD IVA rate) — nothing else.
 *
 * Run with: `pnpm nx run api:seed-shipping`.
 *
 * WHY THIS EXISTS SEPARATELY FROM `seed.ts`: `seed.ts` seeds a KNOWN admin
 * password and a fixture catalogue alongside the shipping setup, and runs all of
 * it unconditionally on import. Its production guard checks `NODE_ENV`, which a
 * deployment that runs the API with `NODE_ENV=development` never trips. This
 * script touches shipping zones, shipping rates and STANDARD tax rates only, so
 * it can be applied to a live database with nothing else at risk.
 *
 * SAFE TO RUN MORE THAN ONCE: every write is an upsert on a natural key (see
 * `applyShippingSetup`). It never removes a zone or rate an operator created,
 * and never touches products, orders or customers.
 */

import { PrismaClient } from "@prisma/client";

import { applyShippingSetup, SHIPPING_ZONES } from "./shipping-setup";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await applyShippingSetup(prisma);
  for (const zone of SHIPPING_ZONES) {
    process.stdout.write(
      `upserted shipping zone: ${zone.name} (${String(zone.rates.length)} rates)\n`,
    );
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
