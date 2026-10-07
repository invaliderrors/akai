import { Module } from "@nestjs/common";
import { CartModule } from "../cart/cart.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { ShippingController } from "./shipping.controller";
import {
  SHIPPING_TAX_RESOLVER,
  PrismaShippingTaxResolver,
} from "./shipping-tax.resolver";
import {
  SHIPPING_REPOSITORY,
  PrismaShippingRepository,
} from "./shipping.repository";
import { ShippingService } from "./shipping.service";

/**
 * ShippingModule — the server-side source of the shipping charge.
 *
 * OWNS: zones, weight/price/flat rate strategies, free-over-threshold, and the
 * country restriction (a destination with no zone is refused, structurally).
 *
 * Two symbol-token seams, both Prisma in production and in-memory doubles in the
 * unit tests, so the selection and tax logic is provable without a database:
 *
 *  * SHIPPING_REPOSITORY   — resolves the active zone + rates for a destination.
 *  * SHIPPING_TAX_RESOLVER — the VAT rate to split the gross rate into net + tax.
 *
 * ShippingService is exported because CheckoutModule must resolve the charge
 * from the chosen `shippingMethodId` before handing it to `OrdersService`
 * (spec §13) — the API never accepts a shipping amount from the client.
 *
 * IT NOW HAS A CONTROLLER, and that was the single largest hole in the platform.
 * `POST /v1/checkout` requires a `shippingMethodId` that is a `shipping_rate`
 * row id; with no public route producing one, no client could complete a
 * checkout at all. `listOptions` was already written and tested — only the HTTP
 * adapter was missing.
 *
 * IT IMPORTS CartModule, and the direction matters: a quote's price inputs
 * (subtotal, parcel weight) are read from the caller's own cart rather than
 * accepted from the request, so a shopper cannot state the numbers that decide
 * what they pay for delivery. CartModule does not import ShippingModule, so
 * there is no cycle; CheckoutModule imports both.
 */
@Module({
  imports: [PrismaModule, CartModule, ThrottlerModule],
  controllers: [ShippingController],
  providers: [
    ShippingService,
    { provide: SHIPPING_REPOSITORY, useClass: PrismaShippingRepository },
    { provide: SHIPPING_TAX_RESOLVER, useClass: PrismaShippingTaxResolver },
  ],
  exports: [ShippingService],
})
export class ShippingModule {}
