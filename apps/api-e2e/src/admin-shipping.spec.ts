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
 * SHIPPING ZONES AND RATES ADMIN, AGAINST REAL POSTGRES (spec §7a).
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
    // The seed's VAT rows for the countries this suite uses — AT deliberately
    // absent, to exercise TAX_RATE_MISSING.
    await db.prisma.taxRate.createMany({
      data: [
        { countryCode: "ES", taxClass: "STANDARD", rateBps: 2100, validFrom: VALID_FROM },
        { countryCode: "PT", taxClass: "STANDARD", rateBps: 2300, validFrom: VALID_FROM },
        { countryCode: "FR", taxClass: "STANDARD", rateBps: 2000, validFrom: VALID_FROM },
        { countryCode: "IE", taxClass: "STANDARD", rateBps: 2300, validFrom: VALID_FROM },
      ],
    });
  });

  function zone(name: string, countryCodes: string[], sortOrder = 0) {
    return service.createZone(createShippingZoneSchema.parse({ name, countryCodes, sortOrder }));
  }

  async function inpostRate(zoneId: string, freeOverSubtotal: number | null = 25_000) {
    return service.createRate(
      zoneId,
      createShippingRateSchema.parse({
        name: { es: "Envío en punto de recogida INPOST", en: "InPost pickup point" },
        strategy: "FLAT",
        priceGross: 899,
        freeOverSubtotal,
        deliveryType: "SERVICE_POINT",
        carrierCode: "inpost_es",
        sendcloudOptionCode: "inpost_es:service_point,national_c2c",
        transitDaysMin: 1,
        transitDaysMax: 2,
      }),
    );
  }

  it("round-trips zones and rates: create, list, edit, deactivate, soft-delete", async () => {
    const spain = await zone("España", ["ES"]);
    const rate = await inpostRate(spain.id);

    let listed = await service.listZones();
    expect(listed.zones).toHaveLength(1);
    expect(listed.zones[0]?.rates.map((row) => row.id)).toEqual([rate.id]);

    const renamed = await service.updateZone(spain.id, { name: "Península", sortOrder: 3 });
    expect(renamed).toMatchObject({ name: "Península", sortOrder: 3, countryCodes: ["ES"] });

    const repriced = await service.updateRate(spain.id, rate.id, {
      priceGross: toMinor(999),
      name: { es: "InPost" },
    });
    expect(repriced.priceGross).toBe(999);
    // PATCHing the name replaces it: the English copy is gone, not merged back.
    expect(repriced.name).toEqual({ es: "InPost" });

    const inactive = await service.updateRate(spain.id, rate.id, { isActive: false });
    expect(inactive.isActive).toBe(false);
    // An inactive rate is still listed for staff — they must be able to turn it back on.
    listed = await service.listZones();
    expect(listed.zones[0]?.rates).toHaveLength(1);

    await service.deleteRate(spain.id, rate.id);
    listed = await service.listZones();
    expect(listed.zones[0]?.rates).toEqual([]);
    // SOFT: the row is still there for every order that snapshotted it.
    const row = await db.prisma.shippingRate.findUnique({ where: { id: rate.id } });
    expect(row?.deletedAt).toBeInstanceOf(Date);

    await service.deleteZone(spain.id);
    expect((await service.listZones()).zones).toEqual([]);
    // The country is free again once its zone is gone.
    await expect(zone("España 2", ["ES"])).resolves.toMatchObject({ countryCodes: ["ES"] });
  });

  it("keeps a country in one live zone, and names the reason when it refuses", async () => {
    const spain = await zone("España", ["ES"]);
    const europe = await zone("Unión Europea", ["PT", "FR"], 1);

    expect(await reasonOf(zone("Península", ["ES", "PT"]))).toBe("COUNTRY_IN_OTHER_ZONE");
    expect(await reasonOf(service.updateZone(europe.id, { countryCodes: ["PT", "FR", "ES"] }))).toBe(
      "COUNTRY_IN_OTHER_ZONE",
    );
    // A zone keeping its OWN countries is not a conflict with itself.
    await expect(service.updateZone(spain.id, { countryCodes: ["ES"] })).resolves.toBeDefined();
  });

  it("serialises two writers racing for the same country: exactly one wins", async () => {
    const results = await Promise.allSettled([
      zone("Irlanda A", ["IE"]),
      zone("Irlanda B", ["IE"]),
      zone("Irlanda C", ["IE"]),
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
      where: { deletedAt: null, countryCodes: { has: "IE" } },
    });
    expect(holders).toBe(1);
  });

  it("refuses a country the shipping tax resolver could not tax", async () => {
    expect(await reasonOf(zone("Austria", ["AT"]))).toBe("TAX_RATE_MISSING");
    expect(await db.prisma.shippingZone.count()).toBe(0);
  });

  it("refuses a pickup-point rate losing its carrier, against the stored row", async () => {
    const spain = await zone("España", ["ES"]);
    const rate = await inpostRate(spain.id);

    expect(await reasonOf(service.updateRate(spain.id, rate.id, { carrierCode: null }))).toBe(
      "SERVICE_POINT_NEEDS_CARRIER",
    );
  });

  it("the public free-shipping threshold reflects an edit on the next read", async () => {
    const spain = await zone("España", ["ES"]);
    const europe = await zone("Unión Europea", ["PT", "FR"], 1);
    const spainRate = await inpostRate(spain.id);
    const europeRate = await inpostRate(europe.id);

    const threshold = async () =>
      sharedFreeShippingThreshold(await repository.listOfferableRateThresholds());

    expect(await threshold()).toEqual({ amount: 25_000, currency: "EUR" });

    await service.updateRate(europe.id, europeRate.id, {
      freeOverSubtotal: toMinor(30_000),
    });
    // The rates disagree now, so there is no destination-independent figure.
    expect(await threshold()).toBeNull();

    await service.updateRate(spain.id, spainRate.id, {
      freeOverSubtotal: toMinor(30_000),
    });
    expect(await threshold()).toEqual({ amount: 30_000, currency: "EUR" });

    // A deleted zone's rates stop defining it.
    await service.updateRate(spain.id, spainRate.id, { freeOverSubtotal: null });
    expect(await threshold()).toBeNull();
    await service.deleteZone(spain.id);
    expect(await threshold()).toEqual({ amount: 30_000, currency: "EUR" });
  });
});
