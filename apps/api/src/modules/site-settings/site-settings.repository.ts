import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

/**
 * The site settings read/write seam.
 *
 * A port, matching `CATEGORIES_REPOSITORY` — so `SiteSettingsService` is
 * unit-testable against an in-memory double, and this Prisma adapter stays a
 * single upsert/read pair with no branching worth hiding a bug in.
 */
export interface SiteSettingsRow {
  readonly maintenanceMode: boolean;
}

export interface SiteSettingsRepository {
  get(): Promise<SiteSettingsRow>;
  setMaintenanceMode(maintenanceMode: boolean): Promise<SiteSettingsRow>;
}

export const SITE_SETTINGS_REPOSITORY = Symbol("SITE_SETTINGS_REPOSITORY");

@Injectable()
export class PrismaSiteSettingsRepository implements SiteSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `upsert`, not `findUniqueOrThrow`. The row is seeded by its own migration
   * (`20260927000100_invariants`), but ANYTHING that can empty the table —
   * a restore from a dump taken before that migration, a reset between
   * integration-test runs — must not turn every storefront page load into a
   * 500. Reading is therefore self-seeding the same way `allocate_invoice_number()`
   * is: the row always exists after this call, defaulting to "not in
   * maintenance" if it was ever missing.
   */
  async get(): Promise<SiteSettingsRow> {
    const row = await this.prisma.siteSettings.upsert({
      where: { id: true },
      update: {},
      create: { id: true, maintenanceMode: false },
      select: { maintenanceMode: true },
    });
    return { maintenanceMode: row.maintenanceMode };
  }

  async setMaintenanceMode(maintenanceMode: boolean): Promise<SiteSettingsRow> {
    const row = await this.prisma.siteSettings.upsert({
      where: { id: true },
      update: { maintenanceMode },
      create: { id: true, maintenanceMode },
      select: { maintenanceMode: true },
    });
    return { maintenanceMode: row.maintenanceMode };
  }
}
