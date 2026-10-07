"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslations } from "next-intl";

import { Popover } from "@/components/ui/overlay";
import Link from "next/link";

import { SignOutButton } from "./sign-out-button";

/**
 * The toolbar's identity menu.
 *
 * THIS IS WHERE THE ADDRESS LIVES AT EVERY WIDTH. The toolbar drops the email
 * text below the desktop breakpoint and keeps the avatar, so "identity
 * collapses to the avatar, never to nothing" is only true because this panel
 * restates the signed-in address one tap away. It is also the product's single
 * language affordance.
 *
 * BUILT ON `ui/overlay`'s Popover — it does NOT grow a second focus trap. That
 * file owns the one piece of focus management in the kit (Escape, outside
 * pointer-down, focus restore); a popover is deliberately not trapped, because
 * a menu is a place you can leave.
 *
 * `"use client"` is unavoidable and is confined here rather than pushed up into
 * the toolbar: the panel is open/closed state, the language row needs the live
 * pathname, and sign-out is an event handler. The toolbar around it stays a
 * server component and ships none of its own strings.
 *
 * WHY ARROW KEYS ARE IMPLEMENTED HERE. `role="menu"` is a promise: assistive
 * technology switches into application mode inside one and expects Up/Down to
 * move between items, where Tab often will not. Declaring the role without the
 * keys is the kind of accessibility that passes an automated audit and fails a
 * person. The handler sits on ONE `role="none"` wrapper and works by bubbling,
 * so every row — including the sign-out button, which lives in its own file —
 * gets it without being handed a callback.
 */

/**
 * One row of the menu, and the same paint for a link and for a button.
 *
 * The highlight is a filled row rather than a focus RING, which is the one
 * place in this kit that deviates from the standard treatment. Two reasons: a
 * 4px ring drawn inside a 4px-padded panel is clipped on three sides, and a
 * menu's convention is that the focused row IS the highlighted row. `focus:`
 * and not `focus-visible:` for the same reason — a row focused by a pointer in
 * an open menu must look focused too.
 */
const MENU_ITEM_CLASS =
  "flex h-[26px] w-full items-center gap-2 rounded-[5px] px-[10px] text-[13px] text-[var(--label)] no-underline " +
  "hover:bg-[var(--accent)] hover:text-[var(--label-on-accent)] " +
  "focus:bg-[var(--accent)] focus:text-[var(--label-on-accent)] focus-visible:outline-none " +
  "disabled:text-[var(--label-tertiary)] disabled:hover:bg-transparent";

/**
 * Two letters for the avatar.
 *
 * Prefers the name and falls back to the local part of the address, so an
 * operator whose profile carries no name still gets `OP` rather than a blank
 * disc. Exported because the avatar is the identity at phone width and the
 * derivation is the sort of thing worth pinning in a test.
 */
export function accountInitials(email: string, name?: string): string {
  const source = (name ?? email.split("@")[0] ?? "").trim();
  const words = source.split(/[\s._-]+/u).filter((word) => word !== "");

  const first = words[0];
  if (first === undefined) {
    return "?";
  }

  const second = words[1];
  const letters = second === undefined ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`;
  return letters.toUpperCase();
}

/**
 * Up/Down/Home/End across the rows, wrapping at both ends.
 *
 * Reads the rows out of the DOM rather than from a ref list because the rows
 * are a mix of anchors and a button living in another module, and a registry
 * would be a second source of truth for "what is in this menu" that could
 * disagree with what is on screen.
 */
function handleMenuKeys(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }

  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
  ];
  const last = items.length - 1;
  if (last < 0) {
    return;
  }

  // Only after we know there is somewhere to go: preventing the default of a
  // key we then ignore would swallow the page scroll for nothing.
  event.preventDefault();

  if (event.key === "Home") {
    items[0]?.focus();
    return;
  }
  if (event.key === "End") {
    items[last]?.focus();
    return;
  }

  const current = items.findIndex((item) => item === document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  // Nothing focused yet (the panel itself holds focus on open): Down enters at
  // the top and Up enters at the bottom, which is what a menu is expected to do.
  const next = current === -1 ? (step === 1 ? 0 : last) : current + step;
  items[((next % items.length) + items.length) % items.length]?.focus();
}

export interface AccountMenuProps {
  /** The signed-in address. Always shown in the panel, at every width. */
  readonly email: string;
  /**
   * The signed-in person's display name, when the caller has one.
   *
   * Optional because the sealed session carries an address and a role and no
   * name — so today this is usually absent and the panel leads with the email
   * instead. It is a prop rather than a fetch because the shell around it is a
   * server component and must not grow a round trip per page view.
   */
  readonly name?: string;
  /**
   * Absolute origin of the public shop, for "Back to the shop".
   *
   * Omitted — or empty — renders NO row rather than a link to `""`, which the
   * browser resolves to the current page. An unconfigured storefront origin is
   * better represented by a missing affordance than by one that lies.
   */
  readonly storeHref?: string;
}

export function AccountMenu({ email, name, storeHref }: AccountMenuProps) {
  const t = useTranslations("common");

  const initials = accountInitials(email, name);

  return (
    <Popover
      role="menu"
      align="end"
      label={t("accountMenu")}
      className="w-[240px]"
      trigger={(props) => (
        <button
          {...props}
          // The address, not a bare "Account": on a shared screen the whole
          // point of the avatar is to answer "whose session is this", and a
          // screen-reader user gets that answer from the trigger rather than
          // having to open the menu to find it.
          aria-label={`${t("signedInAs")} ${email}`}
          className="group inline-flex h-[44px] w-[44px] items-center justify-center focus-visible:outline-none min-[900px]:h-[28px] min-[900px]:w-[28px]"
        >
          {/* A 28px disc inside a 44px hit target: the drawn size on desktop is
              also the minimum comfortable target on a phone, so the target grows
              and the disc does not. The ring is painted on the disc, not on the
              button, or a focused avatar would wear a 44px pill on phones. */}
          <span
            aria-hidden="true"
            className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-[var(--r-pill)] bg-[var(--accent)] text-[11px] font-semibold text-[var(--label-on-accent)] group-focus-visible:shadow-[0_0_0_3px_var(--focus-ring)]"
          >
            {initials}
          </span>
        </button>
      )}
    >
      {(close) => (
        <div role="none" onKeyDown={handleMenuKeys}>
          <div className="mb-1 border-b border-[var(--separator-weak)] px-[10px] pb-2 pt-1.5">
            {name === undefined ? null : (
              <p className="m-0 text-[13px] font-semibold text-[var(--label)]">{name}</p>
            )}
            {/* Truncates rather than wraps. A long address must not be allowed
                to make the panel taller than the rows it exists to label. */}
            <p
              className={`m-0 truncate ${
                name === undefined
                  ? "text-[13px] font-semibold text-[var(--label)]"
                  : "text-[11px] text-[var(--label-secondary)]"
              }`}
            >
              {email}
            </p>
          </div>

          <Link role="menuitem" href="/profile" onClick={close} className={MENU_ITEM_CLASS}>
            {t("profile")}
          </Link>

          {storeHref === undefined || storeHref === "" ? null : (
            // A plain anchor, not `Link`: this leaves the dashboard for another
            // origin, which client-side routing cannot reach.
            <a role="menuitem" href={storeHref} onClick={close} className={MENU_ITEM_CLASS}>
              {t("backToStore")}
            </a>
          )}

          <div role="separator" className="my-1 h-px bg-[var(--separator-weak)]" />

          <SignOutButton className={MENU_ITEM_CLASS} />
        </div>
      )}
    </Popover>
  );
}
