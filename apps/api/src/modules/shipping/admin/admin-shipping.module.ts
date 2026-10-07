import { Module } from "@nestjs/common";

import { PrismaModule } from "../../prisma/prisma.module";
import { AdminShippingController } from "./admin-shipping.controller";
import { AdminShippingService } from "./admin-shipping.service";

/**
 * AdminShippingModule — `/v1/admin/shipping/*`, staff-editable zones and rates.
 *
 * ITS OWN MODULE, NOT A CONTROLLER ON ShippingModule: ShippingModule is the
 * customer-facing quote (it imports CartModule and is what checkout depends
 * on), while this is a staff CRUD surface. The two share the TABLES, not code:
 * this module writes the rows the quote reads live.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AdminShippingController],
  providers: [AdminShippingService],
})
export class AdminShippingModule {}
