import type { IconName } from "@/components/ui/icon";

/**
 * The one list of destinations the dashboard has.
 *
 * WHY IT IS A FILE AND NOT THREE ARRAYS. Three surfaces render this list — the
 * desktop source list, the operator nav sheet and the customer tab bar — and
 * the previous shell kept its own copy in the only one of them that existed.
 * Two of the fourteen rows are both labelled "Pedidos" (a customer's own orders
 * and every order in the shop), and the only thing that tells them apart is the
 * group heading above them. A second copy of that list is therefore not a
 * duplication smell, it is the mechanism by which one surface quietly grows a
 * route the others do not have and an operator learns that "Pedidos" means
 * different things depending on which menu they opened it from.
 *
 * Adding a route here adds it everywhere. That is the whole contract.
 *
 * NO `"use client"`. This is data and one pure function; it inherits whichever
 * boundary imports it, so the sheet (client) and any server-rendered surface can
 * both read it without dragging the other's runtime along.
 *
 * WHAT IS DELIBERATELY ABSENT: `/admin/metrics`. The admin group now opens on
 * `/admin` — the overview — which the previous ADMIN_ITEMS did not contain at
 * all, so the one route an operator lands on from the toolbar wordmark was the
 * one route the navigation could not highlight.
 */

/**
 * Stable identity — AND the key under the `nav` message namespace.
 *
 * Deliberately one string rather than an `id` plus a `labelKey`. The pair can
 * only ever be equal, and a pair that can only be equal is a pair that can be
 * typo'd into disagreement: `{ id: "adminEmails", labelKey: "adminEmail" }`
 * compiles, renders `nav.adminEmail`, and shows the raw key to an operator. The
 * single read site is `t(item.id)`.
 */
export type NavItemId =
  | "overview"
  | "orders"
  | "addresses"
  | "profile"
  | "security"
  | "returns"
  | "adminOverview"
  | "adminProducts"
  | "adminPacks"
  | "adminOrders"
  | "adminCustomers"
  | "adminInventory"
  | "adminDiscounts"
  | "adminAffiliates"
  | "adminShipping"
  | "adminBlog"
  | "adminEmails"
  | "adminJobs"
  | "adminSettings";

/** Also a `nav` message key, for the same reason as `NavItemId`. */
export type NavGroupId = "customerGroup" | "adminGroup";

/**
 * The six destinations that can carry a count — "problems and open items", per
 * the artboard. The other eight never do: a count on Perfil or on Descuentos
 * answers no question anyone is asking, and a badge that is always there stops
 * being read within a week.
 *
 * A narrow union rather than `NavItemId` so that supplying a count for a
 * destination that has no slot is a compile error at the call site, not a
 * silently ignored key.
 */
export type NavCountId =
  | "orders"
  | "returns"
  | "adminOrders"
  | "adminInventory"
  | "adminEmails"
  | "adminJobs";

/**
 * How loudly the count is drawn.
 *
 * Three severities because the underlying facts are three: an order awaiting a
 * decision blocks money (critical), stock running low wants attention this week
 * (warning), and a queue length is just a number (neutral). The tone travels
 * with the COUNT and not with the item, because the same destination can be any
 * of the three — zero-available inventory is not the same news as low stock.
 */
export type NavCountTone = "critical" | "warning" | "neutral";

export interface NavCount {
  readonly value: number;
  readonly tone: NavCountTone;
  /**
   * A full, already-translated SENTENCE, and required.
   *
   * "2" beside "Pedidos" is meaningless read aloud — two what, and is that good
   * or bad? The digits are hidden from assistive technology and this is
   * announced instead ("2 pedidos necesitan una decisión"). It arrives
   * translated because the counts themselves arrive from a server component
   * that has already fetched them; the nav has no business doing i18n for a
   * number it did not compute.
   */
  readonly label: string;
}

/** Supplied per render by whoever fetched the numbers. Absent means "no badge". */
export type NavCounts = Partial<Readonly<Record<NavCountId, NavCount>>>;

export interface NavItem {
  readonly id: NavItemId;
  /**
   * Unprefixed. `Link` from `@/i18n/navigation` adds the locale segment, and a
   * hardcoded `/es/...` here is how an English customer gets bounced back to
   * Spanish on their next click.
   */
  readonly href: string;
  readonly icon: IconName;
  /**
   * The count slot: present when this destination may be badged.
   *
   * Repeats the id on purpose — it is the id NARROWED to `NavCountId`, which is
   * what makes `counts[item.count]` a typed lookup instead of an index into a
   * partial record with a key it cannot prove.
   */
  readonly count?: NavCountId;
  /**
   * An index route, matched exactly instead of by subtree. See
   * `isCurrentNavHref`.
   */
  readonly exact?: true;
}

