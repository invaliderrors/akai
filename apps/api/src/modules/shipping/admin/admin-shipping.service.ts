import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@akai/db";
import {
  shippingRateBoundsValid,
  type AdminShippingRate,
  type AdminShippingRateList,
  type AdminShippingZoneDetail,
  type AdminShippingZoneList,
  type CreateShippingRate,
  type CreateShippingZone,
  type ShippingStrategy,
  type UpdateShippingRate,
  type UpdateShippingZone,
} from "@akai/contracts";

import { PrismaService } from "../../prisma/prisma.service";
import { ShippingAdminError } from "./admin-shipping.errors";
import {
  narrowStrategy,
  toAdminShippingRate,
  toAdminShippingZone,
  type ShippingRateRecord,
} from "./admin-shipping.mapper";

/**
 * AdminShippingService — staff-editable shipping zones and rates.
 *
 * Plain persistence against Prisma, like `DiscountAdminService`: the PRICING
 * rules live in `shipping-rate.selector.ts` and are untouched — this only
 * guarantees that what staff write is something the selector and the quote can
 * use. Nothing is cached anywhere on the read side (the quote and the public
 * free-shipping threshold read the rows live), so an edit is effective on the
 * next request and there is nothing to revalidate.
 *
 * THE INVARIANTS, and where each is enforced:
 *
 *  1. A country belongs to at most ONE live zone. Postgres cannot express
 *     "no two rows' arrays overlap" as a plain unique index, so every zone
 *     write runs in a transaction that first takes ONE transaction-scoped
 *     advisory lock, then checks for overlap, then writes. Two editors claiming
 *     the same country concurrently are therefore serialised: the second sees
 *     the first's committed row and gets COUNTRY_IN_OTHER_ZONE. Zone writes are
 *     rare, so one lock for the whole table costs nothing.
 *  2. Every country a zone GAINS has a current STANDARD `tax_rate` row.
 *     `PrismaShippingTaxResolver` throws on a served destination without one —
 *     deliberately, a 0% default is an invisible under-remittance — so a zone
 *     covering an untaxed country would make every quote there fail. DECISION:
 *     REFUSE (TAX_RATE_MISSING) rather than create the row. The seed's IVA
 *     figure (`STANDARD_VAT_BPS`) is a per-country table, not a default, and
 *     there is no rate this editor could invent for another country that is
 *     not a guess about someone's tax return. Only countries being ADDED are
 *     checked, so renaming a zone never fails over a pre-existing gap.
 *  3. Countries come from `DESTINATION_COUNTRY_CODES` — the request schema.
 *  4. Rate coherence (bounds, transit days) — the
 *     request schemas check one body; `assertRateCoherent` re-checks the
 *     MERGED row, because a PATCH of `maxValue` alone can invert a stored
 *     `minValue`.
 *
 * DELETION IS SOFT. An order snapshots its shipping method (name, charge) at
 * checkout, and `order.shippingRateId` is a
 * SET NULL foreign key besides — a soft-deleted rate keeps its row, so
 * existing orders keep resolving it; the quote simply stops offering it.
 */

/**
 * The one advisory lock every zone write takes. `hashtext` of a fixed,
 * namespaced string, so it cannot collide with a lock another module derives
 * from its own name.
 */
const ZONE_WRITE_LOCK = "akai.shipping_zone.countries";

type Tx = Prisma.TransactionClient;

interface MergedRate {
  readonly strategy: ShippingStrategy;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly transitDaysMin: number | null;
  readonly transitDaysMax: number | null;
}

/** The merged-row rules. Pure, exported for the unit suite. */
export function assertRateCoherent(rate: MergedRate): void {
  if (!shippingRateBoundsValid(rate)) {
    throw ShippingAdminError.invalidBounds();
  }
  if (
    rate.transitDaysMin !== null &&
    rate.transitDaysMax !== null &&
    rate.transitDaysMin > rate.transitDaysMax
  ) {
    throw ShippingAdminError.invalidTransitDays();
  }
}

