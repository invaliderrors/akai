import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@akai/db";
import { describe, expect, it, vi } from "vitest";

import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import { AffiliateAdminService } from "./affiliate-admin.service";

type Mock = ReturnType<typeof vi.fn>;

const AFFILIATE_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "99999999-9999-4999-8999-999999999999";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AFFILIATE_ID,
    name: "Ana García",
    country: "ES",
    socialHandle: "@ana.recovers",
    email: "ana@example.com",
    customerId: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

interface Fakes {
  affiliate: {
    findUnique: Mock;
    findMany: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  discount: { findMany: Mock };
  customer: { create: Mock; findUnique: Mock; update: Mock };
  transaction: Mock;
  queryRaw: Mock;
  auth: { requestPasswordReset: Mock };
}

async function buildService(
  overrides: Partial<{
    affiliate: Partial<Fakes["affiliate"]>;
    discount: Partial<Fakes["discount"]>;
    customer: Partial<Fakes["customer"]>;
    statsRows: readonly Record<string, unknown>[];
  }> = {},
): Promise<{ service: AffiliateAdminService; fakes: Fakes }> {
  const affiliate: Fakes["affiliate"] = {
    findUnique: vi.fn(async () => row()),
    findMany: vi.fn(async () => [row()]),
    create: vi.fn(async () => row()),
    update: vi.fn(async () => row()),
    updateMany: vi.fn(async () => ({ count: 1 })),
    ...overrides.affiliate,
  };
  const discount: Fakes["discount"] = {
    findMany: vi.fn(async () => []),
    ...overrides.discount,
  };
  const customer: Fakes["customer"] = {
    create: vi.fn(async () => ({ id: CUSTOMER_ID })),
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => ({ id: CUSTOMER_ID })),
    ...overrides.customer,
  };
  const queryRaw = vi.fn(async () => overrides.statsRows ?? []);
  const auth: Fakes["auth"] = { requestPasswordReset: vi.fn(async () => ({ status: "accepted" })) };

  // A faithful-enough fake of Prisma's interactive `$transaction`: run the
  // callback against the SAME mocked `affiliate`/`customer` clients, so a
  // test asserting on `affiliate.update`/`customer.create` sees calls made
  // inside the transaction exactly as it would outside one.
  const transaction = vi.fn(
    async (fn: (tx: { affiliate: typeof affiliate; customer: typeof customer }) => unknown) =>
      fn({ affiliate, customer }),
  );

  const moduleRef = await Test.createTestingModule({
    providers: [
      AffiliateAdminService,
      {
        provide: PrismaService,
        useValue: { affiliate, discount, customer, $queryRaw: queryRaw, $transaction: transaction },
      },
      { provide: AuthService, useValue: auth },
    ],
  }).compile();

  return {
    service: moduleRef.get(AffiliateAdminService),
    fakes: { affiliate, discount, customer, transaction, queryRaw, auth },
  };
}

describe("AffiliateAdminService.create", () => {
  it("stores the four fields the request named", async () => {
    const { service, fakes } = await buildService();

    await service.create({
      name: "Ana García",
      country: "ES",
      socialHandle: "@ana.recovers",
      email: "ana@example.com",
    });

    expect(fakes.affiliate.create).toHaveBeenCalledWith({
      data: {
        name: "Ana García",
        country: "ES",
        socialHandle: "@ana.recovers",
        email: "ana@example.com",
      },
    });
  });

  it("returns a fresh affiliate with zero stats — nothing has redeemed a code that does not exist yet", async () => {
    const { service } = await buildService();

    const created = await service.create({
      name: "Ana García",
      country: "ES",
      socialHandle: "@ana.recovers",
      email: "ana@example.com",
    });

    expect(created.discountCodes).toEqual([]);
    expect(created.redemptionCount).toBe(0);
    expect(created.revenueMinor).toBe(0);
  });
});

