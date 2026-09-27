import { Module } from "@nestjs/common";

import { CartModule } from "../cart/cart.module";
import { CatalogModule } from "../catalog/catalog.module";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { ShippingModule } from "../shipping/shipping.module";
import {
  CHECKOUT_CATALOG_PORT,
  PrismaCheckoutCatalog,
} from "./checkout-catalog.port";
import { CheckoutController } from "./checkout.controller";
import { CheckoutService } from "./checkout.service";

/**
 * CheckoutModule — the one place a cart becomes an order and a hosted checkout
 * session.
 *
 * OWNS the ORCHESTRATION only; it holds none of the invariants. It composes the
 * services that do:
 *   - CartModule      → re-reads and re-prices the caller's cart, and proves
 *                       they own it.
 *   - ShippingModule  → the server-side shipping charge (never client-supplied).
 *   - CatalogModule   → ProductInventoryService, for the atomic stock reservation
 *                       that is the oversell guard.
 *   - OrdersModule    → createFromCart, the sole writer of a new order and the
 *                       server-side re-price.
 *   - PaymentsModule  → startCheckout, which opens the gateway-hosted session.
 *                       This module names no provider: `CheckoutPaymentsPort`
 *                       is `Pick<PaymentsService, "startCheckout">` and that is
 *                       the whole coupling.
 *
 * It imports every one of those rather than reaching into Prisma for their
 * tables, so the re-price, the ownership check and the oversell guard each keep
 * their single home. Nothing imports CheckoutModule in turn, so composing all of
 * them here introduces no cycle.
 */
@Module({
  imports: [
    PrismaModule,
    CartModule,
    ShippingModule,
    CatalogModule,
    OrdersModule,
    PaymentsModule,
    // Replay protection for the one money-creating POST, and a rate limit on it.
    // Both were absent while every other unsafe surface had at least one.
    IdempotencyModule,
    ThrottlerModule,
  ],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    { provide: CHECKOUT_CATALOG_PORT, useClass: PrismaCheckoutCatalog },
  ],
})
export class CheckoutModule {}
