import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMinor, type CreateShippingRate } from "@akai/contracts";

import { PrismaService } from "../../prisma/prisma.service";
import { ShippingAdminError } from "./admin-shipping.errors";
import { AdminShippingService, assertRateCoherent } from "./admin-shipping.service";

/**
 * The zones/rates admin invariants against a scripted Prisma double. The
 * database-level half (the advisory lock really serialising two writers) is
 * proven against Postgres in `apps/api-e2e/src/admin-shipping.spec.ts`; here
 * we prove the ORDER of operations that makes it work and every refusal.
 */

type Mock = ReturnType<typeof vi.fn>;

const ZONE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ZONE_ID = "22222222-2222-4222-8222-222222222222";
const RATE_ID = "33333333-3333-4333-8333-333333333333";
const T0 = new Date("2026-09-24T10:00:00.000Z");

function zoneRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ZONE_ID,
    name: "España",
    countryCodes: ["ES"],
    sortOrder: 0,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
}

function rateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RATE_ID,
    zoneId: ZONE_ID,
    name: { es: "Envío nacional", en: "National shipping" },
    strategy: "FLAT",
    priceGross: 1_500_000,
    currency: "COP",
    minValue: null,
    maxValue: null,
    freeOverSubtotal: 30_000_000,
    isActive: true,
    transitDaysMin: 2,
    transitDaysMax: 5,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
}

const newRate: CreateShippingRate = {
  name: { es: "Envío express" },
  strategy: "FLAT",
  minValue: null,
  maxValue: null,
  priceGross: toMinor(2_500_000),
  currency: "COP",
  freeOverSubtotal: null,
  isActive: true,
  transitDaysMin: 1,
  transitDaysMax: 2,
};

interface Fakes {
  calls: string[];
  executeRaw: Mock;
  zone: { findMany: Mock; findFirst: Mock; create: Mock; update: Mock; updateMany: Mock };
  rate: { findMany: Mock; findFirst: Mock; create: Mock; update: Mock; updateMany: Mock };
  taxRate: { findMany: Mock };
}

/**
 * One client object serves as both the root client and the transaction
 * client; `calls` records the order across all of them, which is what the
 * lock-before-check assertion reads.
 */
function fakes(): Fakes {
  const calls: string[] = [];
  const track = (name: string, impl: (...args: unknown[]) => unknown): Mock =>
    vi.fn(async (...args: unknown[]) => {
      calls.push(name);
      return impl(...args);
    });
  return {
    calls,
    executeRaw: track("lock", () => 1),
    zone: {
      findMany: track("zone.findMany", () => []),
      findFirst: track("zone.findFirst", () => zoneRow()),
      create: track("zone.create", () => zoneRow()),
      update: track("zone.update", () => zoneRow()),
      updateMany: track("zone.updateMany", () => ({ count: 1 })),
    },
    rate: {
      findMany: track("rate.findMany", () => []),
      findFirst: track("rate.findFirst", () => rateRow()),
      create: track("rate.create", () => rateRow()),
      update: track("rate.update", () => rateRow()),
      updateMany: track("rate.updateMany", () => ({ count: 1 })),
    },
    taxRate: {
      findMany: track("tax.findMany", (...args: unknown[]) => {
        // By default every asked-for country is taxed.
        const where = (args[0] as { where: { countryCode: { in: string[] } } }).where;
        return where.countryCode.in.map((countryCode) => ({ countryCode }));
      }),
    },
  };
}

async function build(f: Fakes): Promise<AdminShippingService> {
  const client = {
    $executeRaw: f.executeRaw,
    shippingZone: f.zone,
    shippingRate: f.rate,
    taxRate: f.taxRate,
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client)),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [AdminShippingService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(AdminShippingService);
}

async function refusal(promise: Promise<unknown>): Promise<ShippingAdminError> {
  const error: unknown = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof ShippingAdminError)) {
    throw new Error(`expected a ShippingAdminError, got ${String(error)}`);
  }
  return error;
}

