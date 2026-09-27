import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { BffError } from "@/lib/bff/client";

import { Alert, ErrorAlert, type AlertTone } from "./alert";
import esMessages from "../../../messages/es.json";

function renderIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

function buildError(overrides: Partial<BffError> = {}): BffError {
  return {
    code: "UNAUTHENTICATED",
    message: "invalid credentials",
    fields: null,
    requestId: "req_abc123",
    ...overrides,
  };
}

/** Every tone that must NOT interrupt a screen reader. */
const POLITE_TONES: readonly AlertTone[] = ["ok", "info"];

describe("<Alert />", () => {
  it("interrupts for a failure and only for a failure", () => {
    renderIntl(<Alert tone="error">No hemos podido iniciar sesión.</Alert>);

    expect(screen.getByRole("alert")).toHaveTextContent("No hemos podido iniciar sesión.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(POLITE_TONES)("announces a %s alert politely, never assertively", (tone) => {
    // An assertive region that keeps arriving with good news is one people learn
    // to tune out, which costs exactly the failure it was reserved for.
    renderIntl(<Alert tone={tone}>Te hemos enviado un enlace.</Alert>);

    expect(screen.getByRole("status")).toHaveTextContent("Te hemos enviado un enlace.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders rich children, not just a string", () => {
    // Three auth screens pass a bold lead line followed by body copy.
    renderIntl(
      <Alert tone="ok">
        <strong>Revisa tu correo</strong>
        Te hemos enviado un enlace.
      </Alert>,
    );

    expect(screen.getByText("Revisa tu correo")).toBeInTheDocument();
  });

  it("shows the request id as quotable text rather than hiding it in a title", () => {
    // Someone reading it out to support has to be able to SEE it; a title
    // attribute appears on hover, which is neither on a phone nor for anyone
    // using a keyboard.
    renderIntl(
      <Alert tone="error" requestId="req_abc123">
        Algo ha ido mal.
      </Alert>,
    );

    expect(screen.getByText("Referencia: req_abc123")).toBeInTheDocument();
  });

  it("says nothing at all when there is no reference to quote", () => {
    // A failure that never reached the API has no id. "Referencia:" with
    // nothing after it is worse than showing nothing.
    renderIntl(
      <Alert tone="error" requestId="">
        Algo ha ido mal.
      </Alert>,
    );

    expect(screen.queryByText(/Referencia:/)).not.toBeInTheDocument();
  });
});

describe("<ErrorAlert />", () => {
  it("translates the machine-readable code and never shows the API's English", () => {
    renderIntl(<ErrorAlert error={buildError()} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Correo o contraseña incorrectos.");
    // `error.message` is written for an operator's log. Rendering it to a
    // Spanish-default customer is the failure this component exists to prevent.
    expect(alert).not.toHaveTextContent("invalid credentials");
  });

  it("carries the request id through so a failure stays reportable", () => {
    renderIntl(<ErrorAlert error={buildError({ requestId: "req_zzz" })} />);

    expect(screen.getByText("Referencia: req_zzz")).toBeInTheDocument();
  });

  it("falls back to the generic message when the catalogue has not caught up", () => {
    // Simulated by a locale whose `errors` namespace is missing the code, which
    // is exactly the shape of the real hazard: a code added to the contract
    // before both message files gained an entry for it. The customer gets a
    // sentence rather than a blank banner.
    render(
      <NextIntlClientProvider
        locale="es"
        messages={{
          errors: {
            generic: "Algo ha ido mal. Inténtalo de nuevo.",
            requestId: "Referencia: {id}",
          },
        }}
      >
        <ErrorAlert error={buildError({ code: "CONFLICT", message: "state conflict" })} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Algo ha ido mal. Inténtalo de nuevo.");
  });
});
