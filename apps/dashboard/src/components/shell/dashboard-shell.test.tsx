import { readFileSync } from "node:fs";
import path from "node:path";

import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useToast } from "@/components/ui/toast";

import esMessages from "../../../messages/es.json";
import type { ShellArea } from "./dashboard-shell";
import { SIDEBAR_HIDDEN, SIDEBAR_SHOWN } from "./sidebar-cookie";

/**
 * The signed-in frame.
 *
 * What is asserted here is the composition, not the parts — every piece the
 * shell mounts has its own file of tests. The properties that only exist once
 * the pieces are put together are:
 *
 *   THE AREA IS ONE DECISION WITH THREE CONSEQUENCES. `area` drives the badge,
 *   the density attribute and which phone navigation renders, and the three can
 *   never disagree because there is nothing else for them to read. The prop it
 *   replaced was `adminArea?: boolean`, which defaulted an unanswered question
 *   to "customer".
 *
 *   THE IDENTITY NEVER DISAPPEARS. It is reachable through the account menu in
 *   every configuration, and the assertion is against the ACCESSIBLE NAME
 *   rather than the markup, because "the email is in the DOM" is exactly the
 *   claim the shell this replaces could also have made while hiding it.
 *
 *   THE TOAST CONTEXT EXISTS. `useToast()` throws outside its provider by
 *   design, so a page that offers an undo has to be able to rely on the shell
 *   having mounted one — once.
 *
 *   THE SIDEBAR PREFERENCE IS SERVER-READ. Both cookie values produce their
 *   layout in the first render, with no client pass in between.
 */

const cookieState = vi.hoisted(() => ({ value: "" }));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      // The cookie name is spelled out here rather than imported: a hoisted
      // factory cannot reach a module-scope import, and matching on the literal
      // means a shell that read some OTHER cookie would fail this file instead
      // of silently rendering the default layout forever.
      get: (name: string) =>
        name === "sidebar" && cookieState.value !== ""
          ? { name, value: cookieState.value }
          : undefined,
    }),
}));

vi.mock("next-intl/server", async () => {
  const catalogue: Readonly<Record<string, Readonly<Record<string, unknown>>>> = (
    await import("../../../messages/es.json")
  ).default;

  return {
    // The REAL Spanish strings, so a re-worded or deleted key fails here rather
    // than passing against a fixture the app can never send.
    getTranslations: (namespace: string) =>
      Promise.resolve(
        (key: string): string => {
          const group = catalogue[namespace];
          const value = group === undefined ? undefined : group[key];
          return typeof value === "string" ? value : `MISSING:${namespace}.${key}`;
        },
      ),
  };
});

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
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  getPathname: ({ href, locale }: { href: string; locale: string }) =>
    locale === "es" ? href : `/${locale}${href}`,
}));

vi.mock("@/lib/bff/client", () => ({
  postJson: () => Promise.resolve({ ok: true }),
}));

const { DashboardShell } = await import("./dashboard-shell");

/**
 * Proves the toast context is reachable from a page. A page component is a
 * client component by the time it calls this, and in the browser it renders
 * INSIDE the provider — which is the path this reproduces.
 */
function ToastProbe() {
  const { dwellMs } = useToast();
  return <p>{`dwell ${String(dwellMs)}`}</p>;
}

interface RenderOptions {
  readonly area?: ShellArea;
  readonly showAdmin?: boolean;
  readonly children?: ReactNode;
}

async function renderShell({
  area = "admin",
  showAdmin = true,
  children = <p>Contenido</p>,
}: RenderOptions = {}) {
  // A server component is a function returning a tree; awaiting it is how the
  // server calls it. The client pieces inside then need the intl provider they
  // would get from the root layout.
  const tree = await DashboardShell({
    area,
    showAdmin,
    email: "ana@example.es",
    children,
  });

  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {tree}
    </NextIntlClientProvider>,
  );
}

/** The sidebar and the tab bar share a name; only one of them is ever on screen. */
function primaryNavCount(): number {
  return screen.queryAllByRole("navigation", { name: "Principal" }).length;
}

