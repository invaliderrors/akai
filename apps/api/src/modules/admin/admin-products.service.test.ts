import "reflect-metadata";
import { describe, expect, it, vi, type Mock } from "vitest";
import { AdminProductsService } from "./admin-products.service";
import { AdminAuditService } from "./admin-audit.service";
import { bulkImportRequestSchema, MAX_IMPORT_ROWS } from "./admin.dto";
import type { PrismaService } from "../prisma/prisma.service";
import type {
  AdminActor,
  CatalogAdminPort,
  UpsertProductInput,
  UpsertProductResult,
} from "./admin.types";

const ACTOR: AdminActor = {
  customerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  role: "ADMIN",
  ipAddress: "203.0.113.7",
  userAgent: "AdminPanel/2.0",
  requestId: "req-abc",
};

function validRow(slug: string) {
  return {
    slug,
    name: "Hoodie Kumo",
    variants: [{ sku: `${slug}-10`, priceGross: 4999, currency: "EUR" }],
  };
}

/**
 * The one property of the Prisma `create` argument these assertions read.
 *
 * Typed because `ReturnType<typeof vi.fn>` is `Mock<(...args: any[]) => any>`:
 * every `call[0]?.data?.action` below was an unchecked member access on an
 * `any`, and those calls ARE the audit trail this suite exists to prove exists.
 */
interface AuditCreateCall {
  readonly data: Record<string, unknown>;
}

type AuditCreateFn = (args: AuditCreateCall) => Promise<unknown>;
type ExportProductsFn = CatalogAdminPort["exportProducts"];

