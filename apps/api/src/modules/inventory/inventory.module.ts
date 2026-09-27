import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { AdminInventoryController } from "./admin-inventory.controller";
import { AdminInventoryService } from "./admin-inventory.service";

/**
 * InventoryModule — the admin READ surface over stock.
 *
 * SCOPE NOTE, because the placeholder that used to live here claimed otherwise:
 * atomic decrement, TTL reservations and the commit/release ledger are NOT here.
 * They are implemented and tested in `catalog/product-inventory.service.ts` and
 * exposed under `/v1/admin/products/variants/:variantId/inventory*`. Moving them
 * would rewrite the checkout hot path, so this module owns the one thing that was
 * genuinely missing: a list an operator can scan.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AdminInventoryController],
  providers: [AdminInventoryService],
})
export class InventoryModule {}