/** Rates in the order the editor lists them: cheapest first, then oldest. */
const RATE_ORDER = [{ priceGross: "asc" }, { createdAt: "asc" }, { id: "asc" }] as const;

@Injectable()
export class AdminShippingService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Zones
  // -------------------------------------------------------------------------

  async listZones(): Promise<AdminShippingZoneList> {
    const zones = await this.prisma.shippingZone.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      include: {
        rates: { where: { deletedAt: null }, orderBy: [...RATE_ORDER] },
      },
    });
    return { zones: zones.map((zone) => toAdminShippingZone(zone, zone.rates)) };
  }

  async createZone(input: CreateShippingZone): Promise<AdminShippingZoneDetail> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockZoneWrites(tx);
      await this.assertCountriesClaimable(tx, null, input.countryCodes, input.countryCodes);

      const zone = await tx.shippingZone.create({
        data: {
          name: input.name,
          countryCodes: [...input.countryCodes],
          sortOrder: input.sortOrder,
        },
      });
      return toAdminShippingZone(zone, []);
    });
  }

  async updateZone(id: string, input: UpdateShippingZone): Promise<AdminShippingZoneDetail> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockZoneWrites(tx);

      // Read INSIDE the lock, so "which countries is this zone gaining" is
      // judged against the row as it is now, not as it was before a concurrent
      // write this one waited for.
      const existing = await tx.shippingZone.findFirst({ where: { id, deletedAt: null } });
      if (existing === null) {
        throw new NotFoundException("Shipping zone not found");
      }

      if (input.countryCodes !== undefined) {
        const current = new Set(existing.countryCodes);
        const added = input.countryCodes.filter((code) => !current.has(code));
        await this.assertCountriesClaimable(tx, id, input.countryCodes, added);
      }

      const zone = await tx.shippingZone.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.countryCodes === undefined ? {} : { countryCodes: [...input.countryCodes] }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        },
      });
      const rates = await tx.shippingRate.findMany({
        where: { zoneId: id, deletedAt: null },
        orderBy: [...RATE_ORDER],
      });
      return toAdminShippingZone(zone, rates);
    });
  }

  /**
   * Soft-delete a zone AND its live rates, in one transaction. The rates go
   * with it so nothing reads a rate whose zone is gone as if it were live —
   * the quote already ignores them, and now nothing else has to remember to.
   */
  async deleteZone(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.shippingZone.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: now },
      });
      if (result.count === 0) {
        throw new NotFoundException("Shipping zone not found");
      }
      await tx.shippingRate.updateMany({
        where: { zoneId: id, deletedAt: null },
        data: { deletedAt: now },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Rates
  // -------------------------------------------------------------------------

  async listRates(zoneId: string): Promise<AdminShippingRateList> {
    await this.requireZone(this.prisma, zoneId);
    const rates = await this.prisma.shippingRate.findMany({
      where: { zoneId, deletedAt: null },
      orderBy: [...RATE_ORDER],
    });
    return { rates: rates.map(toAdminShippingRate) };
  }

  async createRate(zoneId: string, input: CreateShippingRate): Promise<AdminShippingRate> {
    assertRateCoherent(input);
    await this.requireZone(this.prisma, zoneId);

    const row = await this.prisma.shippingRate.create({
      data: {
        zoneId,
        name: input.name,
        strategy: input.strategy,
        minValue: input.minValue,
        maxValue: input.maxValue,
        priceGross: input.priceGross,
        currency: input.currency,
        freeOverSubtotal: input.freeOverSubtotal,
        isActive: input.isActive,
        transitDaysMin: input.transitDaysMin,
        transitDaysMax: input.transitDaysMax,
      },
    });
    return toAdminShippingRate(row);
  }

  async updateRate(
    zoneId: string,
    rateId: string,
    input: UpdateShippingRate,
  ): Promise<AdminShippingRate> {
    const existing = await this.requireRate(zoneId, rateId);

    assertRateCoherent({
      strategy: input.strategy ?? narrowStrategy(existing.strategy),
      minValue: input.minValue === undefined ? existing.minValue : input.minValue,
      maxValue: input.maxValue === undefined ? existing.maxValue : input.maxValue,
      transitDaysMin:
        input.transitDaysMin === undefined ? existing.transitDaysMin : input.transitDaysMin,
      transitDaysMax:
        input.transitDaysMax === undefined ? existing.transitDaysMax : input.transitDaysMax,
    });

    const row = await this.prisma.shippingRate.update({
      where: { id: rateId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
        ...(input.minValue === undefined ? {} : { minValue: input.minValue }),
        ...(input.maxValue === undefined ? {} : { maxValue: input.maxValue }),
        ...(input.priceGross === undefined ? {} : { priceGross: input.priceGross }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.freeOverSubtotal === undefined
          ? {}
          : { freeOverSubtotal: input.freeOverSubtotal }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.transitDaysMin === undefined ? {} : { transitDaysMin: input.transitDaysMin }),
        ...(input.transitDaysMax === undefined ? {} : { transitDaysMax: input.transitDaysMax }),
      },
    });
    return toAdminShippingRate(row);
  }

  /**
   * Soft delete. The row stays, so every order that snapshotted it keeps its
   * `shippingRateId`; the quote stops offering it on the next request.
   */
  async deleteRate(zoneId: string, rateId: string): Promise<void> {
    const result = await this.prisma.shippingRate.updateMany({
      where: { id: rateId, zoneId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException("Shipping rate not found");
    }
  }

  // -------------------------------------------------------------------------
  // Invariant helpers
  // -------------------------------------------------------------------------

  private async lockZoneWrites(tx: Tx): Promise<void> {
    // `$executeRaw`, not `$queryRaw`: the lock function returns `void`, which
    // Prisma cannot deserialise as a result column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ZONE_WRITE_LOCK}))`;
  }

  /**
   * Invariants 1 and 2, under the lock. `claimed` is the zone's full new
   * country list (for the overlap check); `added` the countries it did not
   * already hold (for the tax check).
   */
  private async assertCountriesClaimable(
    tx: Tx,
    zoneId: string | null,
    claimed: readonly string[],
    added: readonly string[],
  ): Promise<void> {
    if (claimed.length > 0) {
      const others = await tx.shippingZone.findMany({
        where: {
          deletedAt: null,
          countryCodes: { hasSome: [...claimed] },
          ...(zoneId === null ? {} : { id: { not: zoneId } }),
        },
        select: { id: true, name: true, countryCodes: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      for (const other of others) {
        const clash = claimed.find((code) => other.countryCodes.includes(code));
        if (clash !== undefined) {
          throw ShippingAdminError.countryInOtherZone(clash, other);
        }
      }
    }

    if (added.length > 0) {
      const now = new Date();
      // The same predicate `PrismaShippingTaxResolver` applies, so "the editor
      // accepted it" and "the quote can tax it" cannot disagree.
      const taxed = await tx.taxRate.findMany({
        where: {
          countryCode: { in: [...added] },
          taxClass: "STANDARD",
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        select: { countryCode: true },
      });
      const covered = new Set(taxed.map((row) => row.countryCode));
      const missing = added.filter((code) => !covered.has(code));
      if (missing.length > 0) {
        throw ShippingAdminError.taxRateMissing(missing);
      }
    }
  }

  private async requireZone(client: Pick<Tx, "shippingZone">, zoneId: string): Promise<void> {
    const zone = await client.shippingZone.findFirst({
      where: { id: zoneId, deletedAt: null },
      select: { id: true },
    });
    if (zone === null) {
      throw new NotFoundException("Shipping zone not found");
    }
  }

  /** A live rate of a live zone — a rate id under the wrong zone is a 404. */
  private async requireRate(zoneId: string, rateId: string): Promise<ShippingRateRecord> {
    const rate = await this.prisma.shippingRate.findFirst({
      where: { id: rateId, zoneId, deletedAt: null, zone: { deletedAt: null } },
    });
    if (rate === null) {
      throw new NotFoundException("Shipping rate not found");
    }
    return rate;
  }
}
