import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  categoryListQuerySchema,
  type CategoryListQuery,
  type CategoryListResponse,
} from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

  /**
   * `locale` does not FILTER — it orders.
   *
   * The response carries every locale's name (`name: Record<locale, string>`),
   * exactly as products do, so the storefront resolves the display language
   * client-side and a language switch needs no refetch. What the parameter does
   * affect is tie-breaking: categories sharing a `sortOrder` come back
   * alphabetical in the requested language rather than alphabetical in Spanish
   * for every visitor.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get()
  @ApiOperation({ summary: "List visible categories with shopper-visible product counts" })
  async list(
    @Query(new ZodValidationPipe(categoryListQuerySchema))
    query: CategoryListQuery,
  ): Promise<CategoryListResponse> {
    return this.categories.list(query.locale);
  }
}