describe("AffiliateAdminService.get", () => {
  it("404s a missing affiliate rather than a raw Prisma null", async () => {
    const { service } = await buildService({ affiliate: { findUnique: vi.fn(async () => null) } });

    await expect(service.get(AFFILIATE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("attaches every LIVE coupon code currently assigned, in code order", async () => {
    const { service } = await buildService({
      discount: {
        findMany: vi.fn(async () => [
          { affiliateId: AFFILIATE_ID, code: "AMIGO10" },
          { affiliateId: AFFILIATE_ID, code: "AMIGO20" },
        ]),
      },
    });

    const affiliate = await service.get(AFFILIATE_ID);

    expect(affiliate.discountCodes).toEqual(["AMIGO10", "AMIGO20"]);
  });

  it("reports redemption count and revenue from the stats query", async () => {
    const { service } = await buildService({
      statsRows: [{ affiliateId: AFFILIATE_ID, redemptionCount: 12, revenueMinor: 45_600 }],
    });

    const affiliate = await service.get(AFFILIATE_ID);

    expect(affiliate.redemptionCount).toBe(12);
    expect(affiliate.revenueMinor).toBe(45_600);
  });

  it("reports zero stats, not a crash, for an affiliate the stats query returned no row for", async () => {
    const { service } = await buildService({ statsRows: [] });

    const affiliate = await service.get(AFFILIATE_ID);

    expect(affiliate.redemptionCount).toBe(0);
    expect(affiliate.revenueMinor).toBe(0);
  });
});

describe("AffiliateAdminService.list", () => {
  it("fetches stats and discount codes for the WHOLE page in one round trip each, not one per row", async () => {
    const { service, fakes } = await buildService({
      affiliate: {
        findMany: vi.fn(async () => [
          row({ id: "11111111-1111-4111-8111-111111111111" }),
          row({ id: "22222222-2222-4222-8222-222222222222" }),
        ]),
      },
    });

    await service.list({ includeDeleted: false, limit: 25 });

    expect(fakes.queryRaw).toHaveBeenCalledTimes(1);
    expect(fakes.discount.findMany).toHaveBeenCalledTimes(1);
  });

  it("paginates with a cursor, the same shape DiscountAdminService.list uses", async () => {
    const rows = Array.from({ length: 26 }, (_unused, index) =>
      row({ id: `id-${String(index)}` }),
    );
    const { service } = await buildService({ affiliate: { findMany: vi.fn(async () => rows) } });

    const page = await service.list({ includeDeleted: false, limit: 25 });

    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("id-24");
  });
});

describe("AffiliateAdminService.update", () => {
  it("leaves an omitted field untouched", async () => {
    const { service, fakes } = await buildService();

    await service.update(AFFILIATE_ID, { name: "New Name" });

    expect(fakes.affiliate.update).toHaveBeenCalledWith({
      where: { id: AFFILIATE_ID },
      data: { name: "New Name" },
    });
  });

  it("404s an update to an affiliate that does not exist", async () => {
    const { service } = await buildService({ affiliate: { findUnique: vi.fn(async () => null) } });

    await expect(service.update(AFFILIATE_ID, { name: "New Name" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("does NOT touch the customer table when there is no linked login", async () => {
    const { service, fakes } = await buildService();

    await service.update(AFFILIATE_ID, { email: "new@example.com" });

    expect(fakes.customer.update).not.toHaveBeenCalled();
  });

  it("syncs the linked customer's email so a later resend does not silently no-op against a stale address", async () => {
    const { service, fakes } = await buildService({
      affiliate: {
        findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID })),
        update: vi.fn(async () =>
          row({ customerId: CUSTOMER_ID, email: "new@example.com" }),
        ),
      },
    });

    await service.update(AFFILIATE_ID, { email: "new@example.com" });

    expect(fakes.customer.update).toHaveBeenCalledWith({
      where: { id: CUSTOMER_ID },
      data: { email: "new@example.com" },
    });
  });

  it("does not touch the customer table when a field OTHER than email changes", async () => {
    const { service, fakes } = await buildService({
      affiliate: { findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID })) },
    });

    await service.update(AFFILIATE_ID, { name: "New Name" });

    expect(fakes.customer.update).not.toHaveBeenCalled();
  });

  it("does not touch the customer table when the email is set to its own current value", async () => {
    const { service, fakes } = await buildService({
      affiliate: {
        findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID, email: "ana@example.com" })),
        update: vi.fn(async () => row({ customerId: CUSTOMER_ID, email: "ana@example.com" })),
      },
    });

    await service.update(AFFILIATE_ID, { email: "ana@example.com" });

    expect(fakes.customer.update).not.toHaveBeenCalled();
  });

  it("turns a colliding email (already an unrelated customer's) into a 409, rolling back the whole edit", async () => {
    const { service } = await buildService({
      affiliate: {
        findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID })),
        update: vi.fn(async () => row({ customerId: CUSTOMER_ID, email: "taken@example.com" })),
      },
      customer: {
        update: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.0.0",
          });
        }),
      },
    });

    await expect(
      service.update(AFFILIATE_ID, { email: "taken@example.com" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("AffiliateAdminService.softDelete", () => {
  it("soft-deletes rather than removing the row", async () => {
    const { service, fakes } = await buildService();

    await service.softDelete(AFFILIATE_ID);

    const call = fakes.affiliate.updateMany.mock.calls[0]?.[0] as
      | { where: unknown; data: { deletedAt: unknown } }
      | undefined;
    expect(call?.where).toEqual({ id: AFFILIATE_ID, deletedAt: null });
    expect(call?.data.deletedAt).toBeInstanceOf(Date);
  });

  it("404s deleting an affiliate that is already gone, rather than pretending it worked", async () => {
    const { service } = await buildService({
      affiliate: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });

    await expect(service.softDelete(AFFILIATE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("AffiliateAdminService.activatePartnerLogin", () => {
  it("creates a PARTNER customer with no password, links it, and sends the reset email", async () => {
    const { service, fakes } = await buildService();

    const result = await service.activatePartnerLogin(AFFILIATE_ID);

    expect(fakes.customer.create).toHaveBeenCalledWith({
      data: {
        email: "ana@example.com",
        passwordHash: null,
        firstName: "Ana García",
        role: "PARTNER",
      },
    });
    expect(fakes.affiliate.update).toHaveBeenCalledWith({
      where: { id: AFFILIATE_ID },
      data: { customerId: CUSTOMER_ID },
    });
    expect(fakes.auth.requestPasswordReset).toHaveBeenCalledWith("ana@example.com");
    expect(result).toEqual({ active: true, email: "ana@example.com" });
  });

  it("404s activating a login for an affiliate that does not exist", async () => {
    const { service } = await buildService({ affiliate: { findUnique: vi.fn(async () => null) } });

    await expect(service.activatePartnerLogin(AFFILIATE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuses to activate a login for a soft-deleted affiliate", async () => {
    const { service, fakes } = await buildService({
      affiliate: { findUnique: vi.fn(async () => row({ deletedAt: new Date() })) },
    });

    await expect(service.activatePartnerLogin(AFFILIATE_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fakes.customer.create).not.toHaveBeenCalled();
  });

  it("does not recreate a customer for an already-active login — it just resends the email", async () => {
    const { service, fakes } = await buildService({
      affiliate: { findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID })) },
    });

    const result = await service.activatePartnerLogin(AFFILIATE_ID);

    expect(fakes.customer.create).not.toHaveBeenCalled();
    expect(fakes.auth.requestPasswordReset).toHaveBeenCalledWith("ana@example.com");
    expect(result).toEqual({ active: true, email: "ana@example.com" });
  });

  it("turns a unique-constraint race (email already belongs to another customer) into a 409, not a 500", async () => {
    const { service } = await buildService({
      customer: {
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.0.0",
          });
        }),
      },
    });

    await expect(service.activatePartnerLogin(AFFILIATE_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("AffiliateAdminService.statsForPartnerByCustomerId", () => {
  it("resolves the affiliate from the customer id, never from a client-supplied affiliate id", async () => {
    const { service, fakes } = await buildService({
      affiliate: { findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID })) },
      discount: { findMany: vi.fn(async () => [{ affiliateId: AFFILIATE_ID, code: "AMIGO10" }]) },
      statsRows: [{ affiliateId: AFFILIATE_ID, redemptionCount: 7, revenueMinor: 123_00 }],
    });

    const stats = await service.statsForPartnerByCustomerId(CUSTOMER_ID);

    expect(fakes.affiliate.findUnique).toHaveBeenCalledWith({ where: { customerId: CUSTOMER_ID } });
    expect(stats).toEqual({ discountCodes: ["AMIGO10"], redemptionCount: 7 });
  });

  it("never includes revenue — the partner view is a narrower TYPE, not just a hidden field", async () => {
    const { service } = await buildService({
      affiliate: { findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID })) },
      statsRows: [{ affiliateId: AFFILIATE_ID, redemptionCount: 3, revenueMinor: 999_99 }],
    });

    const stats = await service.statsForPartnerByCustomerId(CUSTOMER_ID);

    expect(stats).not.toHaveProperty("revenueMinor");
  });

  it("404s a customer with no linked affiliate row", async () => {
    const { service } = await buildService({ affiliate: { findUnique: vi.fn(async () => null) } });

    await expect(service.statsForPartnerByCustomerId(CUSTOMER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404s a customer linked to a since-deleted affiliate", async () => {
    const { service } = await buildService({
      affiliate: {
        findUnique: vi.fn(async () => row({ customerId: CUSTOMER_ID, deletedAt: new Date() })),
      },
    });

    await expect(service.statsForPartnerByCustomerId(CUSTOMER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
