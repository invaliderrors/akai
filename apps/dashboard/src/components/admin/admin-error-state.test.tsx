import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { AdminErrorState } from "./admin-error-state";
import { AdminApiError } from "@/lib/admin/http";
import esMessages from "../../../messages/es.json";

/**
 * Admin routes need a second factor proved within 15 minutes, so a working
 * session goes stale while an operator is simply reading a page. That failure is
 * `FORBIDDEN` — the same code as "you are not an admin" — and only the envelope's
 * `reason` separates the one they can fix from the one they cannot.
 *
 * Rendered against the REAL Spanish catalogue rather than a stub: the whole
 * point of this component is that the operator reads our words instead of the
 * API's, so a test that invented its own strings would prove nothing about the
 * sentences that actually ship.
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

/** English, operator-facing, written for a log — and never rendered. */
const LOG_MESSAGE = "Two-factor authentication required";

function forbidden(reason: string | null): AdminApiError {
  return new AdminApiError({
    status: 403,
    code: "FORBIDDEN",
    message: LOG_MESSAGE,
    requestId: "req-42",
    reason,
  });
}

function renderState(cause: unknown, title = "Products could not be loaded") {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AdminErrorState cause={cause} title={title} />
    </NextIntlClientProvider>,
  );
}

describe("<AdminErrorState />", () => {
  it("offers a way back when the second factor has gone STALE", () => {
    renderState(forbidden("TWO_FACTOR_REQUIRED"));

    expect(
      screen.getByRole("link", { name: esMessages.admin.common.twoFactorAction }),
    ).toHaveAttribute("href", "/sign-in");
    expect(screen.getByRole("alert")).toHaveTextContent(esMessages.admin.common.twoFactorTitle);
  });

  it("interrupts assertively, because the page the operator asked for is not there", () => {
    // `Notice` grants `role="alert"` to its danger tone alone. That is the
    // property this branch needs and the reason it is not drawn amber: the
    // panel stands INSTEAD of the requested view, not beside it.
    renderState(forbidden("TWO_FACTOR_REQUIRED"));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("states the enrolment problem WITHOUT sending anyone to a screen that cannot fix it", () => {
    // /security holds a password form and a read-only two-step row; it cannot
    // enrol an authenticator. The old "Go to Security" button pointed at a
    // capability this application does not ship.
    renderState(forbidden("TWO_FACTOR_ENROLMENT_REQUIRED"));

    expect(screen.getByRole("alert")).toHaveTextContent(esMessages.admin.common.enrolmentTitle);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does NOT offer re-authentication for a genuine permission failure", () => {
    // A customer on an admin route is a dead end. "Sign in again" would loop
    // them forever, which is worse than a plain failure.
    renderState(forbidden(null));

    expect(
      screen.queryByRole("link", { name: esMessages.admin.common.twoFactorAction }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Products could not be loaded");
  });

  it("names the permission failure from the catalogue, keyed by the code", () => {
    // FORBIDDEN with no actionable reason really is "you may not do this", and
    // `errors.FORBIDDEN` says so. The old generic "the request failed" made a
    // settled answer look like a transient one worth retrying.
    renderState(forbidden(null));

    expect(screen.getByRole("alert")).toHaveTextContent(esMessages.errors.FORBIDDEN);
  });

  it("NEVER renders the API's own message", () => {
    renderState(forbidden(null));

    // `LOG_MESSAGE` is English written for a log, and it is exactly what used to
    // reach the operator.
    expect(screen.getByRole("alert")).not.toHaveTextContent(LOG_MESSAGE);
  });

  it("surfaces the request ID so a failure can be traced", () => {
    renderState(forbidden(null));
    expect(screen.getByRole("alert")).toHaveTextContent("req-42");
  });

  it("degrades to the generic failure for an UNRECOGNISED reason", () => {
    // Parsed against a closed enum, so a reason added server-side without a
    // client deploy cannot crash the page.
    renderState(forbidden("SOMETHING_NEW"));

    expect(
      screen.queryByRole("link", { name: esMessages.admin.common.twoFactorAction }),
    ).not.toBeInTheDocument();
  });

  it("handles a non-ApiError cause without throwing", () => {
    renderState(new Error("socket hang up"), "Products failed");

    expect(screen.getByRole("alert")).toHaveTextContent("Products failed");
    expect(screen.getByRole("alert")).not.toHaveTextContent("socket hang up");
    // No envelope means no code either; INTERNAL_ERROR is the honest reading of
    // a socket that died before the API answered.
    expect(screen.getByRole("alert")).toHaveTextContent(esMessages.errors.INTERNAL_ERROR);
  });
});
