import { Module } from "@nestjs/common";

import { DiscountsModule } from "../discounts/discounts.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { CART_CLOCK, systemClock } from "./cart-clock";
import { CartTokenService } from "./cart-token.service";
import { CartController } from "./cart.controller";
import { CART_REPOSITORY } from "./cart.repository";
import { CartService } from "./cart.service";
import { PrismaCartRepository } from "./prisma-cart.repository";

/**
 * CartModule — server-owned carts.
 *
 * OWNS: cart lifecycle (create/fetch/expire), line items, quantity validation
 * against inventory, merge-on-login (quantity-sum capped at the per-line max),
 * and server-side recomputation of every total.
 *
 * The symbol-token bindings are the module's seams:
 *
 *  * CART_REPOSITORY — Prisma in production, an in-memory double in the unit
 *    tests, so the money and ownership rules are testable without a database.
 *  * CART_DISCOUNT_PORT — now bound by DiscountsModule (imported below), which
 *    exports the token. Codes are honoured through DiscountsService; an invalid
 *    or lapsed code degrades to no discount rather than 500-ing the cart. The
 *    port itself is unchanged — only the binding moved out of this module.
 *  * CART_CLOCK — makes cart expiry, a security-relevant rule, assertable
 *    without the suite sleeping for 30 days.
 *
 * CartService is exported because CheckoutModule must re-read and re-price the
 * cart server-side when it builds an order. It is exported deliberately as the
 * SERVICE, not the repository: checkout must go through the validation and
 * re-pricing logic, never read cart rows directly.
 */
@Module({
  // ThrottlerModule imported EXPLICITLY, not relied upon as global: the cart
  // write verbs carry @UseGuards(ThrottleGuard), and a guard whose provider is
  // only present when some other module happened to pull it into the graph is a
  // rate limit that silently disappears under a different composition.
  imports: [PrismaModule, DiscountsModule, ThrottlerModule],
  controllers: [CartController],
  providers: [
    CartService,
    CartTokenService,
    { provide: CART_REPOSITORY, useClass: PrismaCartRepository },
    { provide: CART_CLOCK, useValue: systemClock },
  ],
  exports: [CartService],
})
export class CartModule {}
