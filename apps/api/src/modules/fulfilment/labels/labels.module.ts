import { Module } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";

import { CLOCK, type Clock, systemClock } from "../../auth/ports/clock.port";
import { SERVER_CONFIG } from "../../config/config.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";
import { FulfilmentModule } from "../fulfilment.module";
import { FulfilmentAdminController } from "./fulfilment-admin.controller";
import { FulfilmentAdminService } from "./fulfilment-admin.service";
import { FULFILMENT_REPOSITORY, PrismaFulfilmentRepository } from "./fulfilment.repository";
import { LabelService } from "./label.service";
import { LABEL_STORAGE, type LabelStorage, S3LabelStorage } from "./label-storage";
import { OrderFulfilmentOutboxHandler } from "./order-fulfilment.outbox-handler";
import { SendcloudWriteThrottle } from "./sendcloud-write-throttle";

/**
 * The same fixed region every other presigner call site uses (media, batches,
 * catalog): MinIO ignores it and the deployment's bucket lives there. Moving
 * it into validated config is the existing followUp those files record.
 */
const S3_REGION = "us-east-1";

/**
 * LabelsModule — Sendcloud labels (spec §3.5, §3.6; plan Phases 4–5).
 *
 *  - `LabelService` buys one label for one order (the only caller of
 *    `announceShipment`), stores the PDF, records the shipment.
 *  - `OrderFulfilmentOutboxHandler` consumes `order-fulfilment`; exported for
 *    OutboxModule to register, the `RevalidationModule` pattern.
 *  - `FulfilmentAdminController` / `FulfilmentAdminService` — the staff
 *    endpoints under `/v1/admin/fulfilment`.
 *  - ONE `SendcloudWriteThrottle` for every Sendcloud write this process makes.
 *
 * Imported by OutboxModule (for the handler), which is how it — and its
 * controller — join the application graph; the TrackingModule precedent.
 */
@Module({
  imports: [FulfilmentModule, IdempotencyModule],
  controllers: [FulfilmentAdminController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: LABEL_STORAGE,
      inject: [SERVER_CONFIG, CLOCK],
      useFactory: (config: ServerEnv, clock: Clock): LabelStorage =>
        new S3LabelStorage(
          {
            endpoint: config.S3_ENDPOINT,
            bucket: config.S3_BUCKET_COA,
            region: S3_REGION,
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
          clock,
        ),
    },
    PrismaFulfilmentRepository,
    { provide: FULFILMENT_REPOSITORY, useExisting: PrismaFulfilmentRepository },
    { provide: SendcloudWriteThrottle, useFactory: () => new SendcloudWriteThrottle() },
    LabelService,
    FulfilmentAdminService,
    OrderFulfilmentOutboxHandler,
  ],
  exports: [OrderFulfilmentOutboxHandler, LabelService],
})
export class LabelsModule {}
