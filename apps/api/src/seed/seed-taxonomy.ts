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
 * `bundles` is here for a specific, checkable reason: the storefront renders a
 * `/bundles` page that filters on `categories.some(c => c.slug === "bundles")`,
 * and `GET /v1/products?category=bundles` has always worked. What was missing
 * was any product carrying the category — the page asserted a concept the data
 * did not have, so it rendered empty with no error. This is a seeded CATEGORY,
 * not a new product type: true multi-SKU kits would be a schema-level feature.
 */
export interface SeedCategory {
  readonly slug: string;
  readonly es: string;
  readonly en: string;
  readonly sortOrder: number;
}

export const CATEGORIES: readonly SeedCategory[] = [
  { slug: "metabolico", es: "Metabólico", en: "Metabolic", sortOrder: 0 },
  { slug: "ciencia-piel", es: "Ciencia de la piel", en: "Skin Science", sortOrder: 1 },
  { slug: "nootropicos", es: "Nootrópicos", en: "Nootropics", sortOrder: 2 },
  { slug: "longevidad", es: "Longevidad", en: "Longevity", sortOrder: 3 },
  { slug: "miociencia", es: "Miociencia", en: "Muscle Science", sortOrder: 4 },
  {
    slug: "investigacion-tejidos",
    es: "Investigación de tejidos",
    en: "Tissue Research",
    sortOrder: 5,
  },
  { slug: "suministros", es: "Suministros", en: "Supplies", sortOrder: 6 },
  { slug: "bundles", es: "Packs", en: "Bundles", sortOrder: 7 },
];
