/**
 * Upserts ONLY the navigation category taxonomy — nothing else.
 *
 * Run with: `pnpm nx run api:seed-categories` (see package.json).
 *
 * WHY THIS EXISTS SEPARATELY FROM `seed.ts`:
 * `seed.ts` seeds a KNOWN admin password and a fixture catalogue alongside
 * its categories, runs its ENTIRE seed unconditionally as a side effect of
 * being imported (there is no `require.main` guard), and is meant for a
 * fresh dev/staging database, never one with real orders in it. Its own guard
 * against running "in production" checks `NODE_ENV`, and this deployment
 * deliberately runs the live API with `NODE_ENV=development` (a pinned,
 * intentional quirk of the deploy config) — so that guard would NOT stop
 * `seed.ts` from running against the real database if it were ever imported
 * or invoked there. This script imports ONLY the plain-data taxonomy from
 * `./seed-taxonomy` (which has no top-level side effects of its own) and
 * never touches `seed.ts` at all, so the taxonomy can be applied to a live database with nothing else at risk.
 *
 * SAFE TO RUN AGAINST A LIVE DATABASE: every write is find-then-write, keyed
 * on the LIVE row matching `slug` (mirroring `seedCategories()` in
 * `seed.ts`), so running it once, twice, or against a database that already
 * has these categories is a no-op past the first run. It never touches
 * `Product`, `Order`, `User`, or any other table.
 *
 * FIND-THEN-WRITE, NOT `upsert`. `category.slug` is unique among LIVE rows
 * only (a partial index in `20260927000100_invariants` — the admin CRUD
 * screen has a real delete path), so `upsert({ where: { slug } })` no
 * longer type-checks: a slug is not Prisma's idea of a unique identifier once
 * the index is partial. A seed re-run building against a LIVE row is exactly
 * the behaviour wanted — an admin who deliberately deleted one of these
 * categories should get a fresh one back, not a resurrected one carrying
 * whatever they changed before deleting it.
 */

import { PrismaClient } from "@prisma/client";
import { CATEGORIES } from "./seed-taxonomy";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  for (const category of CATEGORIES) {
    const existing = await prisma.category.findFirst({
      where: { slug: category.slug, deletedAt: null },
      select: { id: true },
    });

    const result =
      existing === null
        ? await prisma.category.create({
            data: {
              slug: category.slug,
              name: category.name,
              sortOrder: category.sortOrder,
            },
          })
        : await prisma.category.update({
            where: { id: existing.id },
            data: {
              name: category.name,
              sortOrder: category.sortOrder,
            },
          });
    process.stdout.write(`upserted category: ${result.slug}\n`);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nseed-categories failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