describe("<DashboardShell />", () => {
  beforeEach(() => {
    // Braced: an arrow returning the assignment would be read as a teardown
    // callback and run again after every test.
    cookieState.value = "";
  });

  it("gives the administration area both groups and the compact density", async () => {
    const { container } = await renderShell({ area: "admin", showAdmin: true });

    expect(screen.getByRole("heading", { name: "Administración" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mi cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Inventario" })).toBeInTheDocument();

    expect(container.firstElementChild).toHaveAttribute("data-density", "compact");
  });

  it("gives the account area only the customer group and the comfortable density", async () => {
    const { container } = await renderShell({ area: "account", showAdmin: false });

    expect(screen.getByRole("heading", { name: "Mi cuenta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Administración" })).toBeNull();
    // Absent from the HTML, not hidden in it: the admin hrefs are never sent.
    expect(screen.queryByRole("link", { name: "Inventario" })).toBeNull();

    expect(container.firstElementChild).toHaveAttribute("data-density", "comfortable");
  });

  it("paints a different area badge in each half of the product", async () => {
    // Scoped to the bar: "Cuenta" is also the fifth tab's label, and a document
    // -wide query would be asserting the presence of the wrong element.
    const { unmount } = await renderShell({ area: "admin" });
    const adminBadge = within(screen.getByRole("banner")).getByText("Admin");
    expect(adminBadge).toHaveClass("bg-[var(--label)]");
    unmount();

    await renderShell({ area: "account", showAdmin: false });
    const accountBadge = within(screen.getByRole("banner")).getByText("Cuenta");
    expect(accountBadge).toHaveClass("bg-[var(--fill-tertiary)]");
    expect(within(screen.getByRole("banner")).queryByText("Admin")).toBeNull();
  });

  it("keeps the identity reachable in the accessible tree at every width", async () => {
    for (const area of ["admin", "account"] as const) {
      const { unmount } = await renderShell({ area, showAdmin: area === "admin" });

      // The account-menu trigger is the half of the identity that survives the
      // collapse to phone width, so it must carry the address as its NAME —
      // a bare avatar with the email hidden beside it would not.
      const trigger = screen.getByRole("button", {
        name: "Sesión iniciada como ana@example.es",
      });
      expect(trigger.className).not.toContain("hidden");

      unmount();
    }
  });

  it("offers the phone navigation that belongs to the area", async () => {
    const { unmount } = await renderShell({ area: "admin" });
    // The sheet trigger. It always draws BOTH groups, so rendering it at all is
    // the role decision — it may never appear on the customer branch.
    expect(screen.getByRole("button", { name: "Menú" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cuenta" })).toBeNull();
    unmount();

    await renderShell({ area: "account", showAdmin: false });
    expect(screen.queryByRole("button", { name: "Menú" })).toBeNull();
    expect(screen.getByRole("link", { name: "Cuenta" })).toBeInTheDocument();
  });

  it("does not offer a customer the admin search", async () => {
    const { unmount } = await renderShell({ area: "admin" });
    expect(screen.getByRole("search", { name: "Buscar" })).toBeInTheDocument();
    unmount();

    await renderShell({ area: "account", showAdmin: false });
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("puts the skip link first and points it at the content landmark", async () => {
    const { container } = await renderShell();

    const tabbable = container.querySelectorAll<HTMLElement>(
      'a[href], button, input, [tabindex]:not([tabindex="-1"])',
    );
    const first = tabbable[0];
    if (first === undefined) {
      throw new Error("the shell rendered nothing focusable");
    }

    expect(first).toHaveAccessibleName("Saltar al contenido");
    expect(first).toHaveAttribute("href", "#content");
    // The target has to BE the landmark, or the link scrolls somewhere the next
    // Tab does not continue from.
    expect(screen.getByRole("main")).toHaveAttribute("id", "content");
  });

  it("mounts one toast provider around the content", async () => {
    await renderShell({ children: <ToastProbe /> });

    // `useToast` throws outside a provider, so reaching the text at all is the
    // assertion; the dwell proves it is the real controller and not a stub.
    expect(screen.getByText("dwell 8000")).toBeInTheDocument();
  });

  it("renders the sidebar column when the cookie says shown", async () => {
    cookieState.value = SIDEBAR_SHOWN;
    await renderShell({ area: "account", showAdmin: false });

    expect(screen.getByRole("heading", { name: "Mi cuenta" })).toBeInTheDocument();
    // Sidebar plus tab bar. Only one is ever visible, but both are in the tree
    // here because jsdom applies no stylesheet.
    expect(primaryNavCount()).toBe(2);

    const grid = screen.getByRole("main").parentElement;
    expect(grid?.className).toContain("min-[900px]:grid-cols-[220px_minmax(0,1fr)]");
  });

  it("drops the sidebar column when the cookie says hidden", async () => {
    cookieState.value = SIDEBAR_HIDDEN;
    await renderShell({ area: "account", showAdmin: false });

    expect(screen.queryByRole("heading", { name: "Mi cuenta" })).toBeNull();
    expect(primaryNavCount()).toBe(1);

    const grid = screen.getByRole("main").parentElement;
    expect(grid?.className).not.toContain("min-[900px]:grid-cols-[220px_minmax(0,1fr)]");
  });

  it("is a server component", async () => {
    const source = readFileSync(path.resolve(__dirname, "dashboard-shell.tsx"), "utf8");

    // A "use client" here would pull every page's translations, the whole role
    // decision and the identity line into the browser bundle.
    expect(source).not.toMatch(/^\s*["']use client["']/);
  });
});
