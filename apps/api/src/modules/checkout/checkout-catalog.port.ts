import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

/**
 * The one thing CheckoutModule needs from the catalog that neither the cart DTO
 * nor CartService exposes: variant parcel weights, so ShippingService can price
 * a weight-bracket rate.
 *
 * A narrow PORT rather than a direct PrismaService dependency in CheckoutService
 * — that keeps the service's orchestration logic (validate → reserve → create →
 * pay, and its compensation on failure) unit-testable against a plain in-memory
 * double, with no database and no `as unknown as PrismaClient`. The Prisma-backed
 * adapter below is the only place that reads the column.
 */
export const CHECKOUT_CATALOG_PORT = Symbol("CHECKOUT_CATALOG_PORT");

export interface CheckoutCatalogPort {
  /**
   * Parcel weight in grams, keyed by variant id. A variant that was never
   * weighed (`weightGrams` is nullable) maps to 0, which simply excludes it from
   * weight-bracket shipping rather than failing the checkout.
   */
  loadVariantWeights(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
}

@Injectable()
export class PrismaCheckoutCatalog implements CheckoutCatalogPort {
  constructor(private readonly prisma: PrismaService) {}

  async loadVariantWeights(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (variantIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: [...variantIds] } },
      select: { id: true, weightGrams: true },
    });

    const weights = new Map<string, number>();
    for (const row of rows) {
      weights.set(row.id, row.weightGrams ?? 0);
    }
    return weights;
  }
}
