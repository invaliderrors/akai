import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { ORDER_STATE_PORT, TransitionTableOrderState } from "./order-state.port";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PAYMENTS_REPOSITORY } from "./repository/payments.repository";
import { PrismaPaymentsRepository } from "./repository/prisma-payments.repository";
import { WompiWebhookController } from "./webhook/wompi-webhook.controller";
import { WompiSettlementService } from "./wompi-settlement.service";
import { LiveWompiGateway, WOMPI_FETCH, type FetchLike } from "./wompi/live-wompi.gateway";
import { WOMPI_GATEWAY } from "./wompi/wompi.gateway";

/**
 * PaymentsModule — the ONLY module that talks to Wompi.
 *
 * Everything provider-shaped sits behind `WOMPI_GATEWAY` (one read: a
 * transaction by id) and `wompi/wompi-checkout.ts` (the signed Web Checkout
 * URL), so "what can this system do to the payment provider" has one answer.
 *
 * THERE IS EXACTLY ONE GATEWAY AND EXACTLY ONE SETTLEMENT PATH. Each provider
 * migration deleted its predecessor outright — `stripe/**`, `tagada/**`, then
 * `whop/**` — because two live payment adapters in one container is a routing
 * decision nobody made. The webhook, the return-page confirmation and the
 * reconciliation sweep all settle through `WompiSettlementService`.
 *
 * THERE IS NO REFUND HERE. Wompi has no refund API for Web Checkout payments;
 * staff refund in the Wompi dashboard and record it through OrdersModule
 * (`POST /admin/orders/:orderNumber/refunds`), the one refund implementation.
 *
 * TOKEN-BOUND SEAMS: PAYMENTS_REPOSITORY (Prisma), WOMPI_GATEWAY (live
 * adapter), ORDER_STATE_PORT (the transition table), WOMPI_FETCH (`fetch`).
 */
@Module({
  imports: [PrismaModule, ThrottlerModule],
  controllers: [PaymentsController, WompiWebhookController],
  providers: [
    PaymentsService,
    WompiSettlementService,
    { provide: PAYMENTS_REPOSITORY, useClass: PrismaPaymentsRepository },
    { provide: WOMPI_GATEWAY, useClass: LiveWompiGateway },
    { provide: WOMPI_FETCH, useValue: ((url, init) => fetch(url, init)) satisfies FetchLike },
    { provide: ORDER_STATE_PORT, useClass: TransitionTableOrderState },
  ],
  exports: [PaymentsService, WompiSettlementService, WOMPI_GATEWAY],
})
export class PaymentsModule {}
