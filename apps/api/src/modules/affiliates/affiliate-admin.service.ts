import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@akai/db";
import { z } from "zod";
import type { Paginated } from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import {
  type AdminAffiliate,
  type CreateAffiliateDto,
  type ListAffiliatesQuery,
  type PartnerLoginStatus,
  type PartnerStats,
  type UpdateAffiliateDto,
} from "./dto/affiliate-admin.dto";

const UNIQUE_VIOLATION = "P2002";

/**
 * AffiliateAdminService — the CRUD and stats behind the admin affiliates
 * screen (§14 of `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`).
 *
 * Reads and writes the `affiliate`/`discount` tables directly, matching
 * `DiscountAdminService`'s own reasoning: this is plain persistence with no
 * pricing rules to keep unit-testable behind a port. Deletion is SOFT —
 * `Discount.affiliateId` is `onDelete: Restrict`, so a hard delete of an
 * affiliate still holding a coupon would fail the write outright; soft
 * delete sidesteps that entirely and keeps the row for any coupon still
 * pointing at it.
 *
 * STATS ARE COMPUTED, NEVER STORED. `redemptionCount` and `revenueMinor`
 * come from a JOIN across `discount` → `discount_redemption` → `order` at
 * READ time, scoped to this affiliate's CURRENT coupons — there is no
 * snapshot of which affiliate owned a coupon at the moment of each
 * redemption (see `Discount.affiliateId`'s own doc comment for why that was
 * rejected). Reassigning a coupon moves its whole history with it.
 *
 * WHICH ORDERS COUNT AS "A SALE," AND WHY. `DiscountRedemption` rows are
 * written inside the SAME transaction as `Order` creation — i.e. as soon as
 * an order is PLACED, before any payment is confirmed (`OrdersService`'s own
 * `recordDiscountRedemption`). Counting every redemption regardless of
 * status would credit an affiliate for orders that never actually paid
 * (PENDING, AWAITING_PAYMENT), that are disputed (PAYMENT_MISMATCH), or that
 * were voided (CANCELLED) — so only orders in PAID, FULFILLING, SHIPPED,
 * DELIVERED or PARTIALLY_REFUNDED are counted. A fully REFUNDED order is
 * excluded outright — its net revenue is back to zero, and counting it as
 * "a sale" this affiliate drove would overstate what actually happened.
 * `revenueMinor` sums `grandTotal - refundedTotal` for exactly those orders,
 * so a partial refund reduces the counted revenue without dropping the
 * order from the count entirely. This is a genuinely new calculation — see
 * the spec's own note that no revenue-per-code figure exists anywhere else
 * in this codebase — and it was chosen to UNDERCOUNT rather than overcount,
 * since this number may one day inform an actual commission payout.
 */
@Injectable()
export class AffiliateAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async create(input: CreateAffiliateDto): Promise<AdminAffiliate> {
    const row = await this.prisma.affiliate.create({
      data: {
        name: input.name,
        country: input.country,
        socialHandle: input.socialHandle,
        email: input.email,
      },
    });

