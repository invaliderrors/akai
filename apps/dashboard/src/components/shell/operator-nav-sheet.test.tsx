import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { MouseEventHandler, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import esMessages from "../../../messages/es.json";
import type { NavCounts } from "./nav-items";

/**
 * The operator's phone navigation.
 *
 * WHAT THIS FILE IS DEFENDING. The sheet exists because fourteen destinations
 * do not reduce to five tabs, and the reason they do not is that two rows are
 * both labelled "Pedidos" and only the heading above them says which is which.
 * The shell this replaces hid those headings below 860px and shipped exactly
 * that ambiguity, so "both headings are present, and each Pedidos sits under
 * its own" is the assertion the whole component is for.
 *
 * The other silent failure is a modal that outlives the navigation it
 * performed: the operator taps a row, the page changes underneath, and the menu
 * is still covering it.
 *
 * Strings come from the REAL `es.json`, per `status-badge.test.tsx`: a fixture
 * is the thing that keeps passing after a translator renames the one heading
 * that distinguishes the two identical rows.
 */

const nav = vi.hoisted(() => ({ pathname: "/admin/orders" }));

interface LinkMockProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
  readonly "aria-current"?: "page";
}

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, onClick, ...rest }: LinkMockProps) => (
    <a
      href={href}
      {...rest}
      // The real Link routes on the client and never lets the browser follow
      // the href; without the same suppression jsdom logs an unhandled
      // "navigation is not implemented" for every row a test presses.
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
  usePathname: () => nav.pathname,
  // Never called here — `accountInitials` is imported from `account-menu`,
  // which pulls the sign-out button in with it. Present so the mocked module
  // has every export its importers name.
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/bff/client", () => ({
  postJson: () => Promise.resolve({ ok: true }),
}));

const { OperatorNavSheet } = await import("./operator-nav-sheet");

/** Sentences, never bare digits — the whole point of `NavCount.label`. */
const COUNTS: NavCounts = {
  adminOrders: { value: 2, tone: "critical", label: "2 pedidos necesitan una decisión" },
  adminInventory: { value: 2, tone: "warning", label: "2 referencias con stock bajo" },
};

interface RenderOptions {
  readonly pathname?: string;
  readonly name?: string;
  readonly counts?: NavCounts;
}

function renderSheet({ pathname = "/admin/orders", name, counts }: RenderOptions = {}) {
  nav.pathname = pathname;

  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <OperatorNavSheet
        email="ops@akai.shop"
        {...(name === undefined ? {} : { name })}
        {...(counts === undefined ? {} : { counts })}
      />
    </NextIntlClientProvider>,
  );
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: esMessages.common.menu });
}

async function openSheet(options: RenderOptions = {}) {
  const result = renderSheet(options);
  await userEvent.click(trigger());
  return result;
}

/** The heading standing above a row — the only thing telling two "Pedidos" apart. */
function groupHeadingOf(link: HTMLElement): string {
  const group = link.closest<HTMLDivElement>("div");

  if (group === null) {
    throw new Error("a nav row rendered outside a group");
  }

  return within(group).getByRole("heading", { level: 2 }).textContent ?? "";
}

describe("<OperatorNavSheet />", () => {
  it("renders a named trigger and nothing else until it is pressed", () => {
    renderSheet();

    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    // Not merely hidden: a modal that is in the document from the first paint
    // is a modal whose focus trap and scroll lock are already running.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("opens a modal sheet named for the menu it is", async () => {
    await openSheet();

    const sheet = screen.getByRole("dialog", { name: esMessages.common.menu });

    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    // Focus moves into the sheet, which is what `ui/overlay` is here to own —
    // asserted at the seam only, because the trap itself is pinned in
    // `overlay.test.tsx` and a second copy of those cases would rot.
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it("keeps both group headings, at phone width", async () => {
    await openSheet();

    expect(
      screen.getByRole("heading", { level: 2, name: esMessages.nav.customerGroup }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: esMessages.nav.adminGroup }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(19);
  });

  it("distinguishes the two rows labelled the same by the heading above them", async () => {
    await openSheet();

    // The defect the dropped chip row shipped: at narrow widths the headings
    // disappeared and an operator was offered "Pedidos" twice with nothing to
    // choose between them.
    const orders = screen.getAllByRole("link", { name: esMessages.nav.orders });

    expect(orders.map((link) => link.getAttribute("href"))).toEqual(["/orders", "/admin/orders"]);
    expect(orders.map(groupHeadingOf)).toEqual([
      esMessages.nav.customerGroup,
      esMessages.nav.adminGroup,
    ]);
  });

  it("restates the identity so the sheet answers whose account this is", async () => {
    await openSheet({ name: "Operations" });

    const sheet = screen.getByRole("dialog", { name: esMessages.common.menu });

    expect(within(sheet).getByText("Operations")).toBeInTheDocument();
    expect(within(sheet).getByText("ops@akai.shop")).toBeInTheDocument();
    // Read aloud, a bare address is just a string.
    expect(within(sheet).getByText(esMessages.common.signedInAs)).toBeInTheDocument();
    // The avatar repeats the derivation the toolbar uses; a second one here
    // would let the two discs disagree about the same person.
    expect(within(sheet).getByText("OP")).toBeInTheDocument();
  });

  it("leads with the address when the session carries no name", async () => {
    await openSheet();

    const sheet = screen.getByRole("dialog", { name: esMessages.common.menu });

    expect(within(sheet).getByText("ops@akai.shop")).toBeInTheDocument();
  });

  it("marks the current page, and only the current page", async () => {
    await openSheet({ pathname: "/admin/orders/AK-2026-000412" });

    const current = screen.getAllByRole("link", { current: "page" });

    // Exactly one: two rows claiming to be current is a lie in the
    // accessibility tree before it is a bug in the styling, and a detail page
    // still belongs to its list's row.
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "/admin/orders");
  });

  it("announces a count as a sentence rather than a bare number", async () => {
    await openSheet({ counts: COUNTS });

    // The whole accessible name, so a count that leaked "2" into it instead of
    // the sentence fails here.
    expect(
      screen.getByRole("link", {
        name: `${esMessages.nav.adminOrders} 2 pedidos necesitan una decisión`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: `${esMessages.nav.adminInventory} 2 referencias con stock bajo`,
      }),
    ).toBeInTheDocument();
    // Eight of the fourteen rows can never carry one, and the other six only
    // while there is something to report.
    expect(screen.getByRole("link", { name: esMessages.nav.adminJobs })).toBeInTheDocument();
  });

  it("closes when a destination is chosen", async () => {
    await openSheet();

    await userEvent.click(screen.getByRole("link", { name: esMessages.nav.adminProducts }));

    // A modal that survives the navigation it just performed leaves the
    // operator looking at a menu over the page they asked for.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes from the close button", async () => {
    await openSheet();

    await userEvent.click(screen.getByRole("button", { name: esMessages.ui.close }));

    // On a phone there is no keyboard and the scrim is a narrow strip beside a
    // 300px sheet, so the explicit button is the primary way out.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    await openSheet();

    await userEvent.keyboard("{Escape}");

    // `ui/overlay` implements it; this pins that `onClose` is actually wired to
    // the state this component holds.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
