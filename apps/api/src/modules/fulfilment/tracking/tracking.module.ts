import { Module } from "@nestjs/common";

import { OrdersModule } from "../../orders/orders.module";
import { FulfilmentModule } from "../fulfilment.module";
import { SendcloudWebhookController } from "./sendcloud-webhook.controller";
import { SendcloudWebhookService } from "./sendcloud-webhook.service";
import { ShipmentSyncOutboxHandler } from "./shipment-sync.outbox-handler";
import { ShipmentSyncService } from "./shipment-sync.service";
import { ShipmentSyncSweep } from "./shipment-sync.sweep";

/**
 * Sendcloud TRACKING (spec 2026-09-24-sendcloud-shipping §3.7, plan Phase 6):
 * the signed webhook, the `shipment-sync` consumer and the 2-hourly sweep.
 *
 * Its own module rather than more providers on FulfilmentModule so the label
 * plane and the tracking plane can change independently. It takes the
 * Sendcloud port from FulfilmentModule and `markShipmentDelivered` from
 * OrdersModule; order status is otherwise written only through the orders
 * module's exported `assertTransition` + `applyStatus`.
 *
 * Wired in three places: AppModule (the controller), OutboxModule (the
 * handler is appended to OUTBOX_HANDLERS) and QueueModule (the sweep is a
 * ScheduledJobsRunner job). Importing it starts nothing.
 */
@Module({
  imports: [FulfilmentModule, OrdersModule],
  controllers: [SendcloudWebhookController],
  providers: [SendcloudWebhookService, ShipmentSyncService, ShipmentSyncOutboxHandler, ShipmentSyncSweep],
  exports: [ShipmentSyncService, ShipmentSyncOutboxHandler, ShipmentSyncSweep],
})
export class TrackingModule {}
