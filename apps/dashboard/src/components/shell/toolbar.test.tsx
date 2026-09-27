import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import esMessages from "../../../messages/es.json";
import type { ToolbarArea } from "./toolbar";

/**
 * The toolbar.
 *
 * Three properties here are decisions rather than styling, and each is asserted
 * on its own:
 *
 *   THE IDENTITY NEVER DISAPPEARS. The address text is dropped below the
 *   desktop breakpoint and the avatar — whose accessible name IS the address —
 *   stays. The shell this replaces hid the identity outright below 700px.
 *
 *   THE AREA BADGE IS INK-FILLED FOR ADMINISTRATION. The one tint in a
 *   monochrome bar, so an operator on a shared screen can tell at a glance that
 *   money can move from this page.
 *
 *   THE SEARCH IS AN ORDER-NUMBER LOOKUP. It targets the one search the API
 *   answers, with the locale prefix baked into the form's `action` — a plain
 *   HTML `action` knows nothing about next-intl, and an unprefixed one would
 *   drop an English operator into Spanish on every submit.
 */

interface LinkMockProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly "aria-label"?: string;
}

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: LinkMockProps) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => "/admin/orders",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  // The real one is `createNavigation(routing)`'s; this is the same shape with
  // the `as-needed` prefixing spelled out, so the assertion below is about what
  // the toolbar DOES with it rather than about next-intl's own behaviour.
  getPathname: ({ href, locale }: { href: string; locale: string }) =>
    locale === "es" ? href : `/${locale}${href}`,
}));

vi.mock("@/lib/bff/client", () => ({
  postJson: () => Promise.resolve({ ok: true }),
}));

const { Toolbar } = await import("./toolbar");

interface RenderOptions {
  readonly area?: ToolbarArea;
  readonly locale?: "es" | "en";
  readonly sidebarHidden?: boolean;
  readonly navControl?: ReactNode;
  readonly title?: string;
}

function renderToolbar({
  area = "admin",
  locale = "es",
  sidebarHidden = false,
  navControl,
  title,
}: RenderOptions = {}) {
  return render(
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      <Toolbar
        area={area}
        email="ops@akai.shop"
        sidebarHidden={sidebarHidden}
        {...(navControl === undefined ? {} : { navControl })}
        {...(title === undefined ? {} : { title })}
      />
    </NextIntlClientProvider>,
  );
}

describe("<Toolbar />", () => {
  it("is a sticky glass bar at the toolbar height", () => {
    renderToolbar();

    const bar = screen.getByRole("banner");
    // `.nx-glass` is the kit's one bespoke class and the single place the
    // Reduce Transparency swap lands — a hand-rolled backdrop-filter here would
    // be the one glass surface that never went opaque.
    expect(bar).toHaveClass("nx-glass");
    expect(bar).toHaveClass("sticky");
    expect(bar.className).toContain("min-[900px]:h-[var(--toolbar-h)]");
  });

  it("keeps the address on screen at desktop width and in the avatar at every width", () => {
    renderToolbar();

    const identity = screen.getByText("ops@akai.shop");
    expect(identity.className).toContain("hidden");
    expect(identity.className).toContain("min-[900px]:inline");

    // The half that survives the collapse.
    expect(
      screen.getByRole("button", { name: "Sesión iniciada como ops@akai.shop" }),
    ).toBeInTheDocument();
  });

  it("fills the administration badge with ink", () => {
    renderToolbar({ area: "admin" });

    expect(screen.getByText("Admin")).toHaveClass("bg-[var(--label)]");
  });

  it("leaves the customer badge quiet", () => {
    renderToolbar({ area: "account" });

    const badge = screen.getByText("Cuenta");
    expect(badge).toHaveClass("bg-[var(--fill-tertiary)]");
    expect(badge.className).not.toContain("bg-[var(--label)]");
  });

  it("points the search at the one lookup the API answers", () => {
    renderToolbar();

    const search = screen.getByRole("search", { name: "Buscar" });
    expect(search).toHaveAttribute("action", "/admin/orders");
    expect(screen.getByRole("searchbox", { name: "Buscar" })).toHaveAttribute(
      "name",
      "orderNumber",
    );
  });

  it("carries the locale prefix into the form action", () => {
    renderToolbar({ locale: "en" });

    expect(screen.getByRole("search", { name: "Buscar" })).toHaveAttribute(
      "action",
      "/en/admin/orders",
    );
  });

  it("gives a customer no search at all", () => {
    renderToolbar({ area: "account" });

    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("sends the phone-width search to the list that carries the same filter", () => {
    renderToolbar();

    const link = screen.getByRole("link", { name: "Buscar" });
    expect(link).toHaveAttribute("href", "/admin/orders");
    expect(link.className).toContain("min-[900px]:hidden");
  });

  it("names the sidebar toggle after what pressing it does", () => {
    renderToolbar({ sidebarHidden: false });
    expect(screen.getByRole("button", { name: "Ocultar la barra lateral" })).toBeInTheDocument();
  });

  it("flips that name when the shell rendered without its sidebar", () => {
    renderToolbar({ sidebarHidden: true });
    expect(screen.getByRole("button", { name: "Mostrar la barra lateral" })).toBeInTheDocument();
  });

  it("renders the shell's nav control below the desktop breakpoint only", () => {
    renderToolbar({ navControl: <button type="button">Menú</button> });

    const slot = screen.getByRole("button", { name: "Menú" }).parentElement;
    expect(slot?.className).toContain("min-[900px]:hidden");
  });

  it("has no leading slot for a customer, who gets the tab bar instead", () => {
    renderToolbar({ area: "account" });

    expect(screen.queryByRole("button", { name: "Menú" })).not.toBeInTheDocument();
  });

  it("draws the wordmark twice, once for each width, and never both at once", () => {
    renderToolbar();

    const wordmarks = screen.getAllByText("AKAI");
    expect(wordmarks).toHaveLength(2);

    const [centred, inline] = wordmarks;
    // The phone nav bar centres its title in the BAR rather than in the space
    // the controls leave, so it is positioned rather than laid out — and it
    // takes no pointer events, or it would swallow taps meant for the avatar.
    expect(centred?.className).toContain("pointer-events-none");
    expect(centred?.className).toContain("min-[900px]:hidden");
    expect(inline?.className).toContain("min-[900px]:inline");
  });

  it("lets an operator screen title its own phone nav bar", () => {
    renderToolbar({ title: "Pedidos" });

    expect(screen.getByText("Pedidos")).toBeInTheDocument();
    // The desktop wordmark is not a page title and does not follow it.
    expect(screen.getByText("AKAI")).toBeInTheDocument();
  });
});
