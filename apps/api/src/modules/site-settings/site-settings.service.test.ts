import { describe, expect, it, vi } from "vitest";
import { siteSettingsSchema } from "@akai/contracts";

import { SiteSettingsService } from "./site-settings.service";
import type { SiteSettingsRepository, SiteSettingsRow } from "./site-settings.repository";

function repositoryOf(row: SiteSettingsRow): SiteSettingsRepository {
  const setMaintenanceMode = vi.fn(async (maintenanceMode: boolean) => {
    row = { maintenanceMode };
    return row;
  });
  return {
    get: () => Promise.resolve(row),
    setMaintenanceMode,
  };
}

describe("SiteSettingsService.get", () => {
  it("returns a payload that satisfies the published contract", async () => {
    const service = new SiteSettingsService(repositoryOf({ maintenanceMode: false }));

    const result = await service.get();

    expect(siteSettingsSchema.parse(result)).toEqual(result);
  });

  it("reports the stored flag, on or off", async () => {
    expect((await new SiteSettingsService(repositoryOf({ maintenanceMode: true })).get())
      .maintenanceMode).toBe(true);
    expect((await new SiteSettingsService(repositoryOf({ maintenanceMode: false })).get())
      .maintenanceMode).toBe(false);
  });
});

describe("SiteSettingsService.setMaintenanceMode", () => {
  it("writes the new value through the repository and returns it", async () => {
    const repository = repositoryOf({ maintenanceMode: false });
    const service = new SiteSettingsService(repository);

    const result = await service.setMaintenanceMode(true);

    expect(repository.setMaintenanceMode).toHaveBeenCalledWith(true);
    expect(result).toEqual({ maintenanceMode: true });
  });

  it("round-trips false as well as true — turning maintenance off is a real write, not a no-op", async () => {
    const repository = repositoryOf({ maintenanceMode: true });
    const service = new SiteSettingsService(repository);

    const result = await service.setMaintenanceMode(false);

    expect(repository.setMaintenanceMode).toHaveBeenCalledWith(false);
    expect(result).toEqual({ maintenanceMode: false });
  });
});
