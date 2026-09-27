import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@akai/db";
import { describe, expect, it, vi } from "vitest";

import { PrismaService } from "../prisma/prisma.service";
import { AffiliateLinksService } from "./affiliate-links.service";

type Mock = ReturnType<typeof vi.fn>;

const AFFILIATE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AFFILIATE_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";

function affiliateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: AFFILIATE_ID, deletedAt: null, ...overrides };
}

function linkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LINK_ID,
    affiliateId: AFFILIATE_ID,
    slug: "ana-recovers",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

interface Fakes {
  affiliate: { findUnique: Mock };
  affiliateLink: { create: Mock; findMany: Mock; findUnique: Mock; updateMany: Mock };
  affiliateLinkClick: { create: Mock };
  discount: { findMany: Mock };
}

async function buildService(
  overrides: Partial<{
    affiliate: Partial<Fakes["affiliate"]>;
    affiliateLink: Partial<Fakes["affiliateLink"]>;
    affiliateLinkClick: Partial<Fakes["affiliateLinkClick"]>;
    discount: Partial<Fakes["discount"]>;
  }> = {},
): Promise<{ service: AffiliateLinksService; fakes: Fakes }> {
  const affiliate: Fakes["affiliate"] = {
    findUnique: vi.fn(async () => affiliateRow()),
    ...overrides.affiliate,
  };
  const affiliateLink: Fakes["affiliateLink"] = {
    create: vi.fn(async () => linkRow()),
    findMany: vi.fn(async () => [{ ...linkRow(), _count: { clicks: 0 } }]),
    findUnique: vi.fn(async () => linkRow()),
    updateMany: vi.fn(async () => ({ count: 1 })),
    ...overrides.affiliateLink,
  };
  const affiliateLinkClick: Fakes["affiliateLinkClick"] = {
    create: vi.fn(async () => ({ id: "click-1" })),
    ...overrides.affiliateLinkClick,
  };
  const discount: Fakes["discount"] = {
    findMany: vi.fn(async () => []),
    ...overrides.discount,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AffiliateLinksService,
      { provide: PrismaService, useValue: { affiliate, affiliateLink, affiliateLinkClick, discount } },
    ],
  }).compile();

  return {
    service: moduleRef.get(AffiliateLinksService),
    fakes: { affiliate, affiliateLink, affiliateLinkClick, discount },
  };
}

