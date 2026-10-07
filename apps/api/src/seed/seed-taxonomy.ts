/**
 * The navigation category taxonomy, as pure data — no `PrismaClient`, no
 * `main()`, nothing that runs on import.
 *
 * Lives in its own file, separate from `seed.ts`, because `seed.ts` executes
 * its full seed (admin password, fixture products, tax rates, shipping
 * zones, media uploads) unconditionally at module load — importing anything
 * from it, even a constant, would trigger that whole run as a side effect.
 * `seed-categories.ts` needs this list WITHOUT any of that, so it lives here
 * and `seed.ts` imports it too.
 *
 * A small streetwear placeholder taxonomy; the real one is an admin decision
 * made in /admin/categories.
 */
export interface SeedCategory {
  readonly slug: string;
  readonly name: string;
  readonly sortOrder: number;
}

export const CATEGORIES: readonly SeedCategory[] = [
  { slug: "tops", name: "Camisetas y sudaderas", sortOrder: 0 },
  { slug: "outerwear", name: "Chaquetas", sortOrder: 1 },
  { slug: "bottoms", name: "Pantalones", sortOrder: 2 },
  { slug: "accessories", name: "Accesorios", sortOrder: 3 },
];
