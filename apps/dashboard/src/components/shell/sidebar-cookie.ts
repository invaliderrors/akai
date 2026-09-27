/**
 * The one spelling of the sidebar-collapse cookie.
 *
 * WHY IT IS A MODULE OF ITS OWN. The value is READ on the server — the shell
 * decides whether to render the 220px column before the first byte, so a
 * collapsed sidebar never flashes open — and WRITTEN in the browser, by
 * `SidebarToggle`. Those two sit on opposite sides of the client boundary, and
 * a `"use client"` module's exports reach a Server Component as client
 * REFERENCES rather than as values: `SIDEBAR_COOKIE_NAME` imported from the
 * toggle would arrive at the shell as an opaque proxy, and the cookie read
 * would silently look for a key named nothing at all. A module with no
 * directive belongs to both graphs and is the only place a shared literal can
 * live.
 *
 * It is a plain, non-httpOnly cookie on purpose: it holds a layout preference,
 * nothing that identifies anyone, and the browser is the only thing that can
 * decide to change it.
 */

export const SIDEBAR_COOKIE_NAME = "sidebar";

/** The two values the cookie ever holds. Anything else reads as "shown". */
export const SIDEBAR_HIDDEN = "hidden";
export const SIDEBAR_SHOWN = "shown";

/** A year. The preference is per-device and there is nothing to expire it for. */
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Absent means SHOWN.
 *
 * The default has to be the visible sidebar: a first-time operator who cannot
 * see the navigation has no way to discover the control that would bring it
 * back, whereas a first-time operator who wants more room finds the toggle
 * sitting in front of them.
 */
export function isSidebarHidden(cookieValue: string | undefined): boolean {
  return cookieValue === SIDEBAR_HIDDEN;
}
