import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { PrismaService } from "../prisma/prisma.service";
import { DiscountAdminService } from "./discount-admin.service";

type Mock = ReturnType<typeof vi.fn>;

interface DiscountFake {
  findUnique: Mock;
  findMany: Mock;
  create: Mock;
  update: Mock;
  updateMany: Mock;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    code: "SAVE10",
    type: "PERCENTAGE",
    value: 1000,
    minimumSubtotal: null,
    currency: null,
    maxRedemptions: 100,
    maxRedemptionsPerCustomer: null,
    timesRedeemed: 40,
    stackable: false,
    startsAt: null,
    endsAt: null,
    affiliateId: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

async function buildService(
  discount: Partial<DiscountFake> = {},
): Promise<{ service: DiscountAdminService; discount: DiscountFake }> {
  const fake: DiscountFake = {
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => row()),
    update: vi.fn(async () => row()),
    updateMany: vi.fn(async () => ({ count: 1 })),
    ...discount,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      DiscountAdminService,
      { provide: PrismaService, useValue: { discount: fake } },
    ],
  }).compile();

  return { service: moduleRef.get(DiscountAdminService), discount: fake };
}

describe("DiscountAdminService", () => {
  it("stores the code upper-cased so lookups can never miss on case", async () => {
    const { service, discount } = await buildService({
      create: vi.fn(async () => row({ code: "SUMMER" })),
    });

    await service.create({
      code: "summer",
      type: "FIXED_AMOUNT",
      value: 500,
      minimumSubtotal: null,
      currency: null,
      maxRedemptions: null,
      maxRedemptionsPerCustomer: null,
      stackable: false,
      startsAt: null,
      endsAt: null,
      affiliateId: null,
    });

    expect(discount.create.mock.calls[0]?.[0]).toMatchObject({
      data: { code: "SUMMER" },
    });
  });

  it("rejects a duplicate code with a 409 rather than a raw database error", async () => {
    const { service } = await buildService({
      findUnique: vi.fn(async () => row()),
    });

    await expect(
      service.create({
        code: "SAVE10",
        type: "PERCENTAGE",
        value: 1000,
        minimumSubtotal: null,
        currency: null,
        maxRedemptions: null,
        maxRedemptionsPerCustomer: null,
        stackable: false,
        startsAt: null,
        endsAt: null,
        affiliateId: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("projects usage stats: timesRedeemed and remaining allowance", async () => {
    const { service } = await buildService({
      findMany: vi.fn(async () => [row({ timesRedeemed: 40, maxRedemptions: 100 })]),
    });

    const page = await service.list({ limit: 24, includeDeleted: false });

    expect(page.items[0]).toMatchObject({
      timesRedeemed: 40,
      remainingRedemptions: 60,
    });
  });

  it("reports null remaining for an uncapped code", async () => {
    const { service } = await buildService({
      findMany: vi.fn(async () => [row({ maxRedemptions: null, timesRedeemed: 5 })]),
    });

    const page = await service.list({ limit: 24, includeDeleted: false });
    expect(page.items[0]?.remainingRedemptions).toBeNull();
  });

  it("excludes soft-deleted codes unless explicitly included", async () => {
    const { service, discount } = await buildService();

    await service.list({ limit: 24, includeDeleted: false });
    expect(discount.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null },
    });

    await service.list({ limit: 24, includeDeleted: true });
    expect(discount.findMany.mock.calls[1]?.[0]).toMatchObject({ where: {} });
  });

  it("404s when soft-deleting a code that is already gone", async () => {
    const { service } = await buildService({
      updateMany: vi.fn(async () => ({ count: 0 })),
    });

    await expect(service.softDelete("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
