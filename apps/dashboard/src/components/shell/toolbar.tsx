import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Icon } from "@/components/ui/icon";
import { publicEnv } from "@/lib/env";
import { Link, getPathname } from "@/i18n/navigation";

import { AccountMenu } from "./account-menu";
import { SidebarToggle } from "./sidebar-toggle";

/**
 * The signed-in toolbar: 52pt on the desktop, 44pt on a phone, sticky, glass.
 *
 * A SERVER COMPONENT. The two things here that need the browser — the account
 * menu and the sidebar toggle — are separate client modules, so the wordmark,
 * the area badge, the search form and the identity line cost the browser
 * nothing and ship none of their strings.
 *
 * `.nx-glass` rather than a hand-rolled `backdrop-filter`: it is the kit's one
 * bespoke class and the single place the Reduce Transparency swap lands, shared
 * with the sheet, the popover and the toast.
 *
 * MONOCHROME, WITH EXACTLY ONE TINT. Every control here is label-grey; the only
 * filled thing in the bar is the area badge, and for administration it is
 * INK-filled. That is a deliberate signal rather than decoration: on a shared
 * screen an operator should be able to tell at a glance that money can move
 * from the page they are looking at.
 *
 * THE IDENTITY NEVER DISAPPEARS. Below the desktop breakpoint the address text
 * is dropped and the avatar stays — and the avatar's accessible name is the
 * address, with the full identity one tap away inside `AccountMenu`. The
 * previous shell hid the identity outright below 700px, which is the thing this
 * replaces.
 *
 * THE SEARCH SLOT IS AN ORDER-NUMBER LOOKUP, not a command palette. `/admin/orders`
 * with an `orderNumber` filter is the one search the API actually answers;
 * there is no endpoint behind a global search over SKUs, addresses or lot
 * codes, so building the box would be asserting a capability the platform does
 * not have.
 */

export type ToolbarArea = "account" | "admin";

/**
 * The badge's two paints.
 *
 * Ink for administration, quiet grey fill for the customer's own account. The
 * geometry is fixed rather than read from `--r-control`/`--badge-h`: this is a
 * 20px chip in a fixed-height bar and it must look identical either side of the
 * shell's density switch, exactly as `ui/badge.tsx` inlines its own two heights.
 */
const AREA_BADGE_CLASS: Readonly<Record<ToolbarArea, string>> = {
  account: "bg-[var(--fill-tertiary)] text-[var(--neutral-text)]",
  admin: "bg-[var(--label)] text-[var(--label-on-accent)]",
};

/** Keyed rather than interpolated, so a renamed message is a compile error. */
const AREA_BADGE_KEY: Readonly<Record<ToolbarArea, "areaBadge.account" | "areaBadge.admin">> = {
  account: "areaBadge.account",
  admin: "areaBadge.admin",
};

export interface ToolbarProps {
  readonly area: ToolbarArea;
  /** The signed-in address. Shown as text on the desktop, in the menu always. */
  readonly email: string;
  /** The signed-in person's display name, when the caller has one. */
  readonly name?: string;
  /**
   * Whether the shell rendered WITHOUT its sidebar, read from the `sidebar`
   * cookie server-side. Required rather than defaulted: a toggle whose label
   * disagrees with what is on screen tells a screen-reader user the opposite of
   * the truth, and one compiler error at the single call site is the cheapest
   * possible way to prevent that.
   */
  readonly sidebarHidden: boolean;
  /**
   * The phone-width leading control — the operator's nav sheet trigger.
   *
   * A slot because the two areas answer it differently: an operator opens the
   * fourteen-item sheet from here, and a customer has a tab bar along the
   * bottom and therefore needs nothing at all. Never rendered at desktop width,
   * where the sidebar toggle takes the same corner.
   */
  readonly navControl?: ReactNode;
  /**
   * The centred phone title. Defaults to the wordmark, which is what the
   * customer artboards draw; an operator screen may pass its own.
   */
  readonly title?: string;
}

