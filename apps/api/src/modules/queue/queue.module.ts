import { Module } from "@nestjs/common";

import { CartService } from "../cart/cart.service";
import { CartModule } from "../cart/cart.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ProductInventoryService } from "../catalog/product-inventory.service";
import { ShipmentSyncSweep } from "../fulfilment/tracking/shipment-sync.sweep";
import {
  CART_SWEEPER,
  DEFAULT_SCHEDULED_JOBS_INTERVALS,
  RESERVATION_SWEEPER,
  SCHEDULED_JOBS_INTERVALS,
  SHIPMENT_SYNC_SWEEPER,
  ScheduledJobsRunner,
} from "./scheduled-jobs.runner";

/**
 * QueueModule — background job orchestration.
 *
 * OWNS: the recurring cron-style sweeps (spec §5). It imports CatalogModule and
 * CartModule for their already-tested sweep services and binds them to the
 * runner's narrow ports (`RESERVATION_SWEEPER`, `CART_SWEEPER`) so the runner
 * depends on interfaces, not concrete services — the same seam every other
 * module in this codebase uses.
 *
 * The runner does NOT auto-start (see ScheduledJobsRunner for why); importing
 * this module is side-effect free. `apps/api/src/main.ts` calls
 * `ScheduledJobsRunner.start()` once the server is listening, exactly as it does
 * for the outbox runner.
 *
 * The pg-boss producer/consumer ports the spec envisions (Redis-swappable) are a
 * later pass; today the transactional outbox (`OutboxModule`) is the queue and
 * this module is the scheduler.
 */
@Module({
  imports: [CatalogModule, CartModule],
  providers: [
    { provide: RESERVATION_SWEEPER, useExisting: ProductInventoryService },
    { provide: CART_SWEEPER, useExisting: CartService },
    // Sendcloud tracking sweep. Provided HERE (it needs only Prisma) rather than
    // by importing TrackingModule, so the scheduler does not pull the vendor
    // client and the orders graph in behind a timer.
    ShipmentSyncSweep,
    { provide: SHIPMENT_SYNC_SWEEPER, useExisting: ShipmentSyncSweep },
    { provide: SCHEDULED_JOBS_INTERVALS, useValue: DEFAULT_SCHEDULED_JOBS_INTERVALS },
    ScheduledJobsRunner,
  ],
  exports: [ScheduledJobsRunner],
})
export class QueueModule {}
