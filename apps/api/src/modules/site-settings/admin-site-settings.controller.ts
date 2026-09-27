import { Body, Controller, Patch } from "@nestjs/common";
import { updateSiteSettingsSchema, type SiteSettings, type UpdateSiteSettings } from "@akai/contracts";

import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/guards/roles.guard";
import { SiteSettingsService } from "./site-settings.service";

/**
 * The site-wide admin settings write.
 *
 * A SEPARATE CONTROLLER FROM `SiteSettingsController`, not a second method on
 * it — same reasoning `AdminCategoriesController` gives for its own split
 * from the public `CategoriesController`: "is this endpoint public?" is
 * answered by which file a handler lives in, and putting a role-guarded
 * write beside a `@Public()` read on one class is exactly the shape that
 * lets a forgotten decorator ship an unauthenticated write path.
 *
 * `@Roles` DECLARED AT CLASS LEVEL — a new endpoint added here inherits the
 * restriction by default.
 */
@Controller("admin/site-settings")
@Roles("STAFF", "ADMIN")
export class AdminSiteSettingsController {
  constructor(private readonly settings: SiteSettingsService) {}

  @Patch()
  async update(
    @Body(new ZodValidationPipe(updateSiteSettingsSchema)) body: UpdateSiteSettings,
  ): Promise<SiteSettings> {
    return this.settings.setMaintenanceMode(body.maintenanceMode);
  }
}
