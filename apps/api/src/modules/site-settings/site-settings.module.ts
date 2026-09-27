import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { SiteSettingsController } from "./site-settings.controller";
import { AdminSiteSettingsController } from "./admin-site-settings.controller";
import {
  SITE_SETTINGS_REPOSITORY,
  PrismaSiteSettingsRepository,
} from "./site-settings.repository";
import { SiteSettingsService } from "./site-settings.service";

/**
 * SiteSettingsModule — the site-wide admin settings singleton row.
 *
 * §2 of `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`:
 * maintenance mode is this module's first (and, today, only) field. See
 * `SiteSettingsService`'s own doc comment for why a write here enqueues no
 * outbox revalidation row — its one reader, the storefront's middleware,
 * does not consult that mechanism.
 */
@Module({
  imports: [PrismaModule, ThrottlerModule],
  controllers: [SiteSettingsController, AdminSiteSettingsController],
  providers: [
    SiteSettingsService,
    { provide: SITE_SETTINGS_REPOSITORY, useClass: PrismaSiteSettingsRepository },
  ],
  exports: [SiteSettingsService],
})
export class SiteSettingsModule {}
