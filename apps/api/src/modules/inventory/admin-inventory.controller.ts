import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  inventoryListQuerySchema,
  type InventoryListQuery,
  type InventoryRow,
  type Paginated,
} from "@akai/contracts";

import { Roles } from "../auth/guards/roles.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AdminInventoryService } from "./admin-inventory.service";

/**
 * The admin stock surface.
 *
 * STAFF and ADMIN only, declared at CLASS level so a handler added later inherits
 * the restriction rather than shipping an open read path if someone forgets the
 * decorator.
 *
 * READ ONLY, and that is a decision rather than an omission: adjusting stock and
 * setting a variant's policy are already served, with the concurrency guards that
 * make them correct, at `/v1/admin/products/variants/:variantId/inventory/adjust`
 * and `/policy`. The dashboard's inventory page links to those rather than this
 * module growing a second write path to the same rows.
 */
@ApiTags("admin-inventory")
@Controller("admin/inventory")
@Roles("STAFF", "ADMIN")
export class AdminInventoryController {
  constructor(private readonly inventory: AdminInventoryService) {}

  @Get()
  @ApiOperation({
    summary: "Stock levels across every variant, including UNTRACKED ones",
    description:
      "Left-joins inventory, so a variant with no inventory record appears with tracked=false. Those variants are unsellable and are invisible in every other listing.",
  })
  async list(
    @Query(new ZodValidationPipe(inventoryListQuerySchema)) query: InventoryListQuery,
  ): Promise<Paginated<InventoryRow>> {
    return this.inventory.list(query);
  }
}
