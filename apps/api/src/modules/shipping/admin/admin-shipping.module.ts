import { Module } from "@nestjs/common";

import { FulfilmentModule } from "../../fulfilment/fulfilment.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminSendcloudOptionsService } from "./admin-sendcloud-options.service";
import { AdminShippingController } from "./admin-shipping.controller";
import { AdminShippingService } from "./admin-shipping.service";

/**
 * AdminShippingModule — `/v1/admin/shipping/*`, staff-editable zones and rates
 * (spec `2026-09-24-sendcloud-shipping.md` §7a, plan Phase 5b).
 *
 * ITS OWN MODULE, NOT A CONTROLLER ON ShippingModule: ShippingModule is the
 * customer-facing quote (it imports CartModule and is what checkout depends
 * on), while this is a staff CRUD surface whose only other dependency is the
 * Sendcloud port — importing FulfilmentModule into ShippingModule would couple
 * every quote to the label module's providers for the sake of one admin
 * picker. The two share the TABLES, not code: this module writes the rows the
 * quote reads live.
 */
@Module({
  imports: [PrismaModule, FulfilmentModule],
  controllers: [AdminShippingController],
  providers: [AdminShippingService, AdminSendcloudOptionsService],
})
export class AdminShippingModule {}
