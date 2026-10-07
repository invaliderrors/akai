import "reflect-metadata";

import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createShippingRateSchema,
  createShippingZoneSchema,
  toMinor,
  type AdminShippingZoneDetail,
} from "@akai/contracts";

import { PrismaService } from "../../api/src/modules/prisma/prisma.service";
import { ShippingAdminError } from "../../api/src/modules/shipping/admin/admin-shipping.errors";
import { AdminShippingService } from "../../api/src/modules/shipping/admin/admin-shipping.service";
import { sharedFreeShippingThreshold } from "../../api/src/modules/shipping/free-shipping";
import { PrismaShippingRepository } from "../../api/src/modules/shipping/shipping.repository";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * SHIPPING ZONES AND RATES ADMIN, AGAINST REAL POSTGRES.
 *
 * The unit suite proves the order of operations against a double; only a real
 * database can prove the claims that depend on Postgres:
 *
 *   - the `hasSome` overlap query and the advisory lock together keep a country
 *     in ONE live zone — including when two writers race for it;
 *   - the tax-rate check reads the same rows the shipping tax resolver does;
 *   - a full CRUD round trip, with soft deletion keeping the rate row;
 *   - the quote's own repository (the public free-shipping threshold) sees an
 *     edit on the very next read — nothing to revalidate.
 *
 * The store serves Colombia only, so the REQUEST schema refuses any other
 * country; the overlap and tax rules are generic, and the multi-zone cases
 * below call the service directly to exercise them.
 */

const VALID_FROM = new Date("2020-01-01T00:00:00.000Z");

async function reasonOf(promise: Promise<unknown>): Promise<string | null> {
  const error: unknown = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  return error instanceof ShippingAdminError ? error.reason : null;
}

