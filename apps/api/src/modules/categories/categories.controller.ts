import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { CategoryListResponse } from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { CategoriesService } from "./categories.service";

/**
 * The public category list. Read-only, unauthenticated, one verb.
 *
 * Writes live on the admin surface (`PUT /v1/admin/products/:id/categories`),
 * on a different controller behind a role guard — so "is this endpoint public?"
 * is answered by which FILE it is in, not by scanning each method for a
 * decorator that might have been forgotten. Same rule the catalog follows.
 */
@ApiTags("catalog")
@Controller("categories")
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /** Takes no parameters: there is one language and no filter. */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get()
  @ApiOperation({ summary: "List visible categories with shopper-visible product counts" })
  async list(): Promise<CategoryListResponse> {
    return this.categories.list();
  }
}
