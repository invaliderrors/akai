"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Counter, type CounterTone } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Dialog } from "@/components/ui/overlay";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { accountInitials } from "./account-menu";
import {
  isCurrentNavHref,
  navGroupsFor,
  type NavCounts,
  type NavCountTone,
  type NavGroup,
} from "./nav-items";

/**
 * The operator's navigation below 900px: the source list as a modal sheet.
 *
 * WHY A SHEET AND NOT A TAB BAR. The phone split is deliberate and asymmetric.
 * A customer has six destinations, which fit five tabs once Perfil and
 * Seguridad merge into "Cuenta", and HIG says to reach for a tab bar first. An
 * operator has FOURTEEN across two groups, and there is no honest way to reduce
 * that to five: two of the rows are both called "Pedidos" — the operator's own
 * orders and every order in the shop — and the ONLY thing that tells them apart
 * is the heading above them. So the headings are kept here at every width, and
 * they are real `<h2>`s rather than styled spans so heading navigation reaches
 * them too.
 *
 * THAT IS PRECISELY THE BUG THIS REPLACES. The previous shell collapsed the
 * sidebar into a flat chip row below 860px and hid the group headings with a
 * media query, which offered an operator the word "Pedidos" twice with nothing
 * to choose between them. The rule survives the rewrite as: the headings never
 * collapse, at any width.
 *
 * ONE LIST, THREE SURFACES. The rows come from `nav-items.ts`, the same data
 * the sidebar and the tab bar read, and "which row is current" is the same
 * `isCurrentNavHref`. A second copy of either is how the sheet quietly grows a
 * route the sidebar does not have, or highlights a different row for the same
 * URL.
 *
 * NO FOCUS TRAP OF ITS OWN. `ui/overlay`'s `Dialog` owns the one piece of focus
 * management in the kit — the trap, Escape, the scrim press, the scroll lock
 * and the focus hand-back — and it is portalled to `document.body` because the
 * toolbar this trigger sits in is a `position: sticky` containing block that
 * would clip a fixed scrim to a 44px strip.
 *
 * `"use client"` is unavoidable and is confined here: the sheet is open/closed
 * state and `usePathname` decides the current row. The toolbar that receives
 * this as its `navControl` stays a server component.
 *
 * WHO RENDERS IT IS THE ROLE CHECK. There is no `showAdmin` prop, and the
 * absence is the point: the shell passes a `navControl` only for an operator,
 * so a customer's HTML contains neither the trigger nor a single admin href.
 * Taking the flag as well would put the same decision in two places, and the
 * copy that could be wrong is the one that leaks the admin routes.
 *
 * DELIBERATELY NOT LISTENING TO THE VIEWPORT. Rotating a large phone crosses
 * 900px, where the toolbar hides the trigger, and the sheet stays up. It is
 * then a redundant menu over a page that has just grown a sidebar — one tap,
 * one Escape or one scrim press from correct — and that is not worth making
 * this the only component in the shell that measures the window.
 */

/**
 * The same near-neighbour mapping the sidebar makes, and it must change with
 * it: `Counter` draws two tones, the artboard's amber low-stock capsule is a
 * third, and low stock is a problem awaiting action rather than a queue length,
 * so it renders as the problem capsule instead of the grey one. See
 * `side-nav.tsx` for the full argument. When `Counter` grows a warning tone,
 * both files change and the three-name vocabulary in `nav-items.ts` does not.
 */
const COUNTER_TONE: Readonly<Record<NavCountTone, CounterTone>> = {
  critical: "danger",
  warning: "danger",
  neutral: "neutral",
};

/**
 * 44pt rows with 15px labels, and both numbers are written here rather than
 * read from `--control-h` / `--font-body`.
 *
 * The sheet is neither density. Comfortable pairs 44px with 17px because that
 * is a form control on a reading column; this is a navigation row in a 300px
 * sheet, and the artboard draws the iOS sidebar pairing — a 44pt touch target
 * carrying a 15px label. Reading the height off the cascade while the type size
 * came from here is exactly how a row ends up 28px tall with 15px text in it,
 * the failure `ui/badge.tsx` inlines its own two heights to avoid.
 */
const ROW_BASE =
  "flex h-[44px] items-center gap-[10px] rounded-[8px] px-2 no-underline transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";
const ROW_SELECTED = "bg-[var(--accent-tint-strong)] font-semibold";
const ROW_IDLE = "hover:bg-[var(--fill-tertiary)]";

/** 44px hit target for both chrome buttons — the sheet is only ever touched. */
const SHEET_BUTTON =
  "inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[var(--r-control)] text-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";

export interface OperatorNavSheetProps {
  /** The signed-in address, restated in the sheet so it answers "whose account is this". */
  readonly email: string;
  /** The signed-in person's display name, when the caller has one. */
  readonly name?: string;
  /**
   * Problem and open-item counts, fetched and translated by the server
   * component that renders the shell — the same values the sidebar is handed,
   * because a phone must not report a different number of open orders than the
   * desktop does.
   */
  readonly counts?: NavCounts;
}

