import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import esMessages from "../../../../../messages/es.json";

/**
 * The site-wide settings screen's server wiring.
 *
 * The form's own interaction (dirty-state gating, save success/failure) has
 * its own suite in `site-settings-form.test.tsx`; what is worth pinning here
 * is that this page reads through `GET /site-settings` and that a failed
 * fetch renders the shared error state instead of an unhandled rejection.
 */

const getSiteSettings = vi.fn<(http: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const { createTranslator } = await import("next-intl");
    const messages: Record<string, unknown> = esMessages;
    return namespace === undefined
      ? createTranslator({ locale: "es", messages })
      : createTranslator({ locale: "es", messages, namespace });
  },
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  getSiteSettings: (http: unknown) => getSiteSettings(http),
}));
vi.mock("@/lib/admin/actions", () => ({
  updateSiteSettingsAction: vi.fn(),
}));

const { default: AdminSettingsPage } = await import("./page");

async function renderSettingsPage() {
  const element = await AdminSettingsPage();
  render(<NextIntlClientProvider locale="es" messages={esMessages}>{element}</NextIntlClientProvider>);
}

describe("AdminSettingsPage", () => {
  it("fetches the site settings", async () => {
    getSiteSettings.mockResolvedValue({ maintenanceMode: false });

    await renderSettingsPage();

    expect(getSiteSettings).toHaveBeenCalledWith(expect.anything());
  });

  it("renders the form checked when maintenance mode is already on", async () => {
    getSiteSettings.mockResolvedValue({ maintenanceMode: true });

    await renderSettingsPage();

    expect(
      screen.getByRole("checkbox", { name: esMessages.admin.siteSettings.maintenanceModeLabel }),
    ).toBeChecked();
  });

  it("renders the shared error state, not an unhandled rejection, when the fetch fails", async () => {
    getSiteSettings.mockRejectedValue(new Error("upstream down"));

    await renderSettingsPage();

    expect(screen.getByText(esMessages.admin.siteSettings.loadErrorTitle)).toBeInTheDocument();
  });
});
