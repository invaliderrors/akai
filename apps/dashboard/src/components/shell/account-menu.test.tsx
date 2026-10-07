import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { MouseEventHandler, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import esMessages from "../../../messages/es.json";

/**
 * The account menu.
 *
 * The property worth the whole file: THE ADDRESS IS REACHABLE AT EVERY WIDTH.
 * The toolbar drops the email text on a phone, so if this panel ever stopped
 * restating it, "identity collapses to the avatar, never to nothing" would
 * quietly become false and no layout test would notice.
 */

const replace = vi.fn<(href: string) => void>();
const refresh = vi.fn<() => void>();

interface LinkMockProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly role?: string;
  readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
  readonly "aria-label"?: string;
}

vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...rest }: LinkMockProps) => (
    <a
      href={href}
      {...rest}
      // The real Link routes on the client and never lets the browser follow
      // the href. Without the same suppression here jsdom logs an unhandled
      // "navigation is not implemented" for every row a test presses.
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace, refresh }),
}));

vi.mock("@/lib/bff/client", () => ({
  postJson: () => Promise.resolve({ ok: true }),
}));

const { AccountMenu, accountInitials } = await import("./account-menu");

interface RenderOptions {
  readonly name?: string;
  readonly storeHref?: string;
}

function renderMenu({ name, storeHref }: RenderOptions = {}) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AccountMenu
        email="ana@example.es"
        {...(name === undefined ? {} : { name })}
        {...(storeHref === undefined ? {} : { storeHref })}
      />
    </NextIntlClientProvider>,
  );
}

async function openMenu(options: RenderOptions = {}) {
  const result = renderMenu(options);
  await userEvent.click(screen.getByRole("button", { name: /ana@example\.es/ }));
  return result;
}

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
});

describe("accountInitials()", () => {
  it("takes the first letter of each of the first two words of a name", () => {
    expect(accountInitials("ana@example.es", "Ana Mestra")).toBe("AM");
  });

  it("falls back to the address so an avatar is never blank", () => {
    expect(accountInitials("ops@akai.shop")).toBe("OP");
  });

  it("splits an address that separates its parts with a dot", () => {
    expect(accountInitials("ana.mestra@example.es")).toBe("AM");
  });
});

describe("<AccountMenu />", () => {
  it("names the trigger with the signed-in address", () => {
    renderMenu();

    // The avatar IS the identity below the desktop breakpoint, so the address
    // has to be its accessible name rather than something opened to discover.
    expect(
      screen.getByRole("button", { name: "Sesión iniciada como ana@example.es" }),
    ).toBeInTheDocument();
  });

  it("opens a named menu and keeps the address inside it", async () => {
    await openMenu({ name: "Ana Mestra" });

    expect(screen.getByRole("menu", { name: "Menú de cuenta" })).toBeInTheDocument();
    expect(screen.getByText("Ana Mestra")).toBeInTheDocument();
    expect(screen.getByText("ana@example.es")).toBeInTheDocument();
  });

  it("stays shut until the trigger is pressed", () => {
    renderMenu();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ana@example\.es/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("offers profile and sign-out as menu items — and no language switch", async () => {
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Perfil…" })).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("menuitem", { name: "Cerrar sesión" })).toBeInTheDocument();
    // The shop is Spanish only.
    expect(screen.queryByRole("menuitem", { name: /Idioma/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("omits the shop link when no storefront origin is configured", async () => {
    await openMenu();

    // An href of "" resolves to the current page, so the honest rendering of an
    // unconfigured origin is no row at all.
    expect(screen.queryByRole("menuitem", { name: "Volver a la tienda" })).not.toBeInTheDocument();
  });

  it("links out to the shop when one is", async () => {
    await openMenu({ storeHref: "https://akai.example" });

    expect(screen.getByRole("menuitem", { name: "Volver a la tienda" })).toHaveAttribute(
      "href",
      "https://akai.example",
    );
  });

  it("moves between rows with the arrow keys", async () => {
    await openMenu({ storeHref: "https://akai.example" });

    // `role="menu"` puts assistive technology into application mode, where Tab
    // frequently does not move — declaring the role without the keys is the
    // kind of accessibility that passes an audit and fails a person.
    const profile = screen.getByRole("menuitem", { name: "Perfil…" });
    expect(profile).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Volver a la tienda" })).toHaveFocus();

    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Cerrar sesión" })).toHaveFocus();

    // Wraps: End is the last row, so Down returns to the first.
    await userEvent.keyboard("{ArrowDown}");
    expect(profile).toHaveFocus();

    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Cerrar sesión" })).toHaveFocus();
  });

  it("closes on Escape", async () => {
    await openMenu();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes when a row navigates, so the panel is not left over the new page", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Perfil…" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
