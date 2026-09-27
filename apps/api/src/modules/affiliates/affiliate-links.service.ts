import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@akai/db";

import { PrismaService } from "../prisma/prisma.service";
import {
  RESERVED_PARTNER_SLUGS,
  type AdminAffiliateLink,
  type CreateAffiliateLinkDto,
  type ListAffiliateLinksQuery,
} from "./dto/affiliate-link-admin.dto";

const UNIQUE_VIOLATION = "P2002";

/**
 * AffiliateLinksService — admin CRUD for a partner's vanity links
 * (`akai.shop/<slug>`), plus the resolution a click against one performs:
 * record it and hand back a live discount code, if the affiliate has one.
 *
 * PLAIN PERSISTENCE, matching `AffiliateAdminService`'s own reasoning: no
 * pricing rules here, so this reads and writes `affiliate_link` and
 * `affiliate_link_click` directly rather than behind a port.
 *
 * `clickCount` is NEVER a stored counter — `AffiliateLinkClick` is an
 * append-only log, counted at read time, exactly like
 * `AffiliateAdminService`'s own `redemptionCount`/`revenueMinor`.
 */
@Injectable()
export class AffiliateLinksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(affiliateId: string, input: CreateAffiliateLinkDto): Promise<AdminAffiliateLink> {
    await this.requireLiveAffiliate(affiliateId);

    if (RESERVED_PARTNER_SLUGS.includes(input.slug)) {
      throw new ConflictException(
        `"${input.slug}" is a reserved storefront route and cannot be used as a partner link.`,
      );
    }

    try {
      const row = await this.prisma.affiliateLink.create({
        data: { affiliateId, slug: input.slug },
      });
      return this.toAdminLink(row, 0);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new ConflictException(`The link "${input.slug}" is already in use.`);
      }
      throw error;
    }
  }

  async list(
    affiliateId: string,
    query: ListAffiliateLinksQuery,
  ): Promise<readonly AdminAffiliateLink[]> {
    await this.requireLiveAffiliate(affiliateId);

    const rows = await this.prisma.affiliateLink.findMany({
      where: {
        affiliateId,
        ...(query.includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { clicks: true } } },
    });

    return rows.map((row) => this.toAdminLink(row, row._count.clicks));
  }

  /** Idempotent-in-effect: a second delete of an already-deleted link 404s, matching `AffiliateAdminService.softDelete`. */
  async softDelete(affiliateId: string, linkId: string): Promise<void> {
    const result = await this.prisma.affiliateLink.updateMany({
      where: { id: linkId, affiliateId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException("Affiliate link not found");
    }
  }

  /**
   * The public click path: record ONE click and hand back the affiliate's
   * current live discount code, if it has one.
   *
   * Returns `null` for an unknown or soft-deleted slug — the caller (the
   * public controller) turns that into a 404 that does not distinguish
   * "never existed" from "retired", matching this codebase's admin-route
   * posture of not confirming what exists.
   *
   * THIS IS NOT `DiscountsService.validate`. It checks the SAME active-window
   * and usage-cap fields `DiscountsService.validate` does, but has no
   * subtotal, currency or customer to validate against at click time — those
   * are re-checked for real, later, when the storefront actually tries to
   * apply the code to a cart (silently — see `cart-provider.tsx`). A click
   * being recorded here is a promise to TRY the code, not a promise it will
   * apply.
   */
  async resolveVisit(slug: string): Promise<{ readonly discountCode: string | null } | null> {
    const link = await this.prisma.affiliateLink.findUnique({ where: { slug } });
    if (link === null || link.deletedAt !== null) {
      return null;
    }

    await this.prisma.affiliateLinkClick.create({ data: { linkId: link.id } });

    const now = new Date();
    const candidates = await this.prisma.discount.findMany({
      where: {
        affiliateId: link.affiliateId,
        deletedAt: null,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      orderBy: { createdAt: "desc" },
    });

    // `maxRedemptions` is filtered here, not in the query: Prisma cannot
    // compare two columns of the same row (`timesRedeemed < maxRedemptions`)
    // without raw SQL. An affiliate holds at most a handful of live codes, so
    // this is a best-effort pick over a short in-memory list, not a hot path
    // worth raw SQL for — the most recently created code that ISN'T exhausted
    // wins, so an exhausted newer code does not hide an older one still live.
    const discount = candidates.find(
      (row) => row.maxRedemptions === null || row.timesRedeemed < row.maxRedemptions,
    );

    return { discountCode: discount?.code ?? null };
  }

  private async requireLiveAffiliate(affiliateId: string): Promise<void> {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { id: affiliateId } });
    if (affiliate === null || affiliate.deletedAt !== null) {
      throw new NotFoundException("Affiliate not found");
    }
  }

  private toAdminLink(row: AffiliateLinkRow, clickCount: number): AdminAffiliateLink {
    return {
      id: row.id,
      affiliateId: row.affiliateId,
      slug: row.slug,
      clickCount,
      createdAt: row.createdAt.toISOString(),
      deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    };
  }
}

interface AffiliateLinkRow {
  readonly id: string;
  readonly affiliateId: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}
