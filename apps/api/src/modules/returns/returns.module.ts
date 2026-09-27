import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { AdminReturnsController, ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";

/**
 * ReturnsModule — customer RMA requests and the operator decisions on them.
 *
 * IT DOES NOT REFUND. `POST /v1/admin/orders/:orderNumber/refunds` already does
 * that, through the payment provider and under an idempotency key. This module
 * records the decision; money moves in one place only.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ReturnsController, AdminReturnsController],
  providers: [ReturnsService],
})
export class ReturnsModule {}
