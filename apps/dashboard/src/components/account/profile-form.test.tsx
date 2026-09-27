import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { Customer } from "@akai/contracts";
import type { ApiResult } from "@/lib/api/errors";
import { postJson } from "@/lib/bff/client";
import { ProfileForm } from "./profile-form";
import { buildCustomer } from "@/lib/account/fixtures";
import esMessages from "../../../messages/es.json";

/**
 * The resend affordance posts to the BFF route directly — the endpoint is
 * bot-protected and rate-limited per IP — so the transport is mocked at the
 * module boundary rather than `fetch` being stubbed under it.
 */
vi.mock("@/lib/bff/client", () => ({ postJson: vi.fn() }));

const postJsonMock = vi.mocked(postJson);

type SaveResult = ApiResult<Customer>;

beforeEach(() => {
  // Braced deliberately. `beforeEach(() => mock.mockReset())` returns the mock,
  // and Vitest treats a value returned from a hook as a TEARDOWN callback — so
  // the mock would be invoked once more after every test with nobody awaiting
  // it, surfacing as an unhandled rejection blamed on the test that passed.
  postJsonMock.mockReset();
});

function renderForm(options: {
  customer?: Customer;
  onSave?: (input: unknown) => Promise<SaveResult>;
}) {
  const customer = options.customer ?? buildCustomer();
  const onSave =
    options.onSave ??
    vi.fn(async (): Promise<SaveResult> => ({ ok: true, status: 200, data: customer }));

  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ProfileForm customer={customer} onSave={onSave} />
    </NextIntlClientProvider>,
  );

  return { onSave, customer };
}

/** The address in the fixture has never been confirmed. */
function unverified(): Customer {
  return buildCustomer({ emailVerifiedAt: null });
}

