import { Injectable } from "@nestjs/common";
import type { TaxClass } from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import { TaxError } from "./tax.errors";

/**
 * Resolves the VAT rate for a specific DESTINATION country and tax class.
 *
 * THE BUG THIS FIXES (issue SEV3): `TaxRateResolver` in the catalog module
 * resolves the rate for the store's BASE country only and bakes it onto the
 * variant at creation time. An order shipped to Germany was therefore charged
 * Spanish VAT. EU distance selling (OSS/B2C) requires the DESTINATION country's
 * rate for the product's tax class, and the `tax_rate` table is keyed
 * `(countryCode, taxClass, validFrom)` precisely so that key can be exercised by
 * ship-to. This resolver exercises it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO YET (see followUps):
 *  - The OSS EUR 10,000 threshold switchover (below the threshold a micro-seller
 *    may charge origin VAT). v1 always charges destination; the applied rate is
 *    persisted on every order line, so a later correction is a data migration,
 *    not a reconstruction.
 *  - B2B reverse charge with cached VIES. A valid cross-border VAT number
 *    zero-rates the order; that is a ZERO_RATED class the caller can already
 *    request here, but the VIES validation that DECIDES it lives in a later pass.
 */
export interface DestinationTaxResolverPort {
  /**
   * The VAT rate in basis points for a destination + class.
   *
   * @param countryCode ISO-3166-1 alpha-2, uppercase — the SHIP-TO country.
   * @param taxClass    the product's tax class (a supplement is reduced-rate in
   *                    some member states and standard in others).
   */
  resolveBps(countryCode: string, taxClass: TaxClass): Promise<number>;
}

export const DESTINATION_TAX_RESOLVER = Symbol("DESTINATION_TAX_RESOLVER");

@Injectable()
export class DestinationTaxResolver implements DestinationTaxResolverPort {
  constructor(private readonly prisma: PrismaService) {}

  async resolveBps(countryCode: string, taxClass: TaxClass): Promise<number> {
    // ZERO_RATED is a legal classification (reverse charge, exports), not an
    // absent configuration, so it short-circuits rather than requiring a seeded
    // 0 row for every destination.
    if (taxClass === "ZERO_RATED") {
      return 0;
    }

    const now = new Date();
    const rate = await this.prisma.taxRate.findFirst({
      where: {
        countryCode,
        taxClass,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      // Most recently effective rate wins. Rates are versioned by validFrom so a
      // scheduled change (a VAT reform announced months ahead) does not require
      // editing history.
      orderBy: { validFrom: "desc" },
    });

    if (rate === null) {
      throw TaxError.rateUnconfigured(countryCode, taxClass);
    }

    return rate.rateBps;
  }
}
