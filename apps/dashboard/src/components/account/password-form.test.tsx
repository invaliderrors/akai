import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { ApiResult } from "@/lib/api/errors";
import { PasswordForm } from "./password-form";
import esMessages from "../../../messages/es.json";

type ChangeResult = ApiResult<undefined>;

const success: ChangeResult = { ok: true, status: 204, data: undefined };

function renderForm(onSubmit?: () => Promise<ChangeResult>) {
  const submit = onSubmit ?? vi.fn(async () => success);

  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <PasswordForm onSubmit={submit} />
    </NextIntlClientProvider>,
  );

  return { submit };
}

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  values: { current?: string; next?: string; confirm?: string },
): Promise<void> {
  const current = values.current ?? "current-password";
  const next = values.next ?? "a-long-enough-passphrase";
  const confirm = values.confirm ?? next;

  if (current !== "") {
    await user.type(screen.getByLabelText(/Contraseña actual/), current);
  }
  if (next !== "") {
    await user.type(screen.getByLabelText(/^Nueva contraseña/), next);
  }
  if (confirm !== "") {
    await user.type(screen.getByLabelText(/Repite la nueva contraseña/), confirm);
  }

  await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
}

describe("PasswordForm", () => {
  it("requires the current password even though the user is signed in", async () => {
    // Without re-authentication this form is a one-click account takeover for
    // anyone who borrows an unlocked session.
    const user = userEvent.setup();
    const { submit } = renderForm();

    await fillAndSubmit(user, { current: "" });

    expect(await screen.findByText("Introduce tu contraseña actual.")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a new password below the 12-character platform floor", async () => {
    const user = userEvent.setup();
    const { submit } = renderForm();

    await fillAndSubmit(user, { next: "short", confirm: "short" });

    expect(
      await screen.findByText("La nueva contraseña debe tener al menos 12 caracteres."),
    ).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation", async () => {
    const user = userEvent.setup();
    const { submit } = renderForm();

    await fillAndSubmit(user, { confirm: "a-different-passphrase" });

    expect(await screen.findByText("Las contraseñas no coinciden.")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports a short password and a mismatch together, not one at a time", async () => {
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user, { next: "short", confirm: "other" });

    expect(
      await screen.findByText("La nueva contraseña debe tener al menos 12 caracteres."),
    ).toBeInTheDocument();
    expect(screen.getByText("Las contraseñas no coinciden.")).toBeInTheDocument();
  });

  it("marks every failing field with aria-invalid", async () => {
    // The messages live in the section footer, one assertive announcement for
    // the group; each control still points at ITS OWN line inside it.
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user, { next: "short", confirm: "other" });

    await waitFor(() => {
      expect(screen.getByLabelText(/^Nueva contraseña/)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
    expect(screen.getByLabelText(/Repite la nueva contraseña/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // Nothing is wrong with the current password, so nothing claims there is.
    expect(screen.getByLabelText(/Contraseña actual/)).not.toHaveAttribute("aria-invalid");
  });

  it("names each failing field's own message rather than the whole summary", async () => {
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user, { next: "short", confirm: "other" });

    const confirmField = await screen.findByLabelText(/Repite la nueva contraseña/);
    const describedBy = confirmField.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();

    const message = describedBy === null ? null : document.getElementById(describedBy);
    expect(message).toHaveTextContent("Las contraseñas no coinciden.");
  });

  it("submits only the current and new passwords, never the confirmation", async () => {
    const user = userEvent.setup();
    const { submit } = renderForm();

    await fillAndSubmit(user, {});

    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
        currentPassword: "current-password",
        newPassword: "a-long-enough-passphrase",
      });
    });
  });

  it("confirms success and says other devices were signed out", async () => {
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user, {});

    expect(
      await screen.findByText(/Se ha cerrado la sesión en el resto de dispositivos/),
    ).toBeInTheDocument();
  });

  it("clears the fields after a successful change", async () => {
    // Leaving a plaintext password in a form control is an unnecessary window
    // for whoever walks past the desk next.
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user, {});

    await waitFor(() => {
      expect(screen.getByLabelText(/Contraseña actual/)).toHaveValue("");
    });
    expect(screen.getByLabelText(/^Nueva contraseña/)).toHaveValue("");
  });

  it("blames the current-password field when the API rejects it", async () => {
    // A wrong current password comes back as an auth failure. Saying "your
    // session expired" would be actively misleading — it has not.
    const user = userEvent.setup();
    renderForm(
      vi.fn(async (): Promise<ChangeResult> => ({
        ok: false,
        status: 401,
        error: {
          code: "UNAUTHENTICATED",
          message: "invalid credentials",
          fields: null,
          reason: null,
          requestId: "req_pw",
        },
      })),
    );

    await fillAndSubmit(user, {});

    expect(
      await screen.findByText("La contraseña actual no es correcta."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Tu sesión ha caducado")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText(/Contraseña actual/)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
  });

  it("shows a banner for an unexpected server failure", async () => {
    const user = userEvent.setup();
    renderForm(
      vi.fn(async (): Promise<ChangeResult> => ({
        ok: false,
        status: 500,
        error: {
          code: "INTERNAL_ERROR",
          message: "Something broke",
          fields: null,
          reason: null,
          requestId: "req_500",
        },
      })),
    );

    await fillAndSubmit(user, {});

    // Translated from the CLOSED code; the API's English is written for a log.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Error del servidor.");
    expect(alert).not.toHaveTextContent("Something broke");
    expect(alert).toHaveTextContent("req_500");
  });

  it("uses password inputs so the values are never displayed", () => {
    renderForm();

    expect(screen.getByLabelText(/Contraseña actual/)).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByLabelText(/^Nueva contraseña/)).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });
});
