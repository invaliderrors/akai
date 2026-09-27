import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { ORDER_STATE_PORT, TransitionTableOrderState } from "./order-state.port";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PAYMENTS_REPOSITORY } from "./repository/payments.repository";
import { PrismaPaymentsRepository } from "./repository/prisma-payments.repository";
import { WhopWebhookController } from "./webhook/whop-webhook.controller";
import { WhopWebhookService } from "./webhook/whop-webhook.service";
import { LiveWhopGateway } from "./whop/live-whop.gateway";
import { WHOP_GATEWAY } from "./whop/whop.gateway";

/**
 * PaymentsModule — the ONLY module that talks to Whop.
 *
 * Everything provider-shaped sits behind `WHOP_GATEWAY`, so "what can this
 * system do to the payment provider" has exactly one answer, in one file, and a
 * test can substitute the whole integration without a cast.
 *
 * THREE SEAMS ARE TOKEN-BOUND so the modules that will eventually own them can
 * take over without editing anything here:
 *   - PAYMENTS_REPOSITORY — persistence, currently Prisma-backed.
 *   - WHOP_GATEWAY        — the live Whop adapter.
 *   - ORDER_STATE_PORT    — order transitions, until OrdersModule ships its
 *                           domain service; rebinding this token is the whole
 *                           migration.
 *
 * THERE IS EXACTLY ONE GATEWAY AND EXACTLY ONE WEBHOOK PLANE. Each provider
 * migration has deleted its predecessor outright rather than leaving it bound —
 * `stripe/**` then `tagada/**`, with their gateways and webhook pairs. Two live
 * payment adapters in one container is a routing decision nobody made, and the
 * way it fails is that a refund goes to the provider that did not take the
 * money.
 *
 * SIMILARLY, THERE IS EXACTLY ONE REFUND IMPLEMENTATION. `refundOrder` lives on
 * `PaymentsService` and nowhere else. A parallel pass grew a second one in a
 * separate `RefundsModule`; both wrote the same ledger against the same order,
 * which is a double refund waiting for two operators to click at once. The
 * integration contract (§2, §11 Lane C) puts it here, so here is where it stayed.
 *
 * Services are EXPORTED because the checkout, orders and admin modules call them
 * in-process rather than over HTTP: CheckoutModule opens a checkout session once
 * it has verified cart ownership.
 *
 * CATALOGMODULE NO LONGER CALLS IN HERE AT ALL. It used to invoke
 * `ProductSyncService.enqueueSync` inside its own write transaction, because a
 * TagadaPay checkout could only reference a mirrored variant and an unmirrored
 * one could not be sold. Whop takes the amount directly on the checkout call, so
 * there is no mirror, no sync job, and no coupling between publishing a product
 * and being able to sell it.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PaymentsController, WhopWebhookController],
  providers: [
    PaymentsService,
    WhopWebhookService,
    { provide: PAYMENTS_REPOSITORY, useClass: PrismaPaymentsRepository },
    { provide: WHOP_GATEWAY, useClass: LiveWhopGateway },
    { provide: ORDER_STATE_PORT, useClass: TransitionTableOrderState },
  ],
  exports: [PaymentsService, WhopWebhookService, WHOP_GATEWAY],
})
export class PaymentsModule {}
