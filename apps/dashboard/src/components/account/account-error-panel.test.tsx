import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { ErrorCode } from "@akai/contracts";
import type { ApiError } from "@/lib/api/errors";
import { AccountErrorPanel } from "./account-error-panel";
import esMessages from "../../../messages/es.json";

/**
 * The sign-in affordance is a `Link`, which needs a router this
 * render has no business standing up. Mocked to a plain anchor so the assertion
 * can be about the accessible name and the destination, which is all this
 * component decides.
 */
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

/**
 * English, operator-facing, and deliberately never rendered — every assertion
 * below proves the catalogue sentence is what reaches the customer instead.
 */
const LOG_MESSAGE = "upstream timeout contacting orders-projection";

function buildError(code: ErrorCode, requestId = "req_8f21"): ApiError {
  return { code, message: LOG_MESSAGE, fields: null, reason: null, requestId };
}

function renderPanel(error: ApiError) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AccountErrorPanel title="Pedidos" error={error} />
    </NextIntlClientProvider>,
  );
}

describe("AccountErrorPanel", () => {
  it("keeps the page's own heading above the failure", () => {
    renderPanel(buildError("INTERNAL_ERROR"));

    // The sense of place: a customer who fails on their orders page must still
    // be able to see that it is their orders page that failed.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pedidos");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("states the failure once, in the catalogue's words", () => {
    renderPanel(buildError("INTERNAL_ERROR"));

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);

    const alert = alerts[0];
    expect(alert).toBeDefined();
    if (alert === undefined) return;

    expect(alert).toHaveTextContent(esMessages.account.common.errorTitle);
    expect(alert).toHaveTextContent(esMessages.errors.INTERNAL_ERROR);
    expect(within(alert).queryByText(LOG_MESSAGE)).toBeNull();
  });

  it("offers the request id as something to quote to support", () => {
    renderPanel(buildError("INTERNAL_ERROR", "req_8f21"));

    expect(
      screen.getByRole("button", { name: "Referencia: req_8f21" }),
    ).toBeInTheDocument();
  });

  it("says nothing about a reference when the request never reached the API", () => {
    // "Referencia:" with nothing after it is worse than showing nothing: it
    // invites a support conversation that starts with a blank.
    renderPanel(buildError("INTERNAL_ERROR", ""));

    expect(screen.queryByText(/Referencia/)).toBeNull();
  });

  it("tells a customer whose session died to sign in again, not that their password is wrong", () => {
    renderPanel(buildError("UNAUTHENTICATED"));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(esMessages.account.common.sessionExpiredTitle);
    expect(alert).toHaveTextContent(esMessages.account.common.sessionExpiredBody);

    // The reason this branch exists at all: the `errors` namespace phrases
    // UNAUTHENTICATED for the sign-in form, and that sentence here would send
    // someone off to reset a password that is perfectly good.
    expect(within(alert).queryByText(esMessages.errors.UNAUTHENTICATED)).toBeNull();

    expect(screen.getByRole("link", { name: esMessages.account.common.signIn })).toHaveAttribute(
      "href",
      "/sign-in",
    );
  });

  it("still names the page it was on when the session died", () => {
    renderPanel(buildError("UNAUTHENTICATED"));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pedidos");
  });
});
