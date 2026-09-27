import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NextIntlClientProvider } from "next-intl";
import type { BffError } from "@/lib/bff/client";
import { postJson } from "@/lib/bff/client";
import { UnverifiedEmailNotice } from "./unverified-email-notice";
import esMessages from "../../../messages/es.json";

vi.mock("@/lib/bff/client", () => ({
  postJson: vi.fn(async () => ({ ok: true, data: { status: "accepted" } })),
}));

const postJsonMock = vi.mocked(postJson);

/** Mirrors the strict body `POST /api/auth/resend-verification` accepts. */
const resendBodySchema = z
  .object({ email: z.string(), turnstileToken: z.string().min(1) })
  .strict();

const rateLimited: BffError = {
  code: "RATE_LIMITED",
  // English, operator-facing, and deliberately never rendered — the assertions
  // below prove the catalogue message is what reaches the customer instead.
  message: "Too many verification emails requested for this address.",
  fields: null,
  requestId: "req_9f2",
};

function renderNotice() {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <UnverifiedEmailNotice email="elena@example.com" />
    </NextIntlClientProvider>,
  );
}

describe("UnverifiedEmailNotice", () => {
  beforeEach(() => {
    postJsonMock.mockClear();
    postJsonMock.mockResolvedValue({ ok: true, data: { status: "accepted" } });
  });

  it("states the problem, the address and the way out", () => {
    renderNotice();

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("aún no está verificado");
    expect(notice).toHaveTextContent("elena@example.com");
    expect(screen.getByRole("button", { name: "Reenviar el enlace" })).toBeInTheDocument();
  });

  it("posts the address and the turnstile token to the BFF route", async () => {
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: "Reenviar el enlace" }));

    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(postJsonMock.mock.calls[0]?.[0]).toBe("/api/auth/resend-verification");
    // `postJson` declares its body `unknown` and `expect.any` is typed `any`,
    // which the zero-`any` rule forbids even here. Parsing the recorded payload
    // through the same strict shape the route enforces asserts strictly more:
    // both fields present, both strings, and no third field to be rejected.
    const sent = resendBodySchema.parse(postJsonMock.mock.calls[0]?.[1]);
    expect(sent.email).toBe("elena@example.com");
  });

  it("confirms politely and withdraws the control once the link is sent", async () => {
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: "Reenviar el enlace" }));

    // role="status", not role="alert": a confirmation the customer will reach
    // by reading on must not interrupt them mid-sentence.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Te hemos enviado un enlace nuevo",
    );
    // A second press would only invalidate the link they are about to click.
    expect(
      screen.queryByRole("button", { name: "Reenviar el enlace" }),
    ).not.toBeInTheDocument();
  });

  it("announces a failure assertively, from the code and never the server prose", async () => {
    const user = userEvent.setup();
    postJsonMock.mockResolvedValue({ ok: false, error: rateLimited });
    renderNotice();

    await user.click(screen.getByRole("button", { name: "Reenviar el enlace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No hemos podido enviar el enlace");
    expect(alert).toHaveTextContent("Demasiados intentos");
    expect(alert).not.toHaveTextContent("Too many verification emails");
    expect(alert).toHaveTextContent("req_9f2");
    // The way out survives the failure — a dead end is the defect this whole
    // component exists to remove.
    expect(screen.getByRole("button", { name: "Reenviar el enlace" })).toBeInTheDocument();
  });

  it("marks the control busy while the request is in flight", async () => {
    const user = userEvent.setup();
    let release = (): void => {};
    postJsonMock.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, data: { status: "accepted" } });
      }),
    );
    renderNotice();

    await user.click(screen.getByRole("button", { name: "Reenviar el enlace" }));

    const busy = screen.getByRole("button", { name: /Enviando/ });
    expect(busy).toHaveAttribute("aria-busy", "true");

    release();
    expect(await screen.findByText(/Te hemos enviado un enlace nuevo/)).toBeInTheDocument();
  });
});
