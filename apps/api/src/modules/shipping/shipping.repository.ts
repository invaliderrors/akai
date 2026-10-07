import { Injectable } from "@nestjs/common";

import { narrowLocalizedText } from "../../common/localized-text";
import { PrismaService } from "../prisma/prisma.service";
import type { ShippingRateRow } from "./shipping-rate.selector";

/**
 * The shipping module's read seam.
 *
 * A port, not a direct Prisma call, so ShippingService's selection and tax logic
 * is testable against an in-memory double with no Postgres — the same pattern
 * CartModule uses for CART_REPOSITORY.
 */
export interface ShippingZoneWithRates {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly rates: readonly ShippingRateRow[];
}

export interface ShippingRepository {
  /**
   * The active zone serving a destination, with its active rates — or null when
   * no zone covers the country. Null is the country-restriction signal: it is
   * the ABSENCE of a zone, not a flag on one, that means "we don't ship here".
   */
  findZoneForCountry(countryCode: string): Promise<ShippingZoneWithRates | null>;

  /**
   * Every rate a customer could be offered ANYWHERE: active, not deleted, in a
   * live zone that serves at least one country. Only the two fields the
   * destination-independent free-shipping threshold is derived from.
   */
  listOfferableRateThresholds(): Promise<readonly OfferableRateThreshold[]>;
}

export interface OfferableRateThreshold {
  readonly freeOverSubtotal: number | null;
  readonly currency: string;
}

export const SHIPPING_REPOSITORY = Symbol("SHIPPING_REPOSITORY");

@Injectable()
export class PrismaShippingRepository implements ShippingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findZoneForCountry(countryCode: string): Promise<ShippingZoneWithRates | null> {
    // Lowest sortOrder wins when zones overlap — the operator's declared
    // precedence, deterministic rather than "whichever the planner returned".
    const zone = await this.prisma.shippingZone.findFirst({
      where: { deletedAt: null, countryCodes: { has: countryCode } },
      orderBy: { sortOrder: "asc" },
      include: {
        rates: {
          where: { isActive: true, deletedAt: null },
          orderBy: { priceGross: "asc" },
        },
      },
    });

    if (zone === null) {
      return null;
    }

    return {
      zoneId: zone.id,
      zoneName: zone.name,
      rates: zone.rates.map((row) => ({
        id: row.id,
        // PARSED, never cast. Prisma types a Json column as a union that
        // includes null, arrays and nested objects; asserting it into a locale
        // record would typecheck and then render `undefined` at the checkout on
        // the first row a migration or a manual UPDATE wrote badly. An
        // unparseable name degrades to `{}`, and the selector refuses to offer
        // a rate nobody can read.
        name: narrowLocalizedText(row.name),
        strategy: row.strategy,
        priceGross: row.priceGross,
        currency: row.currency,
        minValue: row.minValue,
        maxValue: row.maxValue,
        freeOverSubtotal: row.freeOverSubtotal,
        isActive: row.isActive,
        transitDaysMin: row.transitDaysMin,
        transitDaysMax: row.transitDaysMax,
      })),
    };
  }

  async listOfferableRateThresholds(): Promise<readonly OfferableRateThreshold[]> {
    return this.prisma.shippingRate.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        // A zone with no countries serves nobody, so its rates are offered to
        // nobody and must not veto (or define) the store-wide threshold.
        zone: { deletedAt: null, NOT: { countryCodes: { isEmpty: true } } },
      },
      select: { freeOverSubtotal: true, currency: true },
    });
  }
}