export interface NavGroup {
  readonly id: NavGroupId;
  readonly items: readonly NavItem[];
}

/**
 * The customer's six. `/` is the account overview, not a marketing home — the
 * dashboard is mounted at its own host.
 */
export const CUSTOMER_NAV_GROUP: NavGroup = {
  id: "customerGroup",
  items: [
    { id: "overview", href: "/", icon: "house", exact: true },
    { id: "orders", href: "/orders", icon: "package", count: "orders" },
    { id: "addresses", href: "/addresses", icon: "map-pin" },
    { id: "profile", href: "/profile", icon: "user" },
    { id: "security", href: "/security", icon: "shield" },
    { id: "returns", href: "/returns", icon: "undo-2", count: "returns" },
  ],
};

/**
 * The operator's ten, in the artboard's order: the two an operator opens
 * every morning (overview, products) first, then the day's work, then the
 * ones they only visit when something is wrong or rarely at all —
 * `adminSettings` last of all, matching jobs and emails' own placement: not
 * a daily destination. `adminAffiliates` sits beside `adminDiscounts`: every
 * affiliate's earnings are read off the coupons pointing at it, so the two
 * screens are opened together. `adminShipping` (zones and rates) follows
 * them: configuration staff visit when prices change, not daily.
 */
export const ADMIN_NAV_GROUP: NavGroup = {
  id: "adminGroup",
  items: [
    { id: "adminOverview", href: "/admin", icon: "chart-line", exact: true },
    { id: "adminProducts", href: "/admin/products", icon: "tag" },
    { id: "adminPacks", href: "/admin/products/packs", icon: "shopping-bag" },
    { id: "adminOrders", href: "/admin/orders", icon: "package", count: "adminOrders" },
    { id: "adminCustomers", href: "/admin/customers", icon: "users" },
    { id: "adminInventory", href: "/admin/inventory", icon: "boxes", count: "adminInventory" },
    { id: "adminDiscounts", href: "/admin/discounts", icon: "percent" },
    { id: "adminAffiliates", href: "/admin/affiliates", icon: "share" },
    { id: "adminShipping", href: "/admin/shipping", icon: "truck" },
    { id: "adminBlog", href: "/admin/blog", icon: "file-text" },
    { id: "adminEmails", href: "/admin/emails", icon: "mail", count: "adminEmails" },
    { id: "adminJobs", href: "/admin/jobs", icon: "list-checks", count: "adminJobs" },
    { id: "adminSettings", href: "/admin/settings", icon: "sliders-horizontal" },
  ],
};

/**
 * Who sees what.
 *
 * A FUNCTION rather than two exported arrays each surface picks from, so the
 * rule "customers see one group, operators see both" is stated once. Hiding the
 * admin group is tidiness, not security: a customer who types an admin URL is
 * stopped by middleware, by the admin layout's server-side role assertion and
 * finally by the API's RolesGuard. This only avoids showing people doors they
 * cannot open — and, because `showAdmin` is decided on the server, the admin
 * hrefs are absent from a customer's HTML rather than shipped and hidden.
 */
export function navGroupsFor(showAdmin: boolean): readonly NavGroup[] {
  return showAdmin ? [CUSTOMER_NAV_GROUP, ADMIN_NAV_GROUP] : [CUSTOMER_NAV_GROUP];
}

/**
 * Whether `href` is the destination the current `pathname` belongs to.
 *
 * An item matches its whole SUBTREE, so `/orders/AK-2026-000412` still
 * highlights "Pedidos" and `/admin/products/new` still highlights "Productos".
 * The exception is an index route, which matches only itself, because its
 * subtree belongs to its siblings: without it `/` would be highlighted on every
 * page in the app, and `/admin` on every page in the admin area — and TWO rows
 * would then claim `aria-current`, which is a lie in the accessibility tree
 * before it is a bug in the styling.
 *
 * Lives here rather than in the sidebar because all three navigation surfaces
 * need the same answer, and "which row is selected" drifting between the
 * sidebar and the sheet is exactly the class of defect this file exists to
 * prevent.
 */
export function isCurrentNavHref(pathname: string, item: NavItem): boolean {
  if (item.exact === true) {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
