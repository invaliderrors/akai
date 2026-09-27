"use client";

import { useTranslations } from "next-intl";

import { Icon } from "@/components/ui/icon";
import { useRouter } from "@/i18n/navigation";

import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_HIDDEN,
  SIDEBAR_SHOWN,
} from "./sidebar-cookie";

export interface SidebarToggleProps {
  /** The state the shell rendered, read from the cookie on the server. */
  readonly hidden: boolean;
}

/**
 * Hide and show the source list.
 *
 * WHY A COOKIE AND NOT REACT STATE. The shell is a server component and the
 * sidebar is server-rendered markup, so the preference has to be readable
 * BEFORE the first byte or a collapsed sidebar flashes open on every
 * navigation. A cookie is the only client-owned value a server render can see,
 * which is why this is the one preference in the app that is not in the URL.
 *
 * WHY THE WRITE IS HERE AND NOT IN A SERVER ACTION. Nothing on the server needs
 * to validate a layout preference, and an action would add a round trip and a
 * generated endpoint to a control whose entire job is to re-render markup the
 * server already knows how to produce. `router.refresh()` re-fetches the RSC
 * payload for the current route, and the browser sends the cookie we just set
 * with that request, so the sidebar appears or disappears without a navigation.
 *
 * `"use client"` is confined to this button — `document.cookie` and the router
 * are both browser APIs — so the toolbar around it stays a server component.
 */
export function SidebarToggle({ hidden }: SidebarToggleProps) {
  const t = useTranslations("common");
  const router = useRouter();

  function toggle(): void {
    const next = hidden ? SIDEBAR_SHOWN : SIDEBAR_HIDDEN;
    // `Secure` only over TLS: set unconditionally, the cookie is silently
    // dropped on a plain-http dev origin and the toggle does nothing at all.
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${next}; Path=/; Max-Age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      // The LABEL carries the state, so it names the action the press performs
      // rather than describing the control. `aria-pressed` on top of a label
      // that already flips would announce the same fact twice, in opposite
      // directions on some screen readers.
      aria-label={hidden ? t("showSidebar") : t("hideSidebar")}
      className="inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[var(--r-control)] text-[var(--label-secondary)] hover:bg-[var(--fill-tertiary)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
    >
      <Icon name="panel-left" size={17} />
    </button>
  );
}
