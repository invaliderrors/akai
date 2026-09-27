import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { IdempotencyService } from "./idempotency.service";

/**
 * IdempotencyModule — replay protection for money-creating POSTs.
 *
 * The placeholder said exactly that, and meanwhile the ONE money-creating POST
 * in the platform (`POST /v1/checkout`) read no `Idempotency-Key` header at all,
 * while the only implementation of the mechanism sat inside AdminModule under
 * the name `AdminIdempotencyService` — with its own comment admitting the logic
 * was not admin-specific and belonged here. The class is moved, not copied:
 * `reserve-then-execute` on a primary key is the kind of thing that must have
 * exactly one implementation, because a second one written from memory will
 * check-then-write and race straight through the gap it exists to close.
 *
 * Exported for AdminModule (bulk import/export) and CheckoutModule (order
 * creation). Both go through the same reservation table and the same
 * request-hash comparison, so a key replayed with a different body is a 409 on
 * both surfaces rather than a silent replay on one of them.
 */
@Module({
  imports: [PrismaModule],
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
