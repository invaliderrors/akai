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
  name: "Recuperación",
  sortOrder: 0,
  productCount: 2,
};

const BUNDLES: CategoryWithCount = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "bundles",
  name: "Packs",
  sortOrder: 1,
  productCount: 0,
};

describe("CategoriesService.list", () => {
  it("returns a payload that satisfies the published contract", async () => {
    const service = new CategoriesService(repositoryOf([RECOVERY, BUNDLES]));

    const result = await service.list();

    expect(categoryListResponseSchema.parse(result)).toEqual(result);
  });

  it("carries the Spanish name as a plain string", async () => {
    const service = new CategoriesService(repositoryOf([RECOVERY]));

    const [item] = (await service.list()).items;

    expect(item?.name).toBe("Recuperación");
  });

  it("keeps EMPTY categories — the presentation decision belongs to the presenter", async () => {
    const service = new CategoriesService(repositoryOf([RECOVERY, BUNDLES]));

    const slugs = (await service.list()).items.map((item) => item.slug);

    expect(slugs).toEqual(["recovery", "bundles"]);
  });

  it("honours the operator's explicit sortOrder regardless of row order", async () => {
    const service = new CategoriesService(repositoryOf([BUNDLES, RECOVERY]));

    const slugs = (await service.list()).items.map((item) => item.slug);

    expect(slugs).toEqual(["recovery", "bundles"]);
  });

  it("never lets the name override an explicit sortOrder", async () => {
    // "Packs" sorts before "Recuperación" alphabetically — sortOrder must still win.
    const service = new CategoriesService(repositoryOf([RECOVERY, BUNDLES]));

    const slugs = (await service.list()).items.map((item) => item.slug);

    expect(slugs).toEqual(["recovery", "bundles"]);
  });

  it("breaks a sortOrder tie alphabetically by the Spanish name, accents collated", async () => {
    const tied = [
      { ...RECOVERY, sortOrder: 0, name: "Zapatos", slug: "zapatos" },
      { ...BUNDLES, sortOrder: 0, name: "Árboles", slug: "arboles" },
      { ...BUNDLES, id: "33333333-3333-4333-8333-333333333333", sortOrder: 0, name: "Bolsos", slug: "bolsos" },
    ];
    const service = new CategoriesService(repositoryOf(tied));

    // A byte-order sort would put "Árboles" last; Spanish collation puts it first.
    expect((await service.list()).items.map((item) => item.slug)).toEqual([
      "arboles",
      "bolsos",
      "zapatos",
    ]);
  });

  it("returns an empty list rather than throwing when nothing is categorised", async () => {
    const service = new CategoriesService(repositoryOf([]));

    await expect(service.list()).resolves.toEqual({ items: [] });
  });
});

describe("mapCategory", () => {
  it("takes the count from the caller, not from the row", () => {
    const mapped = mapCategory(
      { id: RECOVERY.id, slug: "recovery", name: "Recuperación", sortOrder: 3 },
      7,
    );

    expect(mapped.productCount).toBe(7);
    expect(mapped.sortOrder).toBe(3);
    expect(mapped.name).toBe("Recuperación");
  });
});