    return this.toAdminAffiliate(row, [], { redemptionCount: 0, revenueMinor: 0 });
  }

  async list(query: ListAffiliatesQuery): Promise<Paginated<AdminAffiliate>> {
    const rows = await this.prisma.affiliate.findMany({
      where: query.includeDeleted ? {} : { deletedAt: null },
      // Two keys so the cursor is stable when two rows are created in the
      // same millisecond — the same reason `DiscountAdminService.list` gives.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    const ids = page.map((row) => row.id);
    const [discountsByAffiliate, statsByAffiliate] = await Promise.all([
      this.discountCodesFor(ids),
      this.statsFor(ids),
    ]);

    return {
      items: page.map((row) =>
        this.toAdminAffiliate(
          row,
          discountsByAffiliate.get(row.id) ?? [],
          statsByAffiliate.get(row.id) ?? { redemptionCount: 0, revenueMinor: 0 },
        ),
      ),
      nextCursor: hasMore && last !== undefined ? last.id : null,
      hasMore,
    };
  }

  async get(id: string): Promise<AdminAffiliate> {
    const row = await this.prisma.affiliate.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException("Affiliate not found");
    }

    const [discounts, stats] = await Promise.all([
      this.discountCodesFor([id]),
      this.statsFor([id]),
    ]);

    return this.toAdminAffiliate(
      row,
      discounts.get(id) ?? [],
      stats.get(id) ?? { redemptionCount: 0, revenueMinor: 0 },
    );
  }

  async update(id: string, input: UpdateAffiliateDto): Promise<AdminAffiliate> {
    // Ensure it exists first, so a bad id is a clean 404 rather than a Prisma
    // "record to update not found" surfacing as a 500 — same discipline
    // `DiscountAdminService.update` follows.
    const before = await this.get(id);

    let row: AffiliateRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.affiliate.update({
          where: { id },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.country === undefined ? {} : { country: input.country }),
            ...(input.socialHandle === undefined ? {} : { socialHandle: input.socialHandle }),
            ...(input.email === undefined ? {} : { email: input.email }),
          },
        });

        // Keeps `activatePartnerLogin`'s own invariant true AFTER an edit, not
        // just at activation: "the login's email is ALWAYS this affiliate's
        // own email." Left to drift, `Customer.email` still names whatever
        // the affiliate's email was at activation time, and a later "resend
        // password email" (`requestPasswordReset(affiliate.email)`) looks up
        // the NEW email — finding no customer (a silent no-op reported as
        // success) or, worse, an unrelated stranger who happens to hold it.
        if (
          input.email !== undefined &&
          updated.customerId !== null &&
          input.email !== before.email
        ) {
          await tx.customer.update({
            where: { id: updated.customerId },
            data: { email: input.email },
          });
        }

        return updated;
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        // Either affiliate.email collided with another affiliate, or the
        // linked customer.email collided with an unrelated customer account —
        // either way this is a real conflict an admin must resolve by hand,
        // not a partial update that leaves the login pointed at a stale email.
        throw new ConflictException("This email address is already in use.");
      }
      throw error;
    }

    const [discounts, stats] = await Promise.all([
      this.discountCodesFor([id]),
      this.statsFor([id]),
    ]);

    return this.toAdminAffiliate(
      row,
      discounts.get(id) ?? [],
      stats.get(id) ?? { redemptionCount: 0, revenueMinor: 0 },
    );
  }

  /**
   * Soft delete. Idempotent: a second delete affects zero rows and 404s.
   *
   * DELIBERATELY DOES NOT CASCADE to this affiliate's `AffiliateLink` or
   * `Discount` rows — confirmed, not merely inherited by accident. A vanity
   * link keeps tracking clicks and keeps auto-applying the affiliate's
   * discount code after this runs; only their own partner-dashboard view and
   * the admin list go dark. This mirrors the EXISTING, already-shipped
   * decision for discount codes (the admin UI's own delete-confirmation copy
   * already says "coupons still pointing at it are unchanged"); vanity links
   * were deliberately made to match rather than introduce a second, stricter
   * archive behaviour for one specific child resource. An admin who wants to
   * fully cut a partner off does so explicitly — delete the links, unassign
   * or delete the discount code — the same two-step process this already
   * required before vanity links existed.
   */
  async softDelete(id: string): Promise<void> {
    const result = await this.prisma.affiliate.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException("Affiliate not found");
    }
  }

  /**
   * Activate a partner dashboard login, or — if one is already active —
   * re-send the password-setup email. ONE endpoint for both actions, so the
   * admin UI's button always does the right thing for the row's current
   * state rather than needing two.
   *
   * The login's email is ALWAYS this affiliate's own `email` — there is no
   * separate credential-issuance step, and no email is accepted from the
   * caller. Reuses `AuthService.requestPasswordReset`, the SAME flow an
   * ordinary customer's forgotten-password link goes through, so the partner
   * sets their own first password through an already-secure, already-tested
   * token path.
   */
  async activatePartnerLogin(id: string): Promise<PartnerLoginStatus> {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { id } });
    if (affiliate === null) {
      throw new NotFoundException("Affiliate not found");
    }
    if (affiliate.deletedAt !== null) {
      throw new ConflictException("Cannot activate a login for a deleted affiliate.");
    }

    if (affiliate.customerId !== null) {
      await this.auth.requestPasswordReset(affiliate.email);
      return { active: true, email: affiliate.email };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const customer = await tx.customer.create({
          data: {
            email: affiliate.email,
            // Null, exactly like a guest-checkout shell — see `Customer.passwordHash`'s
            // own doc comment. The partner sets it themselves via the reset link below.
            passwordHash: null,
            firstName: affiliate.name,
            role: "PARTNER",
          },
        });
        await tx.affiliate.update({
          where: { id },
          data: { customerId: customer.id },
        });
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        // Either this affiliate's email already belongs to an unrelated
        // customer (a real conflict an admin must resolve by hand — silently
        // repurposing someone's existing account into a partner login would
        // be a role change nobody consented to), or two concurrent
        // activations raced. Both are the same 409 to the caller.
        throw new ConflictException(
          "A customer account already exists with this affiliate's email address.",
        );
      }
      throw error;
    }

    await this.auth.requestPasswordReset(affiliate.email);
    return { active: true, email: affiliate.email };
  }

  /**
   * The PARTNER's own stats, resolved from THEIR OWN `customerId` — never
   * from a client-supplied affiliate id. This is the entire IDOR defence for
   * the partner dashboard: `customerId` comes from `principal.customerId`,
   * re-read from the DB session on every request (see `Principal`'s own doc
   * comment), so there is no id a partner could pass to read someone else's
   * numbers.
   */
  async statsForPartnerByCustomerId(customerId: string): Promise<PartnerStats> {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { customerId } });
    if (affiliate === null || affiliate.deletedAt !== null) {
      throw new NotFoundException("No partner profile is linked to this account.");
    }

    const [discounts, stats] = await Promise.all([
      this.discountCodesFor([affiliate.id]),
      this.statsFor([affiliate.id]),
    ]);

    return {
      discountCodes: discounts.get(affiliate.id) ?? [],
      redemptionCount: (stats.get(affiliate.id) ?? { redemptionCount: 0, revenueMinor: 0 })
        .redemptionCount,
    };
  }

  /** Every LIVE coupon code currently assigned to each of the given affiliates. */
  private async discountCodesFor(
    affiliateIds: readonly string[],
  ): Promise<Map<string, readonly string[]>> {
    if (affiliateIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.discount.findMany({
      where: { affiliateId: { in: [...affiliateIds] }, deletedAt: null },
      select: { affiliateId: true, code: true },
      orderBy: { code: "asc" },
    });

    const byAffiliate = new Map<string, string[]>();
    for (const row of rows) {
      if (row.affiliateId === null) continue;
      const existing = byAffiliate.get(row.affiliateId);
      if (existing === undefined) {
        byAffiliate.set(row.affiliateId, [row.code]);
      } else {
        existing.push(row.code);
      }
    }
    return byAffiliate;
  }

  /**
   * Redemption count and net revenue per affiliate, for the given ids in ONE
   * query — not one query per affiliate. `DiscountRedemption.orderId` is not
   * a Prisma relation to `Order` (a deliberate soft FK — see that model's
   * own doc comment), so this join is raw SQL rather than a Prisma `include`.
   */
  private async statsFor(
    affiliateIds: readonly string[],
  ): Promise<Map<string, { redemptionCount: number; revenueMinor: number }>> {
    if (affiliateIds.length === 0) {
      return new Map();
    }

    // `Prisma.join`, NOT string interpolation — it emits `$1, $2, …`
    // placeholders and binds `affiliateIds` as real query parameters. This
    // list is trustworthy today (Prisma-returned ids or a validated route
    // param), but a raw SQL helper that is only safe because of who happens
    // to call it today is a vulnerability waiting for tomorrow's caller.
    const rows: unknown = await this.prisma.$queryRaw(Prisma.sql`
      SELECT
        d."affiliateId"                                             AS "affiliateId",
        COUNT(dr.id)::int                                            AS "redemptionCount",
        COALESCE(SUM(o."grandTotal" - o."refundedTotal"), 0)::bigint AS "revenueMinor"
      FROM "discount" d
      JOIN "discount_redemption" dr ON dr."discountId" = d.id
      JOIN "order" o ON o.id = dr."orderId"
      -- ::text, NOT a bare comparison: Prisma.join binds each id as a
      -- driver-inferred text parameter, and Postgres refuses uuid = text
      -- outright ("operator does not exist") rather than coercing it - this
      -- was NEVER exercised against a real Postgres instance before (every
      -- test mocks $queryRaw itself), so it 500'd on every real call.
      WHERE d."affiliateId"::text IN (${Prisma.join([...affiliateIds])})
        AND d."deletedAt" IS NULL
        AND o.status IN ('PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'PARTIALLY_REFUNDED')
      GROUP BY d."affiliateId"
    `);

    const parsed = statsRowsSchema.safeParse(rows);
    if (!parsed.success) {
      throw new Error("Affiliate stats query returned an unexpected row shape.");
    }

    const byAffiliate = new Map<string, { redemptionCount: number; revenueMinor: number }>();
    for (const row of parsed.data) {
      byAffiliate.set(row.affiliateId, {
        redemptionCount: row.redemptionCount,
        revenueMinor: row.revenueMinor,
      });
    }
    return byAffiliate;
  }

  private toAdminAffiliate(
    row: AffiliateRow,
    discountCodes: readonly string[],
    stats: { readonly redemptionCount: number; readonly revenueMinor: number },
  ): AdminAffiliate {
    return {
      id: row.id,
      name: row.name,
      country: row.country,
      socialHandle: row.socialHandle,
      email: row.email,
      discountCodes,
      redemptionCount: stats.redemptionCount,
      revenueMinor: stats.revenueMinor,
      hasLogin: row.customerId !== null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    };
  }
}

/**
 * Structural row type (not `Prisma.Affiliate`), matching
 * `DiscountAdminService`'s own `DiscountRow` — a column rename fails to
 * compile here rather than silently flowing a wrong value onto the wire.
 */
interface AffiliateRow {
  readonly id: string;
  readonly name: string;
  readonly country: string;
  readonly socialHandle: string;
  readonly email: string;
  readonly customerId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/**
 * `$queryRaw` returns `unknown` rows, parsed rather than cast — the same
 * discipline `categories.repository.ts`'s `rowsSchema` follows. `coerce`
 * absorbs the driver returning `bigint`/`int` columns as JS `bigint` or
 * `number` depending on magnitude, which `JSON.stringify` would otherwise
 * throw on for a `bigint`.
 */
const statsRowsSchema = z.array(
  z.object({
    affiliateId: z.string(),
    redemptionCount: z.coerce.number().int().min(0),
    revenueMinor: z.coerce.number().int().min(0),
  }),
);
