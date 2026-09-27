import { Module } from "@nestjs/common";

import { CART_DISCOUNT_PORT } from "../cart/cart-discount.port";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminDiscountsController } from "./admin-discounts.controller";
import { DiscountAdminService } from "./discount-admin.service";
import { DiscountsCartAdapter } from "./discounts-cart.adapter";
import {
  DISCOUNTS_REPOSITORY,
  PrismaDiscountsRepository,
} from "./discounts.repository";
import {
  DISCOUNTS_CLOCK,
  DiscountsService,
  systemDiscountClock,
} from "./discounts.service";

/**
 * DiscountsModule — coupon validation and redemption accounting.
 *
 * OWNS: validating a code against a basket (window, currency, minimum, usage
 * caps), computing the amount it removes, and consuming a redemption at
 * checkout. Server-side only; a client-applied discount is advisory (spec §13).
 *
 * It BINDS CartModule's `CART_DISCOUNT_PORT` to `DiscountsCartAdapter` and
 * exports the token, so importing this module is what makes the cart honour
 * codes — replacing the fail-closed `NoDiscountAdapter` with no change to
 * CartService. The port stays the seam; only the binding moved.
 *
 * DISCOUNTS_CLOCK is a provider (not a `new Date()` at the point of use) so the
 * validity-window rules are assertable without the suite waiting for a coupon to
 * expire.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AdminDiscountsController],
  providers: [
    DiscountsService,
    DiscountAdminService,
    { provide: DISCOUNTS_REPOSITORY, useClass: PrismaDiscountsRepository },
    { provide: DISCOUNTS_CLOCK, useValue: systemDiscountClock },
    { provide: CART_DISCOUNT_PORT, useClass: DiscountsCartAdapter },
  ],
  exports: [DiscountsService, CART_DISCOUNT_PORT],
})
export class DiscountsModule {}
