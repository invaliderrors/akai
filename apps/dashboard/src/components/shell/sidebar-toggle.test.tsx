import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import esMessages from "../../../messages/es.json";
import { SIDEBAR_COOKIE_NAME, isSidebarHidden } from "./sidebar-cookie";

/**
 * The sidebar toggle, and the cookie it is the only writer of.
 *
 * The cookie exists because the sidebar is server-rendered: the preference has
 * to be readable BEFORE the first byte or a collapsed sidebar flashes open on
 * every navigation. So the two assertions that matter are that a press writes
 * the value the server will later read, and that it then asks for a fresh RSC
 * payload — a write with no refresh looks like a dead button.
 */

const refresh = vi.fn<() => void>();

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh }),
}));

const { SidebarToggle } = await import("./sidebar-toggle");

function renderToggle(hidden: boolean) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <SidebarToggle hidden={hidden} />
    </NextIntlClientProvider>,
  );
}

function currentCookie(): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === SIDEBAR_COOKIE_NAME) {
      return rest.join("=");
    }
  }
  return undefined;
}

function clearCookie(): void {
  document.cookie = `${SIDEBAR_COOKIE_NAME}=; Path=/; Max-Age=0`;
}

// jsdom keeps cookies for the lifetime of the file, so a value written by one
// test is still there for the next one.
beforeEach(() => {
  refresh.mockReset();
  clearCookie();
});

afterEach(() => {
  clearCookie();
});

describe("isSidebarHidden()", () => {
  it("treats an absent cookie as shown", () => {
    // A first-time operator who cannot see the navigation has no way to
    // discover the control that would bring it back.
    expect(isSidebarHidden(undefined)).toBe(false);
  });

  it("treats anything but the hidden marker as shown", () => {
    expect(isSidebarHidden("shown")).toBe(false);
    expect(isSidebarHidden("nonsense")).toBe(false);
    expect(isSidebarHidden("hidden")).toBe(true);
  });
});

describe("<SidebarToggle />", () => {
  it("names the action it performs, not the control", () => {
    renderToggle(false);
    expect(screen.getByRole("button", { name: "Ocultar la barra lateral" })).toBeInTheDocument();
  });

  it("flips its label once the sidebar is hidden", () => {
    renderToggle(true);
    expect(screen.getByRole("button", { name: "Mostrar la barra lateral" })).toBeInTheDocument();
  });

  it("writes the cookie the server reads, then asks for a fresh payload", async () => {
    renderToggle(false);

    await userEvent.click(screen.getByRole("button", { name: "Ocultar la barra lateral" }));

    expect(isSidebarHidden(currentCookie())).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("writes the sidebar back when it is already hidden", async () => {
    renderToggle(true);

    await userEvent.click(screen.getByRole("button", { name: "Mostrar la barra lateral" }));

    expect(isSidebarHidden(currentCookie())).toBe(false);
    expect(currentCookie()).toBe("shown");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
