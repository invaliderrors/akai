import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Paginated } from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import {
  type AdminDiscount,
  type CreateDiscountDto,
  type ListDiscountsQuery,
  type UpdateDiscountDto,
} from "./discount-admin.dto";

/**
 * DiscountAdminService — the CRUD behind the admin coupon surface (issue SEV4).
 *
 * The discount ENGINE (validation, redemption accounting) already existed but
 * nothing let an operator create or manage a code. This is that missing surface.
 * It reads and writes the `discount` table directly rather than through the
 * DiscountsRepository port, which exists to keep the pricing rules unit-testable
 * against an in-memory double; admin CRUD is plain persistence with no such rules,
 * so a port would be ceremony.
 *
 * Codes are stored UPPER-CASE (matching how DiscountsService normalises for
 * lookup), so "SAVE10" and "save10" are the same coupon and a lookup can never
 * miss on case. Deletion is SOFT: a spent code is referenced by
 * `discount_redemption` rows forever and must not be hard-removed.
 */
@Injectable()
export class DiscountAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateDiscountDto): Promise<AdminDiscount> {
    const code = input.code.toUpperCase();

    // Pre-check for a clear 409. The `@unique` on `code` is the real guard (a
    // soft-deleted code still occupies its code), so this is a friendlier message,
    // not the correctness boundary.
    const existing = await this.prisma.discount.findUnique({ where: { code } });
    if (existing !== null) {
      throw new ConflictException(`A discount with code ${code} already exists.`);
    }

    if (input.affiliateId !== null) {
      await this.assertAffiliateExists(input.affiliateId);
    }

    const row = await this.prisma.discount.create({
      data: {
        code,
        type: input.type,
        value: input.value,
        minimumSubtotal: input.minimumSubtotal,
        currency: input.currency,
        maxRedemptions: input.maxRedemptions,
        maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer,
        stackable: input.stackable,
        startsAt: input.startsAt === null ? null : new Date(input.startsAt),
        endsAt: input.endsAt === null ? null : new Date(input.endsAt),
        affiliateId: input.affiliateId,
      },
    });

    return toAdminDiscount(row);
  }

  async list(query: ListDiscountsQuery): Promise<Paginated<AdminDiscount>> {
    const rows = await this.prisma.discount.findMany({
      where: query.includeDeleted ? {} : { deletedAt: null },
      // Two keys so the cursor is stable when two codes are created in the same
      // millisecond (a seed script does exactly that).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toAdminDiscount),
      nextCursor: hasMore && last !== undefined ? last.id : null,
      hasMore,
    };
  }

  async get(id: string): Promise<AdminDiscount> {
    const row = await this.prisma.discount.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException("Discount not found");
    }
    return toAdminDiscount(row);
  }

  async update(id: string, input: UpdateDiscountDto): Promise<AdminDiscount> {
    // Ensure it exists first, so a bad id is a clean 404 rather than a Prisma
    // "record to update not found" surfacing as a 500.
    await this.get(id);

    if (input.affiliateId !== undefined && input.affiliateId !== null) {
      await this.assertAffiliateExists(input.affiliateId);
    }

    const row = await this.prisma.discount.update({
      where: { id },
      data: {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.minimumSubtotal === undefined
          ? {}
          : { minimumSubtotal: input.minimumSubtotal }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.maxRedemptions === undefined
          ? {}
          : { maxRedemptions: input.maxRedemptions }),
        ...(input.maxRedemptionsPerCustomer === undefined
          ? {}
          : { maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer }),
        ...(input.stackable === undefined ? {} : { stackable: input.stackable }),
        ...(input.startsAt === undefined
          ? {}
          : { startsAt: input.startsAt === null ? null : new Date(input.startsAt) }),
        ...(input.endsAt === undefined
          ? {}
          : { endsAt: input.endsAt === null ? null : new Date(input.endsAt) }),
        ...(input.affiliateId === undefined ? {} : { affiliateId: input.affiliateId }),
      },
    });

    return toAdminDiscount(row);
  }

  /**
   * A friendlier 409 than the FK constraint would give, and stricter than
   * it: the FK alone would accept a SOFT-DELETED affiliate (the row still
   * physically exists), which would assign a coupon to a partner who no
   * longer appears on the live affiliates screen at all.
   */
  private async assertAffiliateExists(affiliateId: string): Promise<void> {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { id: affiliateId, deletedAt: null },
      select: { id: true },
    });
    if (affiliate === null) {
      throw new NotFoundException(`Affiliate ${affiliateId} not found`);
    }
  }

  /** Soft delete. Idempotent: a second delete affects zero rows and 404s. */
  async softDelete(id: string): Promise<void> {
    const result = await this.prisma.discount.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException("Discount not found");
    }
  }
}

interface DiscountRow {
  readonly id: string;
  readonly code: string;
  readonly type: AdminDiscount["type"];
  readonly value: number;
  readonly minimumSubtotal: number | null;
  readonly currency: string | null;
  readonly maxRedemptions: number | null;
  readonly maxRedemptionsPerCustomer: number | null;
  readonly timesRedeemed: number;
  readonly stackable: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly affiliateId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/**
 * Structural row type (not `Prisma.Discount`) so a column rename fails to compile
 * here rather than silently flowing a wrong value onto the wire, and so
 * `timesRedeemed` — the usage figure — is always projected.
 */
function toAdminDiscount(row: DiscountRow): AdminDiscount {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    minimumSubtotal: row.minimumSubtotal,
    currency: row.currency,
    maxRedemptions: row.maxRedemptions,
    maxRedemptionsPerCustomer: row.maxRedemptionsPerCustomer,
    timesRedeemed: row.timesRedeemed,
    remainingRedemptions:
      row.maxRedemptions === null
        ? null
        : Math.max(0, row.maxRedemptions - row.timesRedeemed),
    stackable: row.stackable,
    startsAt: row.startsAt === null ? null : row.startsAt.toISOString(),
    endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
    affiliateId: row.affiliateId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}
