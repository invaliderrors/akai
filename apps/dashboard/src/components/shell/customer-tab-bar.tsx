"use client";

import { useTranslations } from "next-intl";

import { Icon } from "@/components/ui/icon";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  CUSTOMER_NAV_GROUP,
  isCurrentNavHref,
  type NavCounts,
  type NavCountTone,
  type NavItem,
  type NavItemId,
} from "./nav-items";

/**
 * The customer's phone navigation: five glass tabs pinned to the bottom edge.
 *
 * WHAT THIS REPLACES. A row of chips that was the sidebar with its group
 * headings hidden — the arrangement in which a customer was shown the same six
 * links, unlabelled by area, squeezed into a horizontal scroller. HIG › Tab
 * bars is explicit that a flat set of top-level destinations should "consider
 * using a tab bar first", and this is that set.
 *
 * TABS NAVIGATE. THEY NEVER ACT. There is no sign-out here, no language
 * switch, no menu — a tab that performs an action rather than moving somewhere
 * breaks the one promise a tab bar makes, which is that the bar tells you where
 * you are and that tapping does not commit you to anything. Sign-out lives in
 * the toolbar's account menu, which is present at every width.
 *
 * NOT `role="tablist"`. ARIA tabs switch panels WITHIN a document and imply
 * arrow-key roving focus and an `aria-controls` relationship to a `tabpanel`.
 * These are links to five different documents. The honest markup is a
 * navigation landmark full of anchors, with `aria-current="page"` naming the
 * one you are on — which is what the artboard draws.
 *
 * A CLIENT COMPONENT FOR EXACTLY ONE REASON: `usePathname`. Nothing here holds
 * state and nothing here is fetched.
 *
 * LAYOUT CONTRACT. The bar is `fixed` to the viewport's bottom edge and hidden
 * from 900px up, so it can never collide with the sidebar. Being fixed, it
 * paints OVER the end of the page: the shell owes `<main>` a bottom inset of
 * 83px below 900px, or the last row of every list sits underneath it.
 */

/**
 * The five tabs, which are NOT the six destinations.
 *
 * Also the `nav` message keys, exactly as `NavItemId` is — see nav-items.ts for
 * why an id and a separate `labelKey` is a pair that can be typo'd apart.
 * `account` is the only member here that is not a `NavItemId`, and that is the
 * merge below made visible in the type.
 */
export type CustomerTabId = "overview" | "orders" | "returns" | "addresses" | "account";

interface CustomerTab {
  readonly id: CustomerTabId;
  /**
   * Every destination this tab stands for. The FIRST is where it navigates and
   * whose icon and count it draws; ALL of them light it.
   *
   * A non-empty tuple rather than `readonly NavItem[]` so that `covers[0]` is a
   * `NavItem` and not `NavItem | undefined` under `noUncheckedIndexedAccess` —
   * the alternative is a non-null assertion, which this repo does not allow and
   * which would be dodging a real question (a tab covering nothing).
   */
  readonly covers: readonly [NavItem, ...NavItem[]];
}

/**
 * Pulls a destination out of the ONE list, by id.
 *
 * Throws rather than skipping. A tab bar that quietly renders four columns
 * because a route was renamed in nav-items.ts is a defect nobody files: it
 * still looks deliberate, and the missing destination is simply unreachable on
 * a phone. The colocated test renders all five, so this fires in CI and not in
 * front of a customer.
 */
function customerDestination(id: NavItemId): NavItem {
  const item = CUSTOMER_NAV_GROUP.items.find((candidate) => candidate.id === id);

  if (item === undefined) {
    throw new Error(`customer-tab-bar: "${id}" is not in CUSTOMER_NAV_GROUP`);
  }

  return item;
}

/**
 * THE MERGE. Six customer destinations, five columns — Profile and Security
 * share one "Account" tab.
 *
 * They are the pair to merge because they are the only two that are both about
 * the person rather than about their orders, and because the tab lands on a
 * screen that reaches the other: Profile carries the link across to Security,
 * and the toolbar's account menu — which never disappears — carries Sign Out.
 * A merge whose landing screen were a dead end would have hidden a route rather
 * than folded one.
 *
 * The merge is therefore in the ACTIVE STATE too, not only in the label: a
 * customer reading `/security` is still "in" Account, and a tab bar that
 * highlights nothing at all on a screen the customer reached from it is the
 * thing that makes people think they have left the app.
 *
 * ORDER IS THE TAB BAR'S OWN, not the sidebar's. The desktop source list is a
 * scannable index and reads in the order things are set up; five thumb-sized
 * columns are ranked by how often they are opened on a phone, which is the
 * artboard's order — and it puts Returns, the one tab that can carry a badge a
 * customer needs to act on, in the middle where a thumb rests.
 */
const TABS: readonly CustomerTab[] = [
  { id: "overview", covers: [customerDestination("overview")] },
  { id: "orders", covers: [customerDestination("orders")] },
  { id: "returns", covers: [customerDestination("returns")] },
  { id: "addresses", covers: [customerDestination("addresses")] },
  { id: "account", covers: [customerDestination("profile"), customerDestination("security")] },
];

