import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { ToastProvider } from "@/components/ui/toast";

import { CustomerTabBar } from "./customer-tab-bar";
import type { NavCounts } from "./nav-items";
import { OperatorNavSheet } from "./operator-nav-sheet";
import { SideNav } from "./side-nav";
import { SIDEBAR_COOKIE_NAME, isSidebarHidden } from "./sidebar-cookie";
import { Toolbar, type ToolbarArea } from "./toolbar";

/**
 * The signed-in frame: toolbar, source-list sidebar, phone navigation, content.
 *
 * STILL A SERVER COMPONENT, and that is the whole reason the composition is
 * shaped this way. The only client modules it pulls in are the ones that
 * genuinely need the browser — `SideNav` and `CustomerTabBar` (`usePathname`),
 * `OperatorNavSheet` (open/closed), the account menu and sidebar toggle inside
 * `Toolbar`, and `ToastProvider` (a context and a timer). Page content, the
 * translations, the identity line and the whole role decision therefore cost
 * the browser nothing.
 *
 * `showAdmin` is decided by the CALLER from a server-side role check, never
 * from a client-readable value. That is what keeps admin hrefs out of a
 * customer's HTML instead of shipping them and hiding them with CSS.
 *
 * WHY WRAPPING `children` IN A CLIENT PROVIDER IS SAFE. `ToastProvider` is a
 * client component, but `children` reach it as an ALREADY-RENDERED server
 * subtree through props — React renders them here, on the server, and the
 * provider receives the finished tree rather than a reference it would have to
 * bundle. So mounting the toast context around `<main>` does not drag a single
 * page into the client graph, and every `useToast()` call site below it works
 * at runtime instead of throwing "must be called inside a <ToastProvider>".
 * Mounted ONCE, here, because a second provider would silently give half the
 * app a second, empty toast stack.
 *
 * THE 900px BREAKPOINT IS THE ONE STRUCTURAL NUMBER. Above it there is a
 * sidebar; below it there is not, and the phone navigation takes over. It is
 * written as a Tailwind arbitrary variant, which cannot interpolate a
 * constant — so the literal appears once per class string here and nowhere
 * else in this file. The chrome components (`Toolbar`, `SideNav`'s consumers,
 * `CustomerTabBar`) each carry the same literal for the same reason and must
 * move together; 860, the old value, is gone.
 */

/** Structurally identical to the toolbar's by construction, so they cannot drift. */
export type ShellArea = ToolbarArea;

/**
 * The area picks the density, and the density is an ATTRIBUTE on the shell root
 * rather than a class: the token layer switches `--control-h`, `--font-body`,
 * `--row-h`, `--cell-py` and the rest on `[data-density]`, so one component set
 * serves both areas. It is also exactly why every density variable has a bare
 * `:root` default — the auth screens render outside this component and would
 * otherwise resolve every `h-[var(--control-h)]` to nothing.
 *
 * Administration is compact (the macOS text table: dense lists an operator
 * scans all day); an account is comfortable (the iOS one: touch targets for
 * someone who visits four times a year).
 */
const DENSITY: Readonly<Record<ShellArea, "compact" | "comfortable">> = {
  account: "comfortable",
  admin: "compact",
};

/**
 * Off-screen until focused, never `display:none`.
 *
 * `sr-only` would work too, but `sr-only` + `focus:not-sr-only` + `focus:fixed`
 * puts two competing `position` utilities in one class list and the winner is
 * decided by Tailwind's emission order rather than by the order they are
 * written. A permanently `fixed` element that simply sits above the viewport
 * has one position and cannot lose that race.
 */
const SKIP_LINK_CLASS =
  "fixed start-3 top-[-100px] z-50 inline-flex h-[var(--control-h)] items-center rounded-[var(--r-control)] bg-[var(--bg-grouped-secondary)] px-4 text-[15px] font-medium text-[var(--label)] no-underline shadow-[var(--e-1)] focus:top-3 focus:outline-none focus:shadow-[var(--e-1),0_0_0_4px_var(--focus-ring)]";