describe("AdminShippingService — zones", () => {
  let f: Fakes;
  let service: AdminShippingService;

  beforeEach(async () => {
    f = fakes();
    service = await build(f);
  });

  it("takes the zone-write lock BEFORE checking for overlap, inside one transaction", async () => {
    await service.createZone({ name: "Irlanda", countryCodes: ["IE"], sortOrder: 2 });

    expect(f.calls.slice(0, 3)).toEqual(["lock", "zone.findMany", "tax.findMany"]);
    expect(f.calls.indexOf("zone.create")).toBeGreaterThan(f.calls.indexOf("zone.findMany"));
  });

  it("refuses a country another live zone holds, naming it in the log message", async () => {
    f.zone.findMany.mockResolvedValueOnce([
      { id: OTHER_ZONE_ID, name: "Unión Europea", countryCodes: ["PT", "FR", "IE"] },
    ]);

    const error = await refusal(
      service.createZone({ name: "Irlanda", countryCodes: ["IE"], sortOrder: 2 }),
    );

    expect(error.reason).toBe("COUNTRY_IN_OTHER_ZONE");
    expect(error.getStatus()).toBe(409);
    expect(error.message).toContain("Unión Europea");
    expect(f.zone.create).not.toHaveBeenCalled();
  });

  it("looks for overlap only among OTHER live zones when updating", async () => {
    await service.updateZone(ZONE_ID, { countryCodes: ["ES", "PT"] });

    expect(f.zone.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null, countryCodes: { hasSome: ["ES", "PT"] }, id: { not: ZONE_ID } },
    });
  });

  it("refuses a zone gaining a country with no current STANDARD tax rate", async () => {
    f.taxRate.findMany.mockResolvedValueOnce([]);

    const error = await refusal(service.updateZone(ZONE_ID, { countryCodes: ["ES", "AT"] }));

    expect(error.reason).toBe("TAX_RATE_MISSING");
    expect(error.message).toContain("AT");
    // Only the country being ADDED is checked: ES was already in the zone.
    expect(f.taxRate.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { countryCode: { in: ["AT"] }, taxClass: "STANDARD" },
    });
    expect(f.zone.update).not.toHaveBeenCalled();
  });

  it("does not re-check tax when the countries do not change", async () => {
    await service.updateZone(ZONE_ID, { name: "Península" });

    expect(f.taxRate.findMany).not.toHaveBeenCalled();
    expect(f.zone.findMany).not.toHaveBeenCalled();
  });

  it("404s an update of a zone that is gone", async () => {
    f.zone.findFirst.mockResolvedValueOnce(null);

    await expect(service.updateZone(ZONE_ID, { name: "X" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("soft-deletes a zone together with its live rates", async () => {
    await service.deleteZone(ZONE_ID);

    const zoneWrite = f.zone.updateMany.mock.calls[0]?.[0] as { data: { deletedAt: Date } };
    expect(zoneWrite).toMatchObject({ where: { id: ZONE_ID, deletedAt: null } });
    expect(f.rate.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { zoneId: ZONE_ID, deletedAt: null },
      data: { deletedAt: zoneWrite.data.deletedAt },
    });
  });

  it("lists live zones with their live rates, projected to the admin shape", async () => {
    f.zone.findMany.mockResolvedValueOnce([{ ...zoneRow(), rates: [rateRow()] }]);

    const { zones } = await service.listZones();

    expect(f.zone.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null },
      include: { rates: { where: { deletedAt: null } } },
    });
    expect(zones[0]).toMatchObject({
      id: ZONE_ID,
      countryCodes: ["ES"],
      createdAt: T0.toISOString(),
      rates: [{ id: RATE_ID, priceGross: 1_500_000, transitDaysMin: 2, transitDaysMax: 5 }],
    });
  });
});