/** `Object.keys` for a value that is only known to be `unknown`. */
function keysOf(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

function buildService(
  upsert: (input: UpsertProductInput) => Promise<UpsertProductResult>,
): {
  service: AdminProductsService;
  auditCreate: Mock<AuditCreateFn>;
  exportProducts: Mock<ExportProductsFn>;
} {
  const auditCreate = vi.fn<AuditCreateFn>(async () => ({}));
  const prisma = { auditLogEntry: { create: auditCreate } } as unknown as PrismaService;
  const exportProducts = vi.fn<ExportProductsFn>(async () => []);

  const catalog: CatalogAdminPort = {
    exportProducts,
    upsertProduct: upsert,
  };

  return {
    service: new AdminProductsService(catalog, new AdminAuditService(prisma)),
    auditCreate,
    exportProducts,
  };
}

const created = (slug: string): UpsertProductResult => ({
  id: `id-${slug}`,
  slug,
  created: true,
  previous: null,
});

describe("AdminProductsService — import", () => {
  it("delegates every write to the catalog port rather than reimplementing CRUD", async () => {
    const upsert = vi.fn(async (input: UpsertProductInput) => created(input.slug));
    const { service } = buildService(upsert);

    const request = bulkImportRequestSchema.parse({
      products: [validRow("hoodie-kumo"), validRow("cargo-pants")],
    });
    await service.importProducts(ACTOR, request);

    // A second implementation of catalogue writes would mean price derivation,
    // slug history and the provider-sync outbox all drift on the bulk path.
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("continues past a failing row and reports it individually", async () => {
    const upsert = vi.fn(async (input: UpsertProductInput) => {
      if (input.slug === "cargo-pants") {
        throw new Error("SKU already exists");
      }
      return created(input.slug);
    });
    const { service } = buildService(upsert);

    const request = bulkImportRequestSchema.parse({
      products: [validRow("hoodie-kumo"), validRow("cargo-pants"), validRow("coach-jacket")],
    });
    const report = await service.importProducts(ACTOR, request);

    // One bad row in a supplier spreadsheet must not block the other 899, and
    // the admin must be told exactly which row failed.
    expect(report.created).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.rows.find((row) => row.slug === "cargo-pants")).toEqual({
      slug: "cargo-pants",
      outcome: "failed",
      error: "SKU already exists",
    });
  });

  it("does not stringify a non-Error throw into the response", async () => {
    const upsert = vi.fn(async () => {
      throw { internal: "connection string leaked here" };
    });
    const { service } = buildService(upsert);

    const request = bulkImportRequestSchema.parse({ products: [validRow("hoodie-kumo")] });
    const report = await service.importProducts(ACTOR, request);

    // Stringifying an arbitrary throw is how a driver's internals reach an HTTP
    // response.
    expect(report.rows[0]?.error).toBe("Import failed");
    expect(JSON.stringify(report)).not.toContain("connection string");
  });

  it("writes NOTHING on a dry run", async () => {
    const upsert = vi.fn(async (input: UpsertProductInput) => created(input.slug));
    const { service } = buildService(upsert);

    const request = bulkImportRequestSchema.parse({
      dryRun: true,
      products: [validRow("hoodie-kumo")],
    });
    const report = await service.importProducts(ACTOR, request);

    expect(upsert).not.toHaveBeenCalled();
    expect(report.dryRun).toBe(true);
    expect(report.created).toBe(0);
  });

  it("audits each product write with the actor and the entity id", async () => {
    const upsert = vi.fn(async (input: UpsertProductInput) => created(input.slug));
    const { service, auditCreate } = buildService(upsert);

    const request = bulkImportRequestSchema.parse({ products: [validRow("hoodie-kumo")] });
    await service.importProducts(ACTOR, request);

    const actions = auditCreate.mock.calls.map((call): unknown => call[0].data["action"]);
    expect(actions).toContain("product.create");
    expect(actions).toContain("product.bulk_import");

    const rowAudit = auditCreate.mock.calls.find(
      (call) => call[0].data["action"] === "product.create",
    );
    expect(rowAudit?.[0].data["actorId"]).toBe(ACTOR.customerId);
    expect(rowAudit?.[0].data["entityId"]).toBe("id-hoodie-kumo");
  });

  it("audits an update with a before snapshot so the change is reconstructable", async () => {
    const upsert = vi.fn(async (input: UpsertProductInput) => ({
      id: "id-1",
      slug: input.slug,
      created: false,
      previous: {
        slug: input.slug,
        status: "ACTIVE",
        taxClass: "STANDARD",
        name: "Old name",
        shortDescription: "",
        description: "",
        variants: [
          {
            sku: "hoodie-kumo-m",
            priceGross: 3999,
            compareAtGross: null,
            currency: "EUR",
            weightGrams: null,
            lowStockThreshold: 5,
            allowBackorder: false,
          },
        ],
        restrictedCountries: [],
      },
    }));
    const { service, auditCreate } = buildService(upsert);

    const request = bulkImportRequestSchema.parse({ products: [validRow("hoodie-kumo")] });
    await service.importProducts(ACTOR, request);

    const update = auditCreate.mock.calls.find(
      (call) => call[0].data["action"] === "product.update",
    );
    const diff: unknown = update?.[0].data["diff"];

    // "The price changed" is only auditable if the previous price was captured.
    expect(keysOf(diff)).toContain("variants");
  });

  it("audits a bulk EXPORT, because it is an exfiltration-shaped event", async () => {
    const { service, auditCreate } = buildService(async (input) => created(input.slug));

    await service.exportProducts(ACTOR);

    // Reads are not normally audited; a full catalogue dump is worth being able
    // to attribute after the fact.
    const actions = auditCreate.mock.calls.map((call): unknown => call[0].data["action"]);
    expect(actions).toContain("product.bulk_export");
  });
});

describe("bulkImportRequestSchema", () => {
  it("rejects duplicate slugs in one payload", () => {
    // Two rows with the same slug would race through the upsert, with whichever
    // landed last silently winning.
    expect(() =>
      bulkImportRequestSchema.parse({ products: [validRow("hoodie-kumo"), validRow("hoodie-kumo")] }),
    ).toThrow();
  });

  it("rejects duplicate SKUs within one product", () => {
    expect(() =>
      bulkImportRequestSchema.parse({
        products: [
          {
            ...validRow("hoodie-kumo"),
            variants: [
              { sku: "dup", priceGross: 100, currency: "EUR" },
              { sku: "dup", priceGross: 200, currency: "EUR" },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a compare-at price below the selling price", () => {
    // Renders as a negative discount and is an unlawful price display in several
    // EU jurisdictions.
    expect(() =>
      bulkImportRequestSchema.parse({
        products: [
          {
            ...validRow("hoodie-kumo"),
            variants: [
              { sku: "a", priceGross: 5000, compareAtGross: 4000, currency: "EUR" },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a non-integer price outright", () => {
    // Money is integer minor units end-to-end. A float reaching the catalogue is
    // a rounding bug waiting for a customer to find it.
    expect(() =>
      bulkImportRequestSchema.parse({
        products: [
          {
            ...validRow("hoodie-kumo"),
            variants: [{ sku: "a", priceGross: 49.99, currency: "EUR" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    expect(() =>
      bulkImportRequestSchema.parse({
        products: [{ ...validRow("hoodie-kumo"), isAdmin: true }],
      }),
    ).toThrow();
  });

  it("caps the payload at a size it can process synchronously", () => {
    const products = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) =>
      validRow(`product-${index}`),
    );

    // An uncapped endpoint that times out at row 2,000 has already half-written
    // the catalogue by the time the client gives up.
    expect(() => bulkImportRequestSchema.parse({ products })).toThrow();
  });

  it("requires at least one variant and a name", () => {
    expect(() =>
      bulkImportRequestSchema.parse({
        products: [{ ...validRow("hoodie-kumo"), variants: [] }],
      }),
    ).toThrow();
    expect(() =>
      bulkImportRequestSchema.parse({
        products: [{ ...validRow("hoodie-kumo"), name: "" }],
      }),
    ).toThrow();
  });
});
