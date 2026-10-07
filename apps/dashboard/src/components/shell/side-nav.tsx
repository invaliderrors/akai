"use client";

import { useTranslations } from "next-intl";

import { Counter, type CounterTone } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  isCurrentNavHref,
  navGroupsFor,
  type NavCounts,
  type NavCountTone,
  type NavGroup,
} from "./nav-items";

/**
 * The dashboard's primary navigation: a 220pt macOS source list.
 *
 * WHAT THIS REPLACES. A flat column of underlined links whose group headings
 * were hidden below 860px, collapsing the whole thing into one chip row. Two of
 * the rows read "Pedidos" — a customer's own orders and every order in the shop
 * — and the heading was the only thing that told them apart, so at phone width
 * an operator was offered the same word twice with nothing to choose between
 * them. The headings therefore NEVER collapse here, at any width. (The phone
 * does not shrink this component at all: customers get a tab bar and operators
 * get this list as a sheet, both of which read the same `nav-items.ts`.)
 *
 * A CLIENT COMPONENT FOR EXACTLY ONE REASON: `usePathname`, to mark the current
 * page. Nothing else here holds state. `showAdmin` is therefore still a PROP
 * decided by a server-side role check rather than a client session hook — that
 * is what keeps the admin hrefs out of a customer's HTML instead of shipping
 * them and hiding them with CSS.
 *
 * THE SURFACE, NOT THE COLUMN. This paints its own background, hairline and
 * sticky offset, exactly as the artboard draws them on the `<nav>` itself. The
 * 220px grid track it sits in, and the decision to render that track at all,
 * belong to `DashboardShell` — which is also where the sidebar-hidden cookie is
 * read, because a component that can be hidden must not be the thing that
 * decides it is hidden.
 */

export interface SideNavProps {
  readonly showAdmin: boolean;
  /**
   * Problem and open-item counts, fetched and translated by the server
   * component that renders the shell. Omitted entirely — the common case — no
   * badge is drawn anywhere.
   */
  readonly counts?: NavCounts;
}

/**
 * `Counter` draws two tones: neutral for a queue length, danger for a problem.
 * The artboard draws a third — amber, `--warning-fill` on `--warning-text` — for
 * low stock, so `warning` renders as the problem capsule here rather than as
 * the grey one.
 *
 * That is the near neighbour, not a shrug: the primitive's own rule is "a queue
 * length is not an alarm", and stock running out IS a problem awaiting action
 * where a queue length is not. Rendering it grey would file it with "3 trabajos
 * en cola" and it would stop being read. When `Counter` grows a warning tone,
 * this one line changes and the vocabulary above it does not — which is the
 * reason the vocabulary keeps all three names today.
 */
const COUNTER_TONE: Readonly<Record<NavCountTone, CounterTone>> = {
  critical: "danger",
  warning: "danger",
  neutral: "neutral",
};

/**
 * 28pt rows, 6px corners and 13px labels in BOTH areas — the customer artboards
 * draw the identical source list beside their comfortable 44pt content.
 *
 * Declaring the density here rather than inheriting the shell's is the point: a
 * sidebar is chrome, and chrome does not change size because the page it frames
 * did. Done through the same `data-density` attribute the token layer already
 * switches on, so `--control-h`, `--r-control`, `--font-body` and the counter
 * all move together instead of being pinned one literal at a time.
 */
const NAV_CLASS =
  "sticky top-[var(--toolbar-h)] grid w-full content-start gap-[14px] self-start border-r border-[var(--separator-weak)] bg-[var(--bg-grouped)] p-2 text-[var(--font-body)] text-[var(--label)]";

/**
 * `--accent-tint-strong` and weight 600, with no leading rail (HIG › Sidebars).
 * The earlier cut drew a 2px accent bar as well; tint plus weight already
 * carries it, and the rail was the thing that made a 28pt row feel cramped.
 */
const ROW_BASE =
  "flex h-[var(--control-h)] items-center gap-2 rounded-[var(--r-control)] px-2 no-underline transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";
const ROW_SELECTED = "bg-[var(--accent-tint-strong)] font-semibold";
const ROW_IDLE = "hover:bg-[var(--fill-tertiary)]";

export function SideNav({ showAdmin, counts = {} }: SideNavProps) {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const pathname = usePathname();

  function renderGroup(group: NavGroup) {
    return (
      <div key={group.id} className="grid gap-px">
        {/* A real heading, not a styled span: it is the only thing separating
            the two rows labelled "Pedidos", so it has to be reachable by
            heading navigation and not merely visible. */}
        <h2 className="mb-[3px] ms-2 text-[11px] font-semibold text-[var(--label-secondary)]">
          {t(group.id)}
        </h2>

        {group.items.map((item) => {
          const current = isCurrentNavHref(pathname, item);
          const count = item.count === undefined ? undefined : counts[item.count];

          return (
            <Link
              key={item.id}
              href={item.href}
              className={`${ROW_BASE} ${current ? ROW_SELECTED : ROW_IDLE}`}
              // The a11y signal and the styling hook are the SAME attribute, so
              // a highlighted row is always the one a screen reader announces as
              // current. They must never diverge into a `selected` class that
              // says one thing and an aria attribute that says another.
              {...(current ? { "aria-current": "page" as const } : {})}
            >
              {/* Accent glyphs, per HIG › Sidebars. `aria-hidden` by default:
                  the icon repeats the label beside it and announcing both is
                  noise. */}
              <Icon name={item.icon} className="text-[var(--accent)]" />
              <span className="min-w-0 truncate">{t(item.id)}</span>
              {count === undefined ? null : (
                // `ms-auto` rather than a spacer: the counter is the only thing
                // that may sit on the trailing edge, and a long label should
                // truncate before it pushes the badge off the row.
                <Counter
                  count={count.value}
                  label={count.label}
                  tone={COUNTER_TONE[count.tone]}
                  density="compact"
                  className="ms-auto"
                />
              )}
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <nav aria-label={tc("primaryNav")} data-density="compact" className={NAV_CLASS}>
      {navGroupsFor(showAdmin).map(renderGroup)}
    </nav>
  );
}