describe("AdminShippingService — rates", () => {
  let f: Fakes;
  let service: AdminShippingService;

  beforeEach(async () => {
    f = fakes();
    service = await build(f);
  });

  it("stores a Spanish-only name without inventing an English one", async () => {
    await service.createRate(ZONE_ID, newRate);

    expect(f.rate.create.mock.calls[0]?.[0]).toMatchObject({
      data: { zoneId: ZONE_ID, name: { es: "Envío express" }, priceGross: 2_500_000 },
    });
    const data = (f.rate.create.mock.calls[0]?.[0] as { data: { name: object } }).data;
    expect(data.name).not.toHaveProperty("en");
  });

  it("re-checks the MERGED row: a PATCH of maxValue alone cannot invert the stored min", async () => {
    f.rate.findFirst.mockResolvedValueOnce(
      rateRow({ strategy: "WEIGHT", minValue: 1_000, maxValue: 2_000 }),
    );

    const error = await refusal(service.updateRate(ZONE_ID, RATE_ID, { maxValue: 500 }));

    expect(error.reason).toBe("INVALID_BOUNDS");
    expect(f.rate.update).not.toHaveBeenCalled();
  });

  it("refuses transit days that invert against the stored ones", async () => {
    const error = await refusal(service.updateRate(ZONE_ID, RATE_ID, { transitDaysMin: 6 }));
    expect(error.reason).toBe("INVALID_TRANSIT_DAYS");
  });

  it("deactivates a rate with an isActive-only PATCH and writes nothing else", async () => {
    await service.updateRate(ZONE_ID, RATE_ID, { isActive: false });

    expect(f.rate.update.mock.calls[0]?.[0]).toEqual({
      where: { id: RATE_ID },
      data: { isActive: false },
    });
  });

  it("only edits a rate through its own live zone", async () => {
    f.rate.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.updateRate(OTHER_ZONE_ID, RATE_ID, { isActive: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.rate.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: RATE_ID, zoneId: OTHER_ZONE_ID, deletedAt: null, zone: { deletedAt: null } },
    });
  });

  it("soft-deletes a rate (never a hard delete: orders reference it)", async () => {
    await service.deleteRate(ZONE_ID, RATE_ID);

    const write = f.rate.updateMany.mock.calls[0]?.[0] as {
      where: unknown;
      data: { deletedAt: unknown };
    };
    expect(write.where).toEqual({ id: RATE_ID, zoneId: ZONE_ID, deletedAt: null });
    expect(write.data.deletedAt).toBeInstanceOf(Date);
  });

  it("404s deleting a rate that is already gone", async () => {
    f.rate.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.deleteRate(ZONE_ID, RATE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses to create a rate in a zone that is gone", async () => {
    f.zone.findFirst.mockResolvedValueOnce(null);

    await expect(service.createRate(ZONE_ID, newRate)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.rate.create).not.toHaveBeenCalled();
  });
});

describe("assertRateCoherent", () => {
  const base = {
    strategy: "WEIGHT" as const,
    minValue: 0,
    maxValue: 1_000,
    transitDaysMin: 1,
    transitDaysMax: 2,
  };

  it("accepts an open-ended or well-ordered bracket", () => {
    expect(() => assertRateCoherent(base)).not.toThrow();
    expect(() => assertRateCoherent({ ...base, maxValue: null })).not.toThrow();
    expect(() => assertRateCoherent({ ...base, minValue: null })).not.toThrow();
  });

  function reasonThrown(run: () => void): string | null {
    try {
      run();
      return null;
    } catch (error: unknown) {
      return error instanceof ShippingAdminError ? error.reason : "not a ShippingAdminError";
    }
  }

  it("refuses min ≥ max and any bound on a FLAT rate", () => {
    expect(reasonThrown(() => assertRateCoherent({ ...base, minValue: 1_000 }))).toBe("INVALID_BOUNDS");
    expect(reasonThrown(() => assertRateCoherent({ ...base, strategy: "FLAT" }))).toBe("INVALID_BOUNDS");
    expect(() =>
      assertRateCoherent({ ...base, strategy: "FLAT", minValue: null, maxValue: null }),
    ).not.toThrow();
  });
});
