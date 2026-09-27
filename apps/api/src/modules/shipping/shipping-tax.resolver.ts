import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import { ShippingError } from "./shipping.errors";

/**
 * Resolves the VAT rate to apply to a shipping charge.
 *
 * WHY A PORT: shipping tax is a genuinely fuzzy area (spec §13 defers the full
 * treatment to a dedicated tax service for v1) and the order-totals `ShippingCharge` needs a
 * `taxRateBps` regardless, because EU shipping prices are displayed GROSS and
 * must be split into net + tax on the invoice. Isolating the rate behind a port
 * keeps ShippingService's selection logic testable and lets the tax-service
 * treatment replace this one provider without touching the engine.
 *
 * V1 RULE (documented, not hidden): shipping follows the DESTINATION country's
 * STANDARD rate. That is the OSS/B2C default and is exact enough for launch; the
 * applied rate is persisted on the order regardless, so a later correction is a
 * data migration, not a reconstruction. See followUps.
 *
 * WHY IT THROWS ON A MISSING RATE: the same reason TaxRateResolver does. A `0`
 * fallback makes the code run and silently ships VAT-free, an under-remittance
 * invisible until the first VAT return. A served destination with no configured
 * rate is a configuration failure and is treated as one.
 */
export interface ShippingTaxResolverPort {
  resolveBps(countryCode: string): Promise<number>;
}

export const SHIPPING_TAX_RESOLVER = Symbol("SHIPPING_TAX_RESOLVER");

@Injectable()
export class PrismaShippingTaxResolver implements ShippingTaxResolverPort {
  constructor(private readonly prisma: PrismaService) {}

  async resolveBps(countryCode: string): Promise<number> {
    const now = new Date();
    const rate = await this.prisma.taxRate.findFirst({
      where: {
        countryCode,
        taxClass: "STANDARD",
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      orderBy: { validFrom: "desc" },
    });

    if (rate === null) {
      throw ShippingError.taxUnconfigured(countryCode);
    }

    return rate.rateBps;
  }
}