/**
 * 83px including the 28px home-indicator inset, so the labels clear the gesture
 * bar on a modern iPhone and the bar still reads as full-bleed. Five equal
 * columns, because unequal tabs are the thing that makes a five-item bar feel
 * like a toolbar.
 *
 * `.nx-glass` and not a hand-rolled `backdrop-filter`: it is the kit's one
 * bespoke class and the single place the Reduce Transparency swap lands, shared
 * with the toolbar, the sheet, the popover and the toast.
 *
 * `min-[900px]:hidden` lives HERE rather than in a wrapper the shell supplies,
 * because 900px is not a layout preference — it is the width at which the
 * sidebar exists, and two primary navigations on screen at once is the defect.
 * `display:none` also takes this landmark out of the accessibility tree
 * entirely, which is why it can share the sidebar's name without two
 * identically-named navigation landmarks ever coexisting.
 */
const BAR_CLASS =
  "nx-glass fixed inset-x-0 bottom-0 z-40 grid h-[83px] grid-cols-5 border-t border-[var(--separator-weak)] px-2 pb-[28px] pt-[6px] text-[10px] font-medium min-[900px]:hidden";

/**
 * The 4px focus ring is painted on the column itself, so the 10px corner is
 * only ever seen as the ring's shape. Fixed rather than `--r-control`: this bar
 * is chrome and does not resize with the density of the page it frames.
 */
const TAB_CLASS =
  "relative grid content-start justify-items-center gap-[3px] rounded-[10px] pt-[2px] no-underline focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";

/**
 * Selected is `--accent`, idle is `--neutral`, and colour is the ONLY thing
 * that differs — no weight change, no fill, no indicator bar. That is HIG's
 * treatment and it is also what keeps five 10px labels from reflowing when the
 * selection moves.
 *
 * `aria-current` is both the accessibility signal and the styling hook, exactly
 * as in the sidebar. They must never become a `selected` class saying one thing
 * and an aria attribute saying another.
 */
const TAB_SELECTED = "text-[var(--accent)]";
const TAB_IDLE = "text-[var(--neutral)]";

/**
 * The badge is drawn here rather than with `ui/badge.tsx`'s `Counter`, and the
 * red is deliberately the OTHER red.
 *
 * `Counter` is an inline capsule that sits at the end of a row, 18px tall with
 * 11px figures, and its danger fill is `--danger-text` (#d70015) — the deep red
 * that reads as text on a pale surface. This is a 16px disc pinned over the
 * corner of an icon on a translucent bar, and it takes `--danger` (#ff3b30),
 * the bright indicator red, which is what an overlay dot is for. One family,
 * two correct role applications; neither is a new token and neither surface is
 * wrong.
 *
 * `neutral` keeps the quiet fill for the same reason the sidebar gives: a queue
 * length is not an alarm, and a customer's "1 order on its way" is news, not a
 * problem. Only `critical` and `warning` earn the red disc.
 */
const BADGE_TONE: Readonly<Record<NavCountTone, string>> = {
  critical: "bg-[var(--danger)] text-[var(--label-on-accent)]",
  warning: "bg-[var(--danger)] text-[var(--label-on-accent)]",
  neutral: "bg-[var(--fill-tertiary)] text-[var(--neutral-text)]",
};

export interface CustomerTabBarProps {
  /**
   * Problem and open-item counts, fetched and translated by the server
   * component that renders the shell — the same shape the sidebar takes, so one
   * fetch feeds both surfaces. Omitted, the common case, no badge is drawn.
   *
   * Only the counts belonging to a customer destination can ever appear here;
   * the admin slots in `NavCounts` are simply never read, because an operator
   * on a phone gets the sheet rather than this bar.
   */
  readonly counts?: NavCounts;
}

export function CustomerTabBar({ counts = {} }: CustomerTabBarProps) {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const pathname = usePathname();

  return (
    <nav aria-label={tc("primaryNav")} className={BAR_CLASS}>
      {TABS.map((tab) => {
        const [destination] = tab.covers;
        const current = tab.covers.some((item) => isCurrentNavHref(pathname, item));
        const count =
          destination.count === undefined ? undefined : counts[destination.count];

        return (
          <Link
            key={tab.id}
            href={destination.href}
            className={`${TAB_CLASS} ${current ? TAB_SELECTED : TAB_IDLE}`}
            {...(current ? { "aria-current": "page" as const } : {})}
          >
            {/* 24px, well above the 16/20px used everywhere else in the shell:
                on a phone the glyph is what is aimed at and read, and the 10px
                label merely confirms it. `aria-hidden` by default — it repeats
                the label beside it. */}
            <Icon name={destination.icon} size={24} />

            {/* `truncate` and not a wrap: five columns are 61px wide on the
                narrowest phone the shop sees, and a label that goes to two
                lines pushes the bar's content into the home-indicator inset.
                iOS truncates a long tab title for the same reason. */}
            <span className="w-full truncate text-center">{t(tab.id)}</span>
            {count === undefined ? null : (
              <span
                // Over the icon's trailing corner, which is where a badge is
                // read as "this destination has something", rather than beside
                // the label where it would be read as part of the word.
                className={`absolute top-0 start-[calc(50%_+_6px)] inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--r-pill)] px-1 font-semibold tabular-nums ${
                  BADGE_TONE[count.tone]
                }`}
              >
                {/* The digits are hidden and the sentence is announced instead:
                    "1" read aloud beside "Devoluciones" answers nothing. The
                    sentence is `sr-only` text rather than an `aria-label`
                    because it has to fold into the LINK's accessible name. */}
                <span aria-hidden="true">{count.value}</span>
                <span className="sr-only">{count.label}</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