describe("AffiliateLinksService.create", () => {
  /**
   * `/blog` is a real storefront route (spec 2026-09-24 §8). A partner link
   * claiming it would be shadowed by the static route — the partner's link
   * would silently land on the blog and never credit them.
   */
  it.each(["blog", "products", "cart"])("refuses the reserved storefront route %s", async (slug) => {
    const { service, fakes } = await buildService();

    await expect(service.create(AFFILIATE_ID, { slug })).rejects.toBeInstanceOf(ConflictException);
    expect(fakes.affiliateLink.create).not.toHaveBeenCalled();
  });

  it("creates a link scoped to the affiliate", async () => {
    const { service, fakes } = await buildService();

    await service.create(AFFILIATE_ID, { slug: "ana-recovers" });

    expect(fakes.affiliateLink.create).toHaveBeenCalledWith({
      data: { affiliateId: AFFILIATE_ID, slug: "ana-recovers" },
    });
  });

  it("404s creating a link for an affiliate that does not exist", async () => {
    const { service } = await buildService({ affiliate: { findUnique: vi.fn(async () => null) } });

    await expect(service.create(AFFILIATE_ID, { slug: "ana-recovers" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404s creating a link for a soft-deleted affiliate", async () => {
    const { service } = await buildService({
      affiliate: { findUnique: vi.fn(async () => affiliateRow({ deletedAt: new Date() })) },
    });

    await expect(service.create(AFFILIATE_ID, { slug: "ana-recovers" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuses a slug that collides with a real storefront route", async () => {
    const { service, fakes } = await buildService();

    await expect(service.create(AFFILIATE_ID, { slug: "checkout" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fakes.affiliateLink.create).not.toHaveBeenCalled();
  });

  it("refuses a slug that collides with a locale prefix", async () => {
    const { service } = await buildService();

    await expect(service.create(AFFILIATE_ID, { slug: "en" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("turns a duplicate-slug unique violation into a 409, not a 500", async () => {
    const { service } = await buildService({
      affiliateLink: {
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.0.0",
          });
        }),
      },
    });

    await expect(service.create(AFFILIATE_ID, { slug: "ana-recovers" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("AffiliateLinksService.list", () => {
  it("excludes soft-deleted links by default", async () => {
    const { service, fakes } = await buildService();

    await service.list(AFFILIATE_ID, { includeDeleted: false });

    expect(fakes.affiliateLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { affiliateId: AFFILIATE_ID, deletedAt: null } }),
    );
  });

  it("includes soft-deleted links when asked", async () => {
    const { service, fakes } = await buildService();

    await service.list(AFFILIATE_ID, { includeDeleted: true });

    expect(fakes.affiliateLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { affiliateId: AFFILIATE_ID } }),
    );
  });

  it("reports the click count from the live COUNT, not a stored column", async () => {
    const { service } = await buildService({
      affiliateLink: {
        findMany: vi.fn(async () => [{ ...linkRow(), _count: { clicks: 42 } }]),
      },
    });

    const links = await service.list(AFFILIATE_ID, { includeDeleted: false });

    expect(links[0]?.clickCount).toBe(42);
  });
});

describe("AffiliateLinksService.softDelete", () => {
  it("scopes the delete to BOTH the link id and the affiliate id — a link cannot be deleted via a mismatched affiliate id", async () => {
    const { service, fakes } = await buildService();

    await service.softDelete(AFFILIATE_ID, LINK_ID);

    const call = fakes.affiliateLink.updateMany.mock.calls[0]?.[0] as
      | { where: unknown; data: { deletedAt: unknown } }
      | undefined;
    expect(call?.where).toEqual({ id: LINK_ID, affiliateId: AFFILIATE_ID, deletedAt: null });
    expect(call?.data.deletedAt).toBeInstanceOf(Date);
  });

  it("404s deleting a link that belongs to a different affiliate", async () => {
    const { service } = await buildService({
      affiliateLink: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });

    await expect(service.softDelete(OTHER_AFFILIATE_ID, LINK_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("AffiliateLinksService.resolveVisit", () => {
  it("returns null for an unknown slug", async () => {
    const { service } = await buildService({
      affiliateLink: { findUnique: vi.fn(async () => null) },
    });

    expect(await service.resolveVisit("nope")).toBeNull();
  });

  it("returns null for a soft-deleted link, and records no click", async () => {
    const { service, fakes } = await buildService({
      affiliateLink: { findUnique: vi.fn(async () => linkRow({ deletedAt: new Date() })) },
    });

    expect(await service.resolveVisit("ana-recovers")).toBeNull();
    expect(fakes.affiliateLinkClick.create).not.toHaveBeenCalled();
  });

  it("records exactly one click for a live link", async () => {
    const { service, fakes } = await buildService();

    await service.resolveVisit("ana-recovers");

    expect(fakes.affiliateLinkClick.create).toHaveBeenCalledWith({ data: { linkId: LINK_ID } });
  });

  it("returns the affiliate's live discount code", async () => {
    const { service } = await buildService({
      discount: {
        findMany: vi.fn(async () => [
          { code: "AMIGO10", maxRedemptions: null, timesRedeemed: 0, createdAt: new Date() },
        ]),
      },
    });

    const result = await service.resolveVisit("ana-recovers");

    expect(result).toEqual({ discountCode: "AMIGO10" });
  });

  it("returns a null code when the affiliate has none active — the click is still recorded", async () => {
    const { service, fakes } = await buildService({ discount: { findMany: vi.fn(async () => []) } });

    const result = await service.resolveVisit("ana-recovers");

    expect(result).toEqual({ discountCode: null });
    expect(fakes.affiliateLinkClick.create).toHaveBeenCalledTimes(1);
  });

  it("skips an exhausted newer code in favour of an older code that still has room", async () => {
    const { service } = await buildService({
      discount: {
        findMany: vi.fn(async () => [
          {
            code: "NEWER-EXHAUSTED",
            maxRedemptions: 10,
            timesRedeemed: 10,
            createdAt: new Date("2026-08-01"),
          },
          { code: "OLDER-LIVE", maxRedemptions: null, timesRedeemed: 5, createdAt: new Date("2026-07-01") },
        ]),
      },
    });

    const result = await service.resolveVisit("ana-recovers");

    expect(result).toEqual({ discountCode: "OLDER-LIVE" });
  });
});
