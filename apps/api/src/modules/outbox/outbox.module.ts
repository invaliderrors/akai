import { Module } from "@nestjs/common";

import { EmailModule } from "../email/email.module";
import { EmailOutboxHandler } from "../email/email-outbox.handler";
import { PaymentsModule } from "../payments/payments.module";
import { RevalidationModule } from "../revalidation/revalidation.module";
import { RevalidationOutboxHandler } from "../revalidation/revalidation.outbox-handler";
import { AdminJobsController } from "./admin-jobs.controller";
import { AdminJobsService } from "./admin-jobs.service";
import { OutboxDispatcher } from "./outbox.dispatcher";
import {
  OUTBOX_REPOSITORY,
  PrismaOutboxRepository,
} from "./outbox.repository";
import {
  DEFAULT_OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_POLL_INTERVAL_MS,
  OutboxRunner,
} from "./outbox.runner";
import {
  DEFAULT_OUTBOX_POLICY,
  OUTBOX_HANDLERS,
  OUTBOX_POLICY,
  type OutboxHandler,
} from "./outbox.types";

/**
 * OutboxModule — the transactional outbox READ side.
 *
 * Provides the Prisma-backed repository (the `FOR UPDATE SKIP LOCKED` claim),
 * the retry policy, the `OutboxDispatcher` that routes claimed rows to the
 * handler registered for each topic, and the `OutboxRunner` poll loop.
 *
 * HANDLER REGISTRATION. `OUTBOX_HANDLERS` is the list the runner registers on
 * start: the `email` consumer and the `storefront.revalidate` consumer.
 *
 * THE CATALOG-MIRROR CONSUMERS ARE GONE, with the mirror itself. Under
 * TagadaPay a checkout item was `{ variantId, quantity }` with no amount field,
 * so every catalog write had to reach the provider before the variant could be
 * sold and these topics were load-bearing. Whop accepts our computed amount on
 * the checkout call, so publishing a product and being able to sell it are no
 * longer coupled through a queue.
 *
 * As the invoice-pdf and notifications consumers are built they are appended
 * here the same way (and until then, rows for those topics fail routing and
 * surface in the DLQ at /admin/jobs rather than being silently marked done).
 *
 * The runner does NOT start on module init — see OutboxRunner for why — so
 * importing this module (as both AppModule and the integration tests do) is
 * side-effect free. `apps/api/src/main.ts` calls `OutboxRunner.start()` after
 * the server is listening.
 */
@Module({
  imports: [EmailModule, PaymentsModule, RevalidationModule],
  providers: [
    PrismaOutboxRepository,
    { provide: OUTBOX_REPOSITORY, useExisting: PrismaOutboxRepository },
    { provide: OUTBOX_POLICY, useValue: DEFAULT_OUTBOX_POLICY },
    { provide: OUTBOX_POLL_INTERVAL_MS, useValue: DEFAULT_OUTBOX_POLL_INTERVAL_MS },
    {
      provide: OUTBOX_HANDLERS,
      inject: [EmailOutboxHandler, RevalidationOutboxHandler],
      useFactory: (
        email: EmailOutboxHandler,
        revalidation: RevalidationOutboxHandler,
      ): readonly OutboxHandler[] => [email, revalidation],
    },
    OutboxDispatcher,
    OutboxRunner,
    AdminJobsService,
  ],
  controllers: [AdminJobsController],
  exports: [OutboxDispatcher, OutboxRunner, OUTBOX_REPOSITORY, OUTBOX_POLICY],
})
export class OutboxModule {}
