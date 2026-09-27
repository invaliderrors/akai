import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ActionResult } from "@/lib/admin/actions";
import type { PartnerLoginStatus } from "@/lib/admin/schemas";
import esMessages from "../../../messages/es.json";

const activatePartnerLoginAction =
  vi.fn<(affiliateId: string) => Promise<ActionResult<PartnerLoginStatus>>>();

vi.mock("@/lib/admin/actions", () => ({
  activatePartnerLoginAction: (affiliateId: string) => activatePartnerLoginAction(affiliateId),
}));

const { PartnerLoginPanel } = await import("./partner-login-panel");

const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";

function renderPanel(overrides: Partial<{ hasLogin: boolean; email: string }> = {}) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <PartnerLoginPanel
        affiliateId={AFFILIATE_ID}
        hasLogin={overrides.hasLogin ?? false}
        email={overrides.email ?? "ana@example.com"}
      />
    </NextIntlClientProvider>,
  );
}

describe("<PartnerLoginPanel />", () => {
  beforeEach(() => {
    activatePartnerLoginAction.mockReset();
  });

  it("shows Activate and calls the action with this affiliate's id when there is no login yet", async () => {
    activatePartnerLoginAction.mockResolvedValue({
      ok: true,
      data: { active: true, email: "ana@example.com" },
    });
    const user = userEvent.setup();
    renderPanel({ hasLogin: false });

    expect(screen.getByRole("button", { name: "Activar acceso" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activar acceso" }));

    expect(activatePartnerLoginAction).toHaveBeenCalledWith(AFFILIATE_ID);
    expect(await screen.findByText(/se ha enviado/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reenviar correo de contraseña" })).toBeInTheDocument();
  });

  it("shows Resend, not Activate, when a login is already active", () => {
    renderPanel({ hasLogin: true });
    expect(screen.getByRole("button", { name: "Reenviar correo de contraseña" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar acceso" })).not.toBeInTheDocument();
  });

  it("shows the conflict message rather than a generic failure when the email is already taken", async () => {
    activatePartnerLoginAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: null,
      message: "server-authored english",
    });
    const user = userEvent.setup();
    renderPanel({ hasLogin: false });

    await user.click(screen.getByRole("button", { name: "Activar acceso" }));

    expect(await screen.findByText(/ya existe una cuenta de cliente/i)).toBeInTheDocument();
    expect(screen.queryByText(/server-authored english/)).toBeNull();
    // A failed activation must not flip the button to "resend".
    expect(screen.getByRole("button", { name: "Activar acceso" })).toBeInTheDocument();
  });
});
