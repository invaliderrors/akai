import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CustomerTabBar } from "./customer-tab-bar";
import type { NavCounts } from "./nav-items";
import esMessages from "../../../messages/es.json";

/**
 * What this file is defending.
 *
 * The tab bar's failure modes are all silent. Five columns still render when a
 * destination has quietly dropped out of them; a tab still navigates when it is
 * highlighting the wrong page; and the merged "Account" tab still looks correct
 * on `/profile` while going dark on `/security` — which is the moment a
 * customer decides they have fallen out of the app, because the bar that got
 * them there no longer says where they are.
 *
 * Strings come from the REAL `es.json`, per `status-badge.test.tsx`: a fixture
 * is exactly the thing that keeps passing after a translator renames a label.
 */

/**
 * `usePathname` is the ONLY reason this is a client component, so it is the one
 * thing the mock makes controllable. `Link` is flattened to the anchor it
 * renders — the href it is GIVEN is what is under test.
 */
const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/link", () => ({
  default: ({
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
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => nav.pathname,
}));

interface RenderOptions {
  readonly pathname: string;
  readonly counts?: NavCounts;
}

function renderBar({ pathname, counts }: RenderOptions) {
  nav.pathname = pathname;

  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <CustomerTabBar {...(counts === undefined ? {} : { counts })} />
    </NextIntlClientProvider>,
  );
}

/** Every href rendered, in document order. */
function hrefs(): readonly string[] {
  return screen.getAllByRole("link").map((link) => link.getAttribute("href") ?? "");
}

/** The href of the one tab claiming to be the current page. */
function currentHref(): string {
  const current = screen.getAllByRole("link", { current: "page" });

  // Asserted here rather than at each call site: "exactly one" is the invariant
  // every one of these cases is really about, and a helper that quietly took
  // the first of two would hide the defect it exists to catch.
  expect(current).toHaveLength(1);

  return current.map((link) => link.getAttribute("href") ?? "").join("");
}

describe("<CustomerTabBar />", () => {
  it("names itself so a screen reader can skip past it", () => {
    renderBar({ pathname: "/" });

    expect(
      screen.getByRole("navigation", { name: esMessages.common.primaryNav }),
    ).toBeInTheDocument();
  });

  it("offers five tabs, in the phone's order of use", () => {
    renderBar({ pathname: "/" });

    expect(
      screen.getAllByRole("link").map((link) => link.textContent),
    ).toEqual([
      esMessages.nav.overview,
      esMessages.nav.orders,
      esMessages.nav.returns,
      esMessages.nav.addresses,
      // Not "Perfil". The merged label is the whole point of the fifth column.
      esMessages.nav.account,
    ]);
    expect(hrefs()).toEqual(["/", "/orders", "/returns", "/addresses", "/profile"]);
  });

  it("offers a customer no door they cannot open", () => {
    renderBar({ pathname: "/" });

    // The admin group is never read here at all — an operator on a phone gets
    // the sheet. Asserted on the HREFS, not on labels: a hidden-by-CSS admin
    // link would still be an admin route shipped to a customer's browser.
    expect(hrefs().filter((href) => href.startsWith("/admin"))).toEqual([]);
  });

  it("navigates and never acts", () => {
    renderBar({ pathname: "/" });

    // HIG › Tab bars. Sign-out, the language switch and every other command
    // belong to the toolbar's account menu; a button in here would break the
    // promise that tapping a tab commits you to nothing.
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("marks the current page, and only the current page", () => {
    renderBar({ pathname: "/orders" });

    expect(currentHref()).toBe("/orders");
  });

  it("keeps an order's own page on the Orders tab", () => {
    renderBar({ pathname: "/orders/AK-2026-000412" });

    expect(currentHref()).toBe("/orders");
  });

  it("does not treat the account root as an ancestor of every page", () => {
    renderBar({ pathname: "/addresses" });

    // `/` is an index route: without the exact rule two tabs would claim to be
    // the current page, which is a lie in the accessibility tree before it is a
    // bug in the styling.
    expect(currentHref()).toBe("/addresses");
  });

  it("lights the Account tab from EITHER of the two screens it merges", () => {
    const { unmount } = renderBar({ pathname: "/profile" });

    expect(currentHref()).toBe("/profile");
    expect(screen.getByRole("link", { current: "page" })).toHaveAccessibleName(
      esMessages.nav.account,
    );
    unmount();

    // The half of the merge that is easy to get wrong. Security has no tab of
    // its own, so if Account does not light here the bar goes blank on a screen
    // the customer reached from it.
    renderBar({ pathname: "/security" });

    expect(currentHref()).toBe("/profile");
    expect(screen.getByRole("link", { current: "page" })).toHaveAccessibleName(
      esMessages.nav.account,
    );
  });

  it("announces a count as a sentence rather than a bare number", () => {
    const counts: NavCounts = {
      returns: { value: 1, tone: "critical", label: "1 devolución necesita tu respuesta" },
    };

    renderBar({ pathname: "/", counts });

    // The accessible name is asserted WHOLE: the digit is aria-hidden, so a
    // badge that leaked "1" into the name instead of the sentence fails here.
    expect(
      screen.getByRole("link", {
        name: `${esMessages.nav.returns} 1 devolución necesita tu respuesta`,
      }),
    ).toBeInTheDocument();
  });

  it("badges only the destination the count belongs to", () => {
    const counts: NavCounts = {
      orders: { value: 2, tone: "neutral", label: "2 pedidos en curso" },
      // Read by the sidebar, never by this bar: an operator on a phone gets the
      // sheet, so an admin count arriving here must draw nothing at all.
      adminOrders: { value: 9, tone: "critical", label: "9 pedidos necesitan una decisión" },
    };

    renderBar({ pathname: "/", counts });

    expect(
      screen.getByRole("link", { name: `${esMessages.nav.orders} 2 pedidos en curso` }),
    ).toBeInTheDocument();
    // Exact names, so a stray badge — or a placeholder zero — breaks this.
    expect(screen.getByRole("link", { name: esMessages.nav.returns })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: esMessages.nav.account })).toBeInTheDocument();
  });

  it("draws no badges at all when no counts are supplied", () => {
    renderBar({ pathname: "/" });

    for (const label of [esMessages.nav.orders, esMessages.nav.returns]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });
});
