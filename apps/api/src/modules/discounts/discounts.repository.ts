import { Injectable } from "@nestjs/common";
import type { DiscountType } from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import { DiscountError } from "./discounts.errors";

/**
 * The discounts module's read/write seam.
 *
 * A port so DiscountsService's validation rules — window, currency, minimum,
 * redemption caps — are provable against an in-memory double, and so the one
 * write that races (recording a redemption against a capped code) is isolated in
 * one implementation.
 */
export interface DiscountRecord {
  readonly id: string;
  readonly code: string;
  readonly type: DiscountType;
  readonly value: number;
  readonly minimumSubtotal: number | null;
  readonly currency: string | null;
  readonly maxRedemptions: number | null;
  readonly maxRedemptionsPerCustomer: number | null;
  readonly timesRedeemed: number;
  readonly stackable: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export interface RecordRedemptionInput {
  readonly discountId: string;
  readonly orderId: string;
  readonly customerId: string | null;
  readonly amountApplied: number;
}

export interface DiscountsRepository {
  /** A live (non-deleted) discount by code, or null. Code match is exact. */
  findActiveByCode(code: string): Promise<DiscountRecord | null>;
  /** How many times this customer has already redeemed this discount. */
  countCustomerRedemptions(discountId: string, customerId: string): Promise<number>;
  /**
   * Atomically record a redemption and consume one of the global allowance.
   * Rejects (rolls back) if the global cap would be exceeded or the order has
   * already redeemed this code.
   */
  recordRedemption(input: RecordRedemptionInput): Promise<void>;
}

export const DISCOUNTS_REPOSITORY = Symbol("DISCOUNTS_REPOSITORY");

@Injectable()
export class PrismaDiscountsRepository implements DiscountsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveByCode(code: string): Promise<DiscountRecord | null> {
    const row = await this.prisma.discount.findFirst({
      where: { code, deletedAt: null },
    });
    if (row === null) {
      return null;
    }
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
      stackable: row.stackable,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    };
  }

  countCustomerRedemptions(discountId: string, customerId: string): Promise<number> {
    return this.prisma.discountRedemption.count({ where: { discountId, customerId } });
  }

  async recordRedemption(input: RecordRedemptionInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The row-level lock the increment takes serialises concurrent redeemers,
      // so the cap check below sees the post-increment count rather than a stale
      // read — a check-then-write would let two orders both pass the last slot.
      const updated = await tx.discount.update({
        where: { id: input.discountId },
        data: { timesRedeemed: { increment: 1 } },
        select: { timesRedeemed: true, maxRedemptions: true },
      });

      if (
        updated.maxRedemptions !== null &&
        updated.timesRedeemed > updated.maxRedemptions
      ) {
        // Throwing rolls back the increment. The code is genuinely exhausted.
        throw DiscountError.usageLimitReached();
      }

      // The unique (discountId, orderId) index makes a second redemption for the
      // same order a DB error rather than a double-spend — the write races here
      // are closed in the schema, not by application checks.
      await tx.discountRedemption.create({
        data: {
          discountId: input.discountId,
          orderId: input.orderId,
          customerId: input.customerId,
          amountApplied: input.amountApplied,
        },
      });
    });
  }
}