describe.skipIf(!isDockerAvailable())("Admin shipping zones and rates", () => {
  let db: TestDatabase;
  let service: AdminShippingService;
  let repository: PrismaShippingRepository;

  beforeAll(async () => {
    db = await startTestDatabase();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminShippingService,
        PrismaShippingRepository,
        { provide: PrismaService, useValue: db.prisma },
      ],
    }).compile();
    service = moduleRef.get(AdminShippingService);
    repository = moduleRef.get(PrismaShippingRepository);
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.reset();
    // The seed's IVA row, plus rows for the extra countries the generic rules
    // are exercised with — AT deliberately absent, to exercise TAX_RATE_MISSING.
    await db.prisma.taxRate.createMany({
      data: [
        { countryCode: "CO", taxClass: "STANDARD", rateBps: 1900, validFrom: VALID_FROM },
        { countryCode: "ES", taxClass: "STANDARD", rateBps: 2100, validFrom: VALID_FROM },
        { countryCode: "PT", taxClass: "STANDARD", rateBps: 2300, validFrom: VALID_FROM },
        { countryCode: "FR", taxClass: "STANDARD", rateBps: 2000, validFrom: VALID_FROM },
        { countryCode: "IE", taxClass: "STANDARD", rateBps: 2300, validFrom: VALID_FROM },
      ],
    });
  });

  /** Through the request schema — Colombia only. */
  function zone(name: string, countryCodes: string[], sortOrder = 0) {
    return service.createZone(createShippingZoneSchema.parse({ name, countryCodes, sortOrder }));
  }

  /** Straight to the service, to exercise the generic rules with several countries. */
  function rawZone(name: string, countryCodes: string[], sortOrder = 0) {
    return service.createZone({ name, countryCodes, sortOrder });
  }

  async function nationalRate(zoneId: string, freeOverSubtotal: number | null = 30_000_000) {
    return service.createRate(
      zoneId,
      createShippingRateSchema.parse({
        name: { es: "Envío nacional", en: "National shipping" },
        strategy: "FLAT",
        priceGross: 1_500_000,
        freeOverSubtotal,
        transitDaysMin: 2,
        transitDaysMax: 5,
      }),
    );
  }

  it("round-trips zones and rates: create, list, edit, deactivate, soft-delete", async () => {
    const colombia = await zone("Colombia", ["CO"]);
    const rate = await nationalRate(colombia.id);

    let listed = await service.listZones();
    expect(listed.zones).toHaveLength(1);
    expect(listed.zones[0]?.rates.map((row) => row.id)).toEqual([rate.id]);

    const renamed = await service.updateZone(colombia.id, { name: "Nacional", sortOrder: 3 });
    expect(renamed).toMatchObject({ name: "Nacional", sortOrder: 3, countryCodes: ["CO"] });

    const repriced = await service.updateRate(colombia.id, rate.id, {
      priceGross: toMinor(1_800_000),
      name: { es: "Envío" },
    });
    expect(repriced.priceGross).toBe(1_800_000);
    expect(repriced.currency).toBe("COP");
    // PATCHing the name replaces it: the English copy is gone, not merged back.
    expect(repriced.name).toEqual({ es: "Envío" });

    const inactive = await service.updateRate(colombia.id, rate.id, { isActive: false });
    expect(inactive.isActive).toBe(false);
    // An inactive rate is still listed for staff — they must be able to turn it back on.
    listed = await service.listZones();
    expect(listed.zones[0]?.rates).toHaveLength(1);

    await service.deleteRate(colombia.id, rate.id);
    listed = await service.listZones();
    expect(listed.zones[0]?.rates).toEqual([]);
    // SOFT: the row is still there for every order that snapshotted it.
    const row = await db.prisma.shippingRate.findUnique({ where: { id: rate.id } });
    expect(row?.deletedAt).toBeInstanceOf(Date);

    await service.deleteZone(colombia.id);
    expect((await service.listZones()).zones).toEqual([]);
    // The country is free again once its zone is gone.
    await expect(zone("Colombia 2", ["CO"])).resolves.toMatchObject({ countryCodes: ["CO"] });
  });

  it("refuses, at the request schema, a country the store does not ship to", () => {
    expect(createShippingZoneSchema.safeParse({ name: "España", countryCodes: ["ES"] }).success).toBe(
      false,
    );
  });

  it("keeps a country in one live zone, and names the reason when it refuses", async () => {
    const spain = await rawZone("España", ["ES"]);
    const europe = await rawZone("Unión Europea", ["PT", "FR"], 1);

    expect(await reasonOf(rawZone("Península", ["ES", "PT"]))).toBe("COUNTRY_IN_OTHER_ZONE");
    expect(await reasonOf(service.updateZone(europe.id, { countryCodes: ["PT", "FR", "ES"] }))).toBe(
      "COUNTRY_IN_OTHER_ZONE",
    );
    // A zone keeping its OWN countries is not a conflict with itself.
    await expect(service.updateZone(spain.id, { countryCodes: ["ES"] })).resolves.toBeDefined();
  });

  it("serialises two writers racing for the same country: exactly one wins", async () => {
    const results = await Promise.allSettled([
      zone("Colombia A", ["CO"]),
      zone("Colombia B", ["CO"]),
      zone("Colombia C", ["CO"]),
    ]);

    const won = results.filter(
      (result): result is PromiseFulfilledResult<AdminShippingZoneDetail> =>
        result.status === "fulfilled",
    );
    const lost = results.filter((result) => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const result of lost) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(ShippingAdminError);
      }
    }
    const holders = await db.prisma.shippingZone.count({
      where: { deletedAt: null, countryCodes: { has: "CO" } },
    });
    expect(holders).toBe(1);
  });

  it("refuses a country the shipping tax resolver could not tax", async () => {
    expect(await reasonOf(rawZone("Austria", ["AT"]))).toBe("TAX_RATE_MISSING");
    expect(await db.prisma.shippingZone.count()).toBe(0);
  });

  it("re-checks transit days against the stored row", async () => {
    const colombia = await zone("Colombia", ["CO"]);
    const rate = await nationalRate(colombia.id);

    expect(await reasonOf(service.updateRate(colombia.id, rate.id, { transitDaysMin: 9 }))).toBe(
      "INVALID_TRANSIT_DAYS",
    );
  });

  it("the public free-shipping threshold reflects an edit on the next read", async () => {
    const colombia = await zone("Colombia", ["CO"]);
    const other = await rawZone("Otra", ["PT", "FR"], 1);
    const colombiaRate = await nationalRate(colombia.id);
    const otherRate = await nationalRate(other.id);

    const threshold = async () =>
      sharedFreeShippingThreshold(await repository.listOfferableRateThresholds());

    expect(await threshold()).toEqual({ amount: 30_000_000, currency: "COP" });

    await service.updateRate(other.id, otherRate.id, {
      freeOverSubtotal: toMinor(40_000_000),
    });
    // The rates disagree now, so there is no destination-independent figure.
    expect(await threshold()).toBeNull();

    await service.updateRate(colombia.id, colombiaRate.id, {
      freeOverSubtotal: toMinor(40_000_000),
    });
    expect(await threshold()).toEqual({ amount: 40_000_000, currency: "COP" });

    // A deleted zone's rates stop defining it.
    await service.updateRate(colombia.id, colombiaRate.id, { freeOverSubtotal: null });
    expect(await threshold()).toBeNull();
    await service.deleteZone(colombia.id);
    expect(await threshold()).toEqual({ amount: 40_000_000, currency: "COP" });
  });
});