export interface DashboardShellProps {
  readonly children: ReactNode;
  readonly email: string;
  /** Whether the caller's server-side role check said this person may see the admin group. */
  readonly showAdmin: boolean;
  /**
   * Which half of the product this is.
   *
   * A REQUIRED DISCRIMINANT, not the optional `adminArea?: boolean` it replaces.
   * It now drives three things that must always agree — the toolbar badge, the
   * density and which phone navigation renders — and a boolean that defaults to
   * `false` lets a new admin layout ship looking and behaving like a customer's
   * account. Required means the compiler asks the question at every call site.
   */
  readonly area: ShellArea;
  /** The signed-in person's display name, when the caller has one. */
  readonly name?: string;
  /**
   * Problem and open-item counts, already translated. Forwarded UNCHANGED to
   * the sidebar and to whichever phone navigation is on screen, so one fetch
   * feeds all of them and a phone can never report a different number of open
   * orders than the desktop does.
   */
  readonly counts?: NavCounts;
}

export async function DashboardShell({
  children,
  email,
  showAdmin,
  area,
  name,
  counts,
}: DashboardShellProps) {
  const t = await getTranslations("common");
  const tui = await getTranslations("ui");

  // Read on the SERVER so a collapsed sidebar is collapsed in the first byte.
  // Resolving this in the browser would render the 220px column and then remove
  // it, which is a visible jump on every navigation for anyone who hid it.
  const cookieStore = await cookies();
  const sidebarHidden = isSidebarHidden(cookieStore.get(SIDEBAR_COOKIE_NAME)?.value);

  /**
   * The phone navigation is chosen by AREA, not by role: each route group
   * carries its own. A customer (and an operator inside their own account) gets
   * the five-tab bar; the administration area gets the sidebar as a sheet, with
   * its group headings intact — the one string that tells the two rows labelled
   * "Pedidos" apart.
   *
   * `OperatorNavSheet` takes no `showAdmin` of its own and always draws both
   * groups. Rendering it AT ALL is the decision, which is why it may only ever
   * appear here, on the admin branch.
   */
  const isAdminArea = area === "admin";

  return (
    <div data-density={DENSITY[area]} className="min-h-dvh bg-[var(--bg-grouped)]">
      {/* FIRST focusable element on the page, and the first thing that has ever
          used `common.skipToContent` — the string has sat in both catalogues
          with no link behind it. */}
      <a href="#content" className={SKIP_LINK_CLASS}>
        {t("skipToContent")}
      </a>

      <Toolbar
        area={area}
        email={email}
        sidebarHidden={sidebarHidden}
        {...(name === undefined ? {} : { name })}
        {...(isAdminArea
          ? {
              navControl: (
                <OperatorNavSheet
                  email={email}
                  {...(name === undefined ? {} : { name })}
                  {...(counts === undefined ? {} : { counts })}
                />
              ),
            }
          : {})}
      />

      <div
        className={`grid min-h-[calc(100dvh-var(--toolbar-h))] ${
          sidebarHidden ? "" : "min-[900px]:grid-cols-[220px_minmax(0,1fr)]"
        }`}
      >
        {sidebarHidden ? null : (
          /* A grid item, so it stretches to the row height and the sticky nav
             inside it has something taller than itself to stick within. It
             paints NOTHING: the surface, the right hairline and the sticky
             offset belong to `SideNav`, and a second background or border here
             would draw the separator twice.

             `display:none` below 900 rather than "not rendered": it takes the
             sidebar out of the accessibility tree entirely, which is what stops
             it and the tab bar from being two navigations with the same name. */
          <div className="hidden min-[900px]:block">
            <SideNav showAdmin={showAdmin} {...(counts === undefined ? {} : { counts })} />
          </div>
        )}

        <ToastProvider closeLabel={tui("close")}>
          {/* NO horizontal padding. `PageTemplate` owns the gutter, because the
              max-width variant has to be applied by the element that pays for
              it — a gutter here would double.

              `min-w-0` so a wide table shrinks its column instead of resolving
              the grid to the table's min-content width. `tabIndex={-1}` so the
              skip link actually MOVES focus: several browsers scroll to a
              fragment without focusing it, and the next Tab then starts from
              the top of the document again. */}
          <main
            id="content"
            tabIndex={-1}
            className={`min-w-0 focus:outline-none ${
              isAdminArea ? "" : "pb-[83px] min-[900px]:pb-0"
            }`}
          >
            {children}
          </main>
        </ToastProvider>
      </div>

      {/* Owns its own `fixed` placement and its own `min-[900px]:hidden`, so it
          is rendered bare — a wrapper here would be a second opinion about the
          width at which a sidebar exists. The 83px inset above is its height. */}
      {isAdminArea ? null : <CustomerTabBar {...(counts === undefined ? {} : { counts })} />}
    </div>
  );
}