describe("ProfileForm", () => {
  it("pre-fills the form from the customer", () => {
    renderForm({});

    expect(screen.getByLabelText(/Nombre/)).toHaveValue("Elena");
    expect(screen.getByLabelText(/Apellidos/)).toHaveValue("Ruiz");
  });

  it("shows the email as a value with no control behind it", () => {
    // Changing an email is an identity operation requiring re-verification, so
    // the API's update schema omits the field entirely. It is displayed — it is
    // the thing a customer opens this screen to check — but there is nothing
    // here to type into.
    renderForm({});

    expect(screen.getByText("elena@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Correo electrónico/)).not.toBeInTheDocument();
  });

  it("has no language row — the account menu is the single language affordance", () => {
    renderForm({});

    expect(screen.queryByLabelText(/Idioma/)).not.toBeInTheDocument();
  });

  it("submits trimmed values and never the locale it no longer owns", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm({});

    const firstName = screen.getByLabelText(/^Nombre/);
    await user.clear(firstName);
    await user.type(firstName, "  Elena María  ");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        firstName: "Elena María",
        lastName: "Ruiz",
        phone: null,
      });
    });
  });

  it("sends null rather than an empty string for a cleared phone", async () => {
    // "" would persist an empty string that renders as a blank line on every
    // future invoice; null is how the contract spells "no phone".
    const user = userEvent.setup();
    const { onSave } = renderForm({
      customer: buildCustomer({ phone: "+34600111222" }),
    });

    await user.clear(screen.getByLabelText(/Teléfono/));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ phone: null }),
      );
    });
  });

  it("blocks submission and reports the field when a required name is blank", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm({});

    await user.clear(screen.getByLabelText(/^Nombre/));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Introduce tu nombre.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("marks an invalid field with aria-invalid so it is announced", async () => {
    const user = userEvent.setup();
    renderForm({});

    await user.clear(screen.getByLabelText(/^Nombre/));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Nombre/)).toHaveAttribute("aria-invalid", "true");
    });
  });

  it("confirms a successful save", async () => {
    const user = userEvent.setup();
    renderForm({});

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Perfil actualizado.")).toBeInTheDocument();
  });

  it("clears the success notice as soon as the customer edits again", async () => {
    // Leaving "Saved." on screen while the user types new values tells them
    // their in-progress edits are already stored. They are not.
    const user = userEvent.setup();
    renderForm({});

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByText("Perfil actualizado.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Teléfono/), "6");

    await waitFor(() => {
      expect(screen.queryByText("Perfil actualizado.")).not.toBeInTheDocument();
    });
  });

  it("renders server-side field errors inline on the offending input", async () => {
    const user = userEvent.setup();
    renderForm({
      onSave: vi.fn(
        async (): Promise<SaveResult> => ({
          ok: false,
          status: 400,
          error: {
            code: "VALIDATION_FAILED",
            message: "Validation failed",
            fields: [{ path: "phone", message: "Ese teléfono no es válido" }],
            reason: null,
            requestId: "req_v",
          },
        }),
      ),
    });

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Ese teléfono no es válido")).toBeInTheDocument();
    // A validation failure belongs on the field, not in a second banner saying
    // the same thing less usefully — and five fields failing at once must not
    // produce five simultaneous assertive announcements.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a banner for failures that are not field-specific", async () => {
    const user = userEvent.setup();
    renderForm({
      onSave: vi.fn(
        async (): Promise<SaveResult> => ({
          ok: false,
          status: 500,
          error: {
            code: "INTERNAL_ERROR",
            message: "Something broke",
            fields: null,
            reason: null,
            requestId: "req_500",
          },
        }),
      ),
    });

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    const alert = await screen.findByRole("alert");
    // Translated from the CLOSED code. The API's own English is written for a
    // log and must never reach a customer.
    expect(alert).toHaveTextContent("Error del servidor.");
    expect(alert).not.toHaveTextContent("Something broke");
    expect(alert).toHaveTextContent("req_500");
  });

  it("disables the controls while a save is in flight", async () => {
    const user = userEvent.setup();
    // `release` starts as a real function so its type stays callable: assigning
    // to a `| null` variable from inside a promise executor leaves TypeScript
    // believing it is still null at every later read.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    renderForm({
      onSave: vi.fn(async (): Promise<SaveResult> => {
        await gate;
        return { ok: true, status: 200, data: buildCustomer() };
      }),
    });

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    });
    expect(screen.getByLabelText(/^Nombre/)).toBeDisabled();

    release();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeEnabled();
    });
  });

  it("says nothing about verification when the address is already verified", () => {
    renderForm({});

    expect(screen.queryByText("Sin verificar")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reenviar verificación" }),
    ).not.toBeInTheDocument();
  });

  it("badges an unverified address and offers to resend the link", () => {
    // A customer told there is a problem with no way to fix it is the defect.
    renderForm({ customer: unverified() });

    expect(screen.getByText("Sin verificar")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reenviar verificación" }),
    ).toBeInTheDocument();
  });

  it("resends the verification link to the customer's own address", async () => {
    const user = userEvent.setup();
    postJsonMock.mockResolvedValue({ ok: true, data: { status: "accepted" } });
    renderForm({ customer: unverified() });

    await user.click(screen.getByRole("button", { name: "Reenviar verificación" }));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith(
        "/api/auth/resend-verification",
        expect.objectContaining({ email: "elena@example.com" }),
        expect.anything(),
      );
    });
    expect(
      await screen.findByText("Te hemos enviado un enlace nuevo. Revisa tu correo."),
    ).toBeInTheDocument();
  });

  it("says so when the resend does not go through", async () => {
    const user = userEvent.setup();
    postJsonMock.mockResolvedValue({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "too many requests",
        fields: null,
        requestId: "req_rl",
      },
    });
    renderForm({ customer: unverified() });

    await user.click(screen.getByRole("button", { name: "Reenviar verificación" }));

    expect(
      await screen.findByText("No hemos podido enviar el enlace. Inténtalo de nuevo."),
    ).toBeInTheDocument();
    // The server's own words never reach the customer.
    expect(screen.queryByText(/too many requests/)).not.toBeInTheDocument();
  });
});
