import { Module } from "@nestjs/common";

/**
 * Composition root for the headless worker process.
 *
 * Same domain modules as apps/api, different composition root: this process
 * runs every pg-boss consumer (email, catalog-sync, outbox-dispatch, invoice-pdf,
 * gdpr-export, order-fulfilment) and the cron jobs. It exists as a separate
 * process specifically so a payment webhook handler can ACK in under a second
 * while the real work happens out of band.
 *
 * Shell only — consumers are added by a later pass.
 */
@Module({
  imports: [],
  providers: [],
})
export class WorkerModule {}
