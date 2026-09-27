import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import esMessages from "../../../messages/es.json";

/**
 * Sign-out.
 *
 * WHAT THESE TESTS ARE ACTUALLY GUARDING. None of them is about how the row
 * looks — the presentation moved into the account menu and could move again.
 * They pin the four properties that would still be invisible if they broke:
 * the control is a BUTTON that posts (a link would be a GET, and a GET logout
 * is fired by any prefetch or link scanner), the CSRF-bearing client is the one
 * doing the posting, navigation happens even when the request fails, and
 * `refresh()` runs after it so the signed-in RSC payload cannot be repainted by
 * a back-navigation on a shared machine.
 */

interface PostResult {
  readonly ok: boolean;
}

const postJson = vi.fn<(path: string, body: unknown) => Promise<PostResult>>();
const replace = vi.fn<(href: string) => void>();
const refresh = vi.fn<() => void>();

vi.mock("@/lib/bff/client", () => ({
  postJson: (path: string, body: unknown) => postJson(path, body),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const { SignOutButton } = await import("./sign-out-button");

function renderIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

// Braced. An arrow body would RETURN the mock, and Vitest treats a value
// returned from a hook as a teardown callback — see the testing conventions.
beforeEach(() => {
  postJson.mockReset();
  replace.mockReset();
  refresh.mockReset();
  postJson.mockResolvedValue({ ok: true });
});

describe("<SignOutButton />", () => {
  it("is a button, never a link", () => {
    renderIntl(<SignOutButton />);

    const item = screen.getByRole("menuitem", { name: "Cerrar sesión" });
    // The whole security argument in one assertion: an <a href> here would be
    // reachable by GET, and an <img> or a prefetch could then sign a user out.
    expect(item.tagName).toBe("BUTTON");
    expect(item).not.toHaveAttribute("href");
  });

  it("posts JSON through the CSRF-bearing client", async () => {
    renderIntl(<SignOutButton />);

    await userEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));

    expect(postJson).toHaveBeenCalledWith("/api/auth/logout", { allDevices: false });
  });

  it("navigates and discards the cached payload, in that order", async () => {
    renderIntl(<SignOutButton />);

    await userEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));

    expect(replace).toHaveBeenCalledWith("/sign-in");
    expect(refresh).toHaveBeenCalledTimes(1);
    // refresh AFTER replace: it is what drops the RSC payload rendered for the
    // signed-out user, so a back-navigation cannot repaint their data.
    const [replaceOrder] = replace.mock.invocationCallOrder;
    const [refreshOrder] = refresh.mock.invocationCallOrder;
    expect(replaceOrder).toBeDefined();
    expect(refreshOrder).toBeDefined();
    expect(Number(replaceOrder)).toBeLessThan(Number(refreshOrder));
  });

  it("still leaves when the revocation request fails", async () => {
    // The BFF clears the cookie unconditionally, so the local session is gone
    // either way. Stranding the user on a dead page would be worse.
    postJson.mockResolvedValue({ ok: false });
    renderIntl(<SignOutButton />);

    await userEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));

    expect(replace).toHaveBeenCalledWith("/sign-in");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("disables itself and says so while the request is in flight", async () => {
    postJson.mockReturnValue(new Promise<PostResult>(() => undefined));
    renderIntl(<SignOutButton />);

    await userEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));

    const pendingItem = screen.getByRole("menuitem", { name: "Cerrando sesión…" });
    expect(pendingItem).toBeDisabled();
  });

  it("wears the paint the menu hands it, and owns none of its own", () => {
    renderIntl(<SignOutButton className="menu-row" />);

    expect(screen.getByRole("menuitem", { name: "Cerrar sesión" })).toHaveClass("menu-row");
  });
});
