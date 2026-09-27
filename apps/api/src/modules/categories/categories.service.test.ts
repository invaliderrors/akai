import { describe, expect, it } from "vitest";
import { categoryListResponseSchema } from "@akai/contracts";

import { CategoriesService } from "./categories.service";
import type {
  CategoriesRepository,
  CategoryWithCount,
} from "./categories.repository";
import { mapCategory } from "./category.mapper";

function repositoryOf(rows: readonly CategoryWithCount[]): CategoriesRepository {
  return { listVisible: () => Promise.resolve(rows) };
}

const RECOVERY: CategoryWithCount = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "recovery",
  name: { es: "Recuperación", en: "Recovery" },
  sortOrder: 0,
  productCount: 2,
};

const BUNDLES: CategoryWithCount = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "bundles",
  name: { es: "Packs", en: "Bundles" },
  sortOrder: 1,
  productCount: 0,
};

describe("CategoriesService.list", () => {
  it("returns a payload that satisfies the published contract", async () => {
    const service = new CategoriesService(repositoryOf([RECOVERY, BUNDLES]));

    const result = await service.list("es");

    expect(categoryListResponseSchema.parse(result)).toEqual(result);
  });

  it("carries every locale so a language switch needs no refetch", async () => {
    const service = new CategoriesService(repositoryOf([RECOVERY]));

    const [item] = (await service.list("es")).items;

    expect(item?.name).toEqual({ es: "Recuperación", en: "Recovery" });
  });

  it("keeps EMPTY categories — the presentation decision belongs to the presenter", async () => {
    const service = new CategoriesService(repositoryOf([RECOVERY, BUNDLES]));

    const slugs = (await service.list("es")).items.map((item) => item.slug);

    expect(slugs).toEqual(["recovery", "bundles"]);
  });

  it("honours the operator's explicit sortOrder regardless of row order", async () => {
    const service = new CategoriesService(repositoryOf([BUNDLES, RECOVERY]));

    const slugs = (await service.list("es")).items.map((item) => item.slug);

    expect(slugs).toEqual(["recovery", "bundles"]);
  });

  /**
   * A merchandiser who put a category last meant it, in every language. Locale
   * may only break TIES; if it could reorder across sortOrder values, the
   * merchandising decision would silently differ per visitor.
   */
  it("never lets the locale override an explicit sortOrder", async () => {
    // "Packs" sorts before "Recuperación" alphabetically in Spanish, and
    // "Bundles" before "Recovery" in English — yet sortOrder must still win.
    const service = new CategoriesService(repositoryOf([RECOVERY, BUNDLES]));

    for (const locale of ["es", "en"] as const) {
      const slugs = (await service.list(locale)).items.map((item) => item.slug);
      expect(slugs).toEqual(["recovery", "bundles"]);
    }
  });

  it("breaks a sortOrder tie alphabetically IN THE REQUESTED LANGUAGE", async () => {
    const tied = [
      { ...RECOVERY, sortOrder: 0 },
      { ...BUNDLES, sortOrder: 0 },
    ];
    const service = new CategoriesService(repositoryOf(tied));

    // es: "Packs" < "Recuperación"; en: "Bundles" < "Recovery" — same result
    // here, so assert the reverse case too with names that disagree.
    const spanishFirst = [
      {
        ...RECOVERY,
        sortOrder: 0,
        name: { es: "Aminoácidos", en: "Zinc" },
        slug: "amino",
      },
      { ...BUNDLES, sortOrder: 0, name: { es: "Zinc", en: "Amino acids" }, slug: "zinc" },
    ];
    const other = new CategoriesService(repositoryOf(spanishFirst));

    expect((await service.list("es")).items.map((item) => item.slug)).toEqual([
      "bundles",
      "recovery",
    ]);
    expect((await other.list("es")).items.map((item) => item.slug)).toEqual([
      "amino",
      "zinc",
    ]);
    expect((await other.list("en")).items.map((item) => item.slug)).toEqual([
      "zinc",
      "amino",
    ]);
  });

  it("returns an empty list rather than throwing when nothing is categorised", async () => {
    const service = new CategoriesService(repositoryOf([]));

    await expect(service.list("es")).resolves.toEqual({ items: [] });
  });
});

describe("mapCategory", () => {
  it("degrades a malformed name blob to {} instead of failing the whole navigation", () => {
    const mapped = mapCategory(
      { id: RECOVERY.id, slug: "recovery", name: ["not", "an", "object"], sortOrder: 0 },
      2,
    );

    expect(mapped.name).toEqual({});
    expect(mapped.slug).toBe("recovery");
  });

  it("drops unknown locales rather than propagating them into the wire shape", () => {
    const mapped = mapCategory(
      { id: RECOVERY.id, slug: "recovery", name: { es: "Recuperación", fr: "Récupération" }, sortOrder: 0 },
      1,
    );

    expect(mapped.name).toEqual({ es: "Recuperación" });
  });

  it("takes the count from the caller, not from the row", () => {
    const mapped = mapCategory(
      { id: RECOVERY.id, slug: "recovery", name: {}, sortOrder: 3 },
      7,
    );

    expect(mapped.productCount).toBe(7);
    expect(mapped.sortOrder).toBe(3);
  });
});