export function OperatorNavSheet({ email, name, counts = {} }: OperatorNavSheetProps) {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const tui = useTranslations("ui");
  const pathname = usePathname();

  const [open, setOpen] = useState(false);

  function dismiss(): void {
    setOpen(false);
  }

  function renderGroup(group: NavGroup) {
    return (
      <div key={group.id} className="grid gap-px">
        {/* The one string separating the two rows labelled "Pedidos". A real
            heading, not a styled span. */}
        <h2 className="mb-1 ms-2 text-[11px] font-semibold text-[var(--label-secondary)]">
          {t(group.id)}
        </h2>

        {group.items.map((item) => {
          const current = isCurrentNavHref(pathname, item);
          const count = item.count === undefined ? undefined : counts[item.count];

          return (
            <Link
              key={item.id}
              href={item.href}
              // A modal that survives the navigation it just performed leaves
              // the operator looking at a menu over the page they asked for.
              // Closing here rather than on a pathname effect keeps it to the
              // one gesture that means "go there", so a back-button change of
              // route cannot toggle a sheet nobody opened.
              onClick={dismiss}
              className={`${ROW_BASE} ${current ? ROW_SELECTED : ROW_IDLE}`}
              // The a11y signal and the styling hook are the SAME attribute, so
              // the highlighted row is always the one announced as current.
              {...(current ? { "aria-current": "page" as const } : {})}
            >
              {/* 20px accent glyphs, per HIG › Sidebars, and `aria-hidden` by
                  default: the icon repeats the label beside it. */}
              <Icon name={item.icon} size={20} className="text-[var(--accent)]" />
              <span className="min-w-0 truncate">{t(item.id)}</span>
              {count === undefined ? null : (
                <Counter
                  count={count.value}
                  label={count.label}
                  tone={COUNTER_TONE[count.tone]}
                  // Comfortable, though the artboard draws 20px — between the
                  // primitive's two heights. The primitive owns those two
                  // sizes; inlining a third here would put badge geometry back
                  // in a consumer, and 18px reads as a desktop capsule dropped
                  // into a 44pt touch row.
                  density="comfortable"
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        // "Menú", not the toolbar's "Mostrar la barra lateral": below 900px
        // there is no sidebar, and a label promising one names a control this
        // width does not have. The dialog it opens carries the same word.
        aria-label={tc("menu")}
        className={SHEET_BUTTON}
      >
        <Icon name="panel-left" size={20} />
      </button>

      <Dialog
        open={open}
        onClose={dismiss}
        label={tc("menu")}
        // Glass and left-anchored: `placement="start"` is the kit's edge sheet —
        // 300px, full height, and the scrim the artboard draws at 30% black.
        surface="glass"
        placement="start"
        // The panel is a column so the identity stays put and only the list
        // scrolls; fourteen 44pt rows plus the identity block overflow a phone.
        className="flex flex-col"
      >
        <div className="flex h-[44px] shrink-0 items-center gap-2 ps-4 pe-1">
          <span className="text-[17px] font-semibold tracking-[-0.43px] text-[var(--label)]">
            {tc("brand")}
          </span>
          {/* An explicit close button as well as Escape and the scrim: on a
              phone there is no keyboard, and the scrim is a 40px strip beside a
              300px sheet. */}
          <button
            type="button"
            onClick={dismiss}
            aria-label={tui("close")}
            className={`ms-auto ${SHEET_BUTTON}`}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        {/* WHY THE IDENTITY IS RESTATED HERE. The toolbar drops the address text
            below the desktop breakpoint and keeps only the avatar, so without
            this block an operator would have to close the sheet and open the
            account menu to answer "which account am I about to refund from".
            The initials come from `accountInitials` rather than a second
            derivation, or this disc and the toolbar's disc would disagree about
            the same person. */}
        <div className="flex shrink-0 items-center gap-[10px] border-b border-[var(--separator-weak)] px-4 pb-3 pt-2">
          <span
            aria-hidden="true"
            className="inline-flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[var(--r-pill)] bg-[var(--accent)] text-[12px] font-semibold text-[var(--label-on-accent)]"
          >
            {accountInitials(email, name)}
          </span>
          <div className="min-w-0">
            {name === undefined ? null : (
              <p className="m-0 text-[15px] font-semibold text-[var(--label)]">{name}</p>
            )}
            {/* Truncates rather than wraps: a long address must not push the
                first navigation row off the top of the sheet. */}
            <p
              className={`m-0 truncate ${
                name === undefined
                  ? "text-[15px] font-semibold text-[var(--label)]"
                  : "text-[12px] text-[var(--label-secondary)]"
              }`}
            >
              {/* Sighted readers get the answer from the avatar and the layout;
                  read aloud, a bare address is just a string. */}
              <span className="sr-only">{`${tc("signedInAs")} `}</span>
              <span>{email}</span>
            </p>
          </div>
        </div>

        <nav
          aria-label={tc("primaryNav")}
          className="grid min-h-0 flex-1 content-start gap-[14px] overflow-y-auto p-2 text-[15px] text-[var(--label)]"
        >
          {/* Both groups, always. This component IS the operator surface — see
              the note above on why the role check lives at the call site. */}
          {navGroupsFor(true).map(renderGroup)}
        </nav>
      </Dialog>
    </>
  );
}
