import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import {
  DESTINATION_TAX_RESOLVER,
  DestinationTaxResolver,
} from "./destination-tax.resolver";

/**
 * TaxModule — destination VAT resolution.
 *
 * OWNS: the DESTINATION-based rate lookup keyed `(countryCode, taxClass)`. Until
 * now nothing resolved tax by ship-to; the catalog's `TaxRateResolver` only knew
 * the store's base country and stamped that origin rate onto the variant, so an
 * order shipped abroad was charged the wrong country's VAT (issue SEV3).
 *
 * The resolver is bound to a symbol-token port (`DESTINATION_TAX_RESOLVER`) and
 * EXPORTED so OrdersModule can re-price each order line's tax from the shipping
 * address at order creation. OSS threshold and B2B reverse charge (VIES) are
 * deferred and documented on the resolver — see followUps.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: DESTINATION_TAX_RESOLVER, useClass: DestinationTaxResolver },
  ],
  exports: [DESTINATION_TAX_RESOLVER],
})
export class TaxModule {}
