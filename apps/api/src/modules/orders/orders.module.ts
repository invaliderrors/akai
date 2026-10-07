import { Module } from "@nestjs/common";

import { CatalogModule } from "../catalog/catalog.module";
import { DiscountsModule } from "../discounts/discounts.module";
import { TaxModule } from "../tax/tax.module";
import { AdminOrdersController } from "./admin-orders.controller";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

/**
 * OrdersModule.
 *
 * OWNS: the order state machine. Nothing else in the platform may write
 * `order.status` — not the Wompi settlement, not a fulfilment job, not an admin
 * controller. They all call into OrdersService, which is why it is exported.
 *
 * The exported surface is deliberately the SERVICE, not a repository. The
 * methods that other modules need (`createFromCart`, `markPaid`,
 * `recordRefund`) each enforce an invariant on the way through — a legal
 * transition, a gap-free invoice number, a refund that cannot exceed what was
 * paid. Exporting raw data access instead would let a caller skip every one of
 * them, and "the webhook handler updated status directly, just this once" is how
 * a state machine stops being one.
 *
 * Expected consumers: CheckoutModule (createFromCart), the admin refund record
 * (recordRefund), FulfilmentModule (shipments).
 */
// PrismaModule is @Global (see its own comment), so it is deliberately NOT
// imported here — an explicit import would be ceremony that adds no safety.
//
// CatalogModule, TaxModule and DiscountsModule ARE imported: order creation now
// resolves the DESTINATION VAT rate per line (TaxModule), applies and records the
// cart's discount code (DiscountsModule), and commits the stock reserved at
// checkout when the order is paid (CatalogModule's ProductInventoryService).
@Module({
  imports: [CatalogModule, TaxModule, DiscountsModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
