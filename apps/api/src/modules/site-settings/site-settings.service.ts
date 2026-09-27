import { Inject, Injectable } from "@nestjs/common";
import type { SiteSettings } from "@akai/contracts";

import {
  SITE_SETTINGS_REPOSITORY,
  type SiteSettingsRepository,
} from "./site-settings.repository";

/**
 * The site-wide admin settings — today, exactly one field.
 *
 * Deliberately thin, matching `CategoriesService`: the interesting decision
 * (self-seeding the singleton row) lives in the repository next to the SQL
 * that must honour it, not spread across a service that would have to
 * re-derive it.
 */
@Injectable()
export class SiteSettingsService {
  constructor(
    @Inject(SITE_SETTINGS_REPOSITORY)
    private readonly repository: SiteSettingsRepository,
  ) {}

  async get(): Promise<SiteSettings> {
    return this.repository.get();
  }

  /**
   * NO OUTBOX REVALIDATION ROW HERE, unlike every catalog write. That
   * mechanism purges the storefront's Next.js Data Cache tags — irrelevant to
   * this flag, because `apps/storefront/src/middleware.ts` never reads it
   * through `fetch`'s tag-based cache at all; it polls `GET /v1/site-settings`
   * through its own short-TTL in-memory cache (see that file). A revalidation
   * row here would purge nothing this flag's one reader consults.
   */
  async setMaintenanceMode(maintenanceMode: boolean): Promise<SiteSettings> {
    return this.repository.setMaintenanceMode(maintenanceMode);
  }
}
