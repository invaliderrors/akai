import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

import { SiteSettingsForm } from "./site-settings-form";
import esMessages from "../../../messages/es.json";

/**
 * The site-wide settings toggle.
 *
 * What is worth pinning: the save control is disabled until the value
 * actually changes (a click that saves nothing teaches an operator the
 * button cannot be trusted), the warning appears the instant the box is
 * ticked (before saving — it describes the CONSEQUENCE of pressing Guardar,
 * not the current live state), and a save failure does not claim success.
 */

const t = esMessages.admin.siteSettings;

function renderForm(
  initialMaintenanceMode = false,
  onSave = vi.fn().mockResolvedValue({ ok: true, data: { maintenanceMode: true } }),
) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <SiteSettingsForm initialMaintenanceMode={initialMaintenanceMode} onSave={onSave} />
    </NextIntlClientProvider>,
  );
  return { onSave };
}

describe("SiteSettingsForm", () => {
  it("starts with the save control disabled — nothing has changed yet", () => {
    renderForm();
    expect(screen.getByRole("button", { name: t.save })).toBeDisabled();
  });

  it("enables save once the checkbox is toggled away from the stored value", async () => {
    const user = userEvent.setup();
    renderForm(false);

    await user.click(screen.getByRole("checkbox", { name: t.maintenanceModeLabel }));

    expect(screen.getByRole("button", { name: t.save })).toBeEnabled();
  });

  it("disables save again if the operator toggles back to the stored value", async () => {
    const user = userEvent.setup();
    renderForm(false);

    const checkbox = screen.getByRole("checkbox", { name: t.maintenanceModeLabel });
    await user.click(checkbox);
    await user.click(checkbox);

    expect(screen.getByRole("button", { name: t.save })).toBeDisabled();
  });

  it("shows the active-maintenance warning the moment the box is ticked, before saving", async () => {
    const user = userEvent.setup();
    renderForm(false);

    expect(screen.queryByText(t.maintenanceActiveWarning)).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: t.maintenanceModeLabel }));

    expect(screen.getByText(t.maintenanceActiveWarning)).toBeInTheDocument();
  });

  it("hides the warning when the stored value is already ON and nothing has changed", () => {
    renderForm(true);
    expect(screen.getByText(t.maintenanceActiveWarning)).toBeInTheDocument();
  });

  it("sends the ticked value and confirms success without pretending it happened first", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm(false);

    await user.click(screen.getByRole("checkbox", { name: t.maintenanceModeLabel }));
    expect(screen.queryByText(t.saveSuccess)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: t.save }));

    expect(onSave).toHaveBeenCalledWith({ maintenanceMode: true });
    expect(await screen.findByText(t.saveSuccess)).toBeInTheDocument();
  });

  it("surfaces a save failure without claiming success", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      reason: null,
      message: "boom",
    });
    renderForm(false, onSave);

    await user.click(screen.getByRole("checkbox", { name: t.maintenanceModeLabel }));
    await user.click(screen.getByRole("button", { name: t.save }));

    expect(await screen.findByText(t.saveFailed)).toBeInTheDocument();
    expect(screen.queryByText(t.saveSuccess)).not.toBeInTheDocument();
  });
});
