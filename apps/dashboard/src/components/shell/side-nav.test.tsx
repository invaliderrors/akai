import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { SideNav } from "./side-nav";
import type { NavCounts } from "./nav-items";
import esMessages from "../../../messages/es.json";

/**
 * What this file is defending.
 *
 * The sidebar has one job with three failure modes, and all three are silent:
 * highlighting the wrong row, highlighting two rows, and offering a customer a
 * door they cannot open. The third is caught by a route guard eventually; the
 * first two are never caught by anything, because a wrong highlight still
 * renders, still navigates and still looks deliberate.
 *
 * Strings come from the REAL `es.json` rather than a fixture, for the reason
 * `status-badge.test.tsx` gives: a fixture is exactly the thing that keeps
 * passing after a translator renames a group heading, which is the one string
 * separating the two rows labelled "Pedidos".
 */

/**
 * `usePathname` is the ONLY reason this component is a client component, so it
 * is the one thing the mock has to make controllable. `Link` is mocked down to
 * the anchor it renders — the href it is GIVEN is what is under test here, and
 * the locale prefix next-intl adds is covered by the e2e locale smoke.
 */
const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
    "aria-current"?: "page";
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
  usePathname: () => nav.pathname,
}));

interface RenderOptions {
  readonly pathname: string;
  readonly showAdmin: boolean;
  readonly counts?: NavCounts;
}

function renderNav({ pathname, showAdmin, counts }: RenderOptions) {
  nav.pathname = pathname;

  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <SideNav showAdmin={showAdmin} {...(counts === undefined ? {} : { counts })} />
    </NextIntlClientProvider>,
  );
}

/** Every href rendered, in document order. */
function hrefs(): readonly string[] {
  return screen.getAllByRole("link").map((link) => link.getAttribute("href") ?? "");
}

/** The href of the one row claiming to be the current page. */
function currentHref(): string {
  const current = screen.getAllByRole("link", { current: "page" });

  // Asserted here rather than at each call site: "exactly one" is the invariant
  // every one of these cases is really about, and a helper that quietly took
  // the first of two would hide the defect it exists to catch.
  expect(current).toHaveLength(1);

  return current.map((link) => link.getAttribute("href") ?? "").join("");
}

/**
 * The heading standing above a row — the only thing distinguishing the two rows
 * labelled "Pedidos" from one another.
 */
function groupHeadingOf(link: HTMLElement): string {
  const group = link.closest<HTMLDivElement>("div");

  if (group === null) {
    throw new Error("a nav row rendered outside a group");
  }

  return within(group).getByRole("heading", { level: 2 }).textContent ?? "";
}

/** Sentences, never bare digits — the whole point of `NavCount.label`. */
const COUNTS: NavCounts = {
  orders: { value: 1, tone: "neutral", label: "1 pedido en curso" },
  returns: { value: 1, tone: "neutral", label: "1 devolución abierta" },
  adminOrders: { value: 2, tone: "critical", label: "2 pedidos necesitan una decisión" },
  adminInventory: { value: 2, tone: "warning", label: "2 referencias con stock bajo" },
  adminEmails: { value: 1, tone: "critical", label: "1 correo fallido" },
  adminJobs: { value: 3, tone: "neutral", label: "3 trabajos en cola" },
};