export function Toolbar({ area, email, name, sidebarHidden, navControl, title }: ToolbarProps) {
  const t = useTranslations("common");

  /**
   * The GET form needs a REAL path, and `action` is plain HTML that knows
   * nothing about next-intl — so the locale prefix has to be baked in or every
   * English operator's search would land them in Spanish. (`ui/filter-bar.tsx`
   * has the opposite problem and solves it by omitting `action` entirely, which
   * only works because it submits to the page it is already on.) The
   * conditional produces the `"es" | "en"` literal union rather than narrowing
   * a widened `string`, so no cast is involved.
   */
  const locale = useLocale() === "en" ? "en" : "es";
  const ordersPath = getPathname({ href: "/admin/orders", locale });

  return (
    <header
      className="sticky top-0 z-40 flex h-[44px] items-center gap-1 border-b border-[var(--separator-weak)] px-2 nx-glass min-[900px]:h-[var(--toolbar-h)] min-[900px]:gap-3 min-[900px]:px-4"
    >
      <div className="hidden min-[900px]:flex">
        <SidebarToggle hidden={sidebarHidden} />
      </div>

      {navControl === undefined ? null : (
        <div className="flex min-[900px]:hidden">{navControl}</div>
      )}

      {/* The phone nav bar centres its title in the BAR, not in the space left
          over by the controls either side — so it is positioned against the
          header rather than laid out in the flex row, and takes no pointer
          events so it cannot swallow a tap meant for the button underneath. */}
      <span className="pointer-events-none absolute inset-x-0 truncate px-12 text-center text-[17px] font-semibold tracking-[-0.43px] text-[var(--label)] min-[900px]:hidden">
        {title ?? t("brand")}
      </span>

      <span className="hidden text-[15px] font-semibold tracking-[-0.23px] text-[var(--label)] min-[900px]:inline">
        {t("brand")}
      </span>

      {/* `relative` so the chip paints over the absolutely-centred phone title
          rather than under it. */}
      <span
        className={`relative inline-flex h-[20px] shrink-0 items-center rounded-[5px] px-[7px] text-[11px] font-semibold min-[900px]:px-2 ${AREA_BADGE_CLASS[area]}`}
      >
        {t(AREA_BADGE_KEY[area])}
      </span>

      {area === "admin" ? (
        <form
          method="get"
          action={ordersPath}
          // A landmark, and `search` rather than the implicit `form`: this is
          // the operator's one lookup and it is worth being able to jump to.
          role="search"
          aria-label={t("search")}
          className="relative ms-3 hidden max-w-[380px] flex-1 min-[900px]:block"
        >
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute left-2 top-[7px] text-[var(--label-secondary)]"
          />
          <input
            type="search"
            name="orderNumber"
            aria-label={t("search")}
            placeholder={t("searchPlaceholder")}
            className="h-[28px] w-full rounded-[7px] border-0 bg-[var(--fill-tertiary)] py-0 pe-2 ps-7 text-[13px] text-[var(--label)] placeholder:text-[var(--label-secondary)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
          />
        </form>
      ) : null}

      <div className="relative ms-auto flex items-center gap-1 min-[900px]:gap-[10px]">
        {area === "admin" ? (
          // A LINK, not a box that expands: the destination of the desktop form
          // is a list that already carries the same filter, so on a phone the
          // honest control is one that takes the operator to it. Nothing here
          // needs client state, and the search survives with JavaScript off.
          <Link
            href="/admin/orders"
            aria-label={t("search")}
            className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-[var(--r-control)] text-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)] min-[900px]:hidden"
          >
            <Icon name="search" size={20} />
          </Link>
        ) : null}

        <span className="hidden text-[12px] text-[var(--label-secondary)] min-[900px]:inline">
          {email}
        </span>

        <AccountMenu
          email={email}
          {...(name === undefined ? {} : { name })}
          {...(publicEnv.storeUrl === "" ? {} : { storeHref: publicEnv.storeUrl })}
        />
      </div>
    </header>
  );
}
