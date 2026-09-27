import { Inject, Injectable } from "@nestjs/common";
import type { TaxClass } from "@akai/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogError } from "./catalog.errors";

/**
 * Injection token for the store's base country.
 *
 * TEMPORARY HOME. This belongs in the validated config (`STORE_BASE_COUNTRY`),
 * but `libs/config` is owned by another module and adding a var there would
 * collide with a parallel agent. Defaulting to "ES" matches the storefront's
 * Spanish-default routing. Listed in followUps.
 */
export const CATALOG_BASE_COUNTRY = "akai:catalog:baseCountry";

/**
 * Resolves the VAT rate to stamp onto a variant's price.
 *
 * WHY THIS EXISTS AT ALL: `createVariantSchema` in @akai/contracts accepts a
 * `priceGross` but no `taxRateBps`, while the `product_variant` row requires
 * one. The rate is therefore DERIVED, not supplied — which is correct, because a
 * client-supplied tax rate is a client-supplied tax liability.
 *
 * WHY IT THROWS INSTEAD OF DEFAULTING TO ZERO: the tempting fallback for "no
 * configured rate" is `0`, which makes the code run and quietly sells every unit
 * VAT-free. That error is invisible in testing (the arithmetic is consistent,
 * the invoice foots, the customer is charged the displayed price) and surfaces
 * as an under-remittance at the first VAT return, by which point every order in
 * the period is wrong and unfixable. A missing rate is a configuration failure
 * and is treated as one.
 *
 * TaxModule should own this. The interface is deliberately narrow so that swap
 * is a provider replacement, not a rewrite. See followUps.
 */
export interface TaxRateResolverPort {
  resolveBps(taxClass: TaxClass): Promise<number>;
}

@Injectable()
export class TaxRateResolver implements TaxRateResolverPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CATALOG_BASE_COUNTRY) private readonly baseCountry: string,
  ) {}

  async resolveBps(taxClass: TaxClass): Promise<number> {
    // ZERO_RATED is a legal classification, not an absent configuration, so it
    // short-circuits rather than requiring an explicit 0 row to be seeded.
    if (taxClass === "ZERO_RATED") {
      return 0;
    }

    const now = new Date();
    const rate = await this.prisma.taxRate.findFirst({
      where: {
        countryCode: this.baseCountry,
        taxClass,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      // Most recently effective rate wins. Rates are versioned by validFrom
      // precisely so a scheduled change does not require editing history.
      orderBy: { validFrom: "desc" },
    });

    if (rate === null) {
      throw CatalogError.validation(
        `No tax rate configured for ${taxClass} in ${this.baseCountry}. ` +
          `Configure a tax_rate row before pricing a variant — defaulting to 0% ` +
          `would sell this product VAT-free.`,
      );
    }

    return rate.rateBps;
  }
}
