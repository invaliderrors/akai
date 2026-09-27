import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { SiteSettings } from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { SiteSettingsService } from "./site-settings.service";

/**
 * The public site settings read. Read-only, unauthenticated, one verb.
 *
 * UNAUTHENTICATED ON PURPOSE. The one caller that matters is
 * `apps/storefront/src/middleware.ts`, which has no session to prove — it is
 * deciding, on every request, whether ONE HAS BEEN ESTABLISHED yet. Same
 * reasoning `CategoriesController` gives for its own public list: writes live
 * on the admin surface (`PATCH /admin/site-settings`), on a different
 * controller behind a role guard, so "is this endpoint public?" is answered
 * by which FILE it is in.
 */
@ApiTags("site-settings")
@Controller("site-settings")
export class SiteSettingsController {
  constructor(private readonly settings: SiteSettingsService) {}

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get()
  @ApiOperation({ summary: "Read the site-wide admin settings" })
  async get(): Promise<SiteSettings> {
    return this.settings.get();
  }
}