describe("<SideNav />", () => {
  it("names itself so a screen reader can skip past it", () => {
    renderNav({ pathname: "/", showAdmin: true });

    expect(
      screen.getByRole("navigation", { name: esMessages.common.primaryNav }),
    ).toBeInTheDocument();
  });

  it("renders both groups as real headings for an operator", () => {
    renderNav({ pathname: "/", showAdmin: true });

    expect(
      screen.getByRole("heading", { level: 2, name: esMessages.nav.customerGroup }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: esMessages.nav.adminGroup }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(19);
    expect(screen.getByRole("link", { name: esMessages.nav.adminBlog })).toHaveAttribute(
      "href",
      "/admin/blog",
    );
  });

  it("distinguishes the two rows labelled the same by the heading above them", () => {
    renderNav({ pathname: "/", showAdmin: true });

    // Two rows, one word. This is the defect the dropped chip row shipped: at
    // narrow widths the headings disappeared and an operator was offered
    // "Pedidos" twice with nothing to choose between them.
    const orders = screen.getAllByRole("link", { name: esMessages.nav.orders });

    expect(orders.map((link) => link.getAttribute("href"))).toEqual([
      "/orders",
      "/admin/orders",
    ]);
    expect(orders.map(groupHeadingOf)).toEqual([
      esMessages.nav.customerGroup,
      esMessages.nav.adminGroup,
    ]);
  });

  it("renders only the customer group for a customer", () => {
    renderNav({ pathname: "/", showAdmin: false });

    expect(
      screen.queryByRole("heading", { name: esMessages.nav.adminGroup }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(6);
    // Not "no admin GROUP" — no admin HREF. The links must be absent from the
    // markup, not merely unlabelled: hiding them with CSS would ship every
    // admin route to every customer's browser.
    expect(hrefs().filter((href) => href.startsWith("/admin"))).toEqual([]);
  });

  it("marks the current page, and only the current page", () => {
    renderNav({ pathname: "/orders", showAdmin: true });

    expect(currentHref()).toBe("/orders");
  });

  it("keeps a detail page on its list's row", () => {
    renderNav({ pathname: "/admin/orders/AK-2026-000412", showAdmin: true });

    // The subtree rule: an order's own page is still "Pedidos".
    expect(currentHref()).toBe("/admin/orders");
  });

  it("does not treat the account root as an ancestor of every page", () => {
    renderNav({ pathname: "/security", showAdmin: true });

    expect(currentHref()).toBe("/security");
  });

  it("does not treat the admin root as an ancestor of every admin page", () => {
    // `/admin` was added to the list in this rewrite. Under the plain subtree
    // rule it would match `/admin/products` as well, putting TWO rows in the
    // accessibility tree claiming to be the current page.
    renderNav({ pathname: "/admin/products/new", showAdmin: true });

    expect(currentHref()).toBe("/admin/products");
  });

  it("marks each root when it is the page", () => {
    const { unmount } = renderNav({ pathname: "/", showAdmin: true });

    expect(currentHref()).toBe("/");
    unmount();

    renderNav({ pathname: "/admin", showAdmin: true });

    expect(currentHref()).toBe("/admin");
  });

  it("announces every count as a sentence rather than a bare number", () => {
    renderNav({ pathname: "/", showAdmin: true, counts: COUNTS });

    // The accessible name is asserted WHOLE: the digit is aria-hidden, so a
    // count that leaked "2" into the name instead of "2 pedidos necesitan una
    // decisión" fails here. Read aloud, a bare number answers nothing — two
    // what, and is that good news?
    const expected: readonly (readonly [string, string])[] = [
      [esMessages.nav.orders, "1 pedido en curso"],
      [esMessages.nav.returns, "1 devolución abierta"],
      [esMessages.nav.adminOrders, "2 pedidos necesitan una decisión"],
      [esMessages.nav.adminInventory, "2 referencias con stock bajo"],
      [esMessages.nav.adminEmails, "1 correo fallido"],
      [esMessages.nav.adminJobs, "3 trabajos en cola"],
    ];

    for (const [label, sentence] of expected) {
      expect(screen.getByRole("link", { name: `${label} ${sentence}` })).toBeInTheDocument();
    }
  });

  it("draws no counts at all when none are supplied", () => {
    renderNav({ pathname: "/", showAdmin: true });

    // Exact names, so a stray badge — or a placeholder zero — breaks this. Eight
    // of the fourteen rows can never carry a count; the other six carry one only
    // while there is something to report.
    expect(screen.getByRole("link", { name: esMessages.nav.adminJobs })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: esMessages.nav.returns })).toBeInTheDocument();
  });
});
