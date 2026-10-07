"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/bff/client";

const responseSchema = z.object({ status: z.literal("signed-out") });

export interface SignOutButtonProps {
  /**
   * The menu-item paint, handed down by `AccountMenu`.
   *
   * The row's geometry and its accent-fill highlight belong to the menu that
   * owns it, not to this file — this button's job is the POST, and the four
   * rows either side of it must not be able to drift away from it visually.
   */
  readonly className?: string;
}

/**
 * Sign-out — now the last row of the account menu.
 *
 * ONLY THE PRESENTATION MOVED. Every property below is the same one this file
 * has always had, and each is load-bearing:
 *
 * A BUTTON POSTING JSON, NOT A LINK. A `<Link href="/api/auth/logout">` would
 * be a GET, and any page that could get a browser to load that URL — an
 * `<img>`, a prefetch, an overzealous link scanner — would sign the user out.
 * The BFF also requires the CSRF header, which `postJson` attaches and a plain
 * navigation cannot. `role="menuitem"` is the ARIA role, which changes what a
 * screen reader announces and changes NOTHING about the element: it is still a
 * `<button>`, so it still cannot be triggered by a GET.
 *
 * THE RESPONSE IS PARSED AND DELIBERATELY UNCHECKED. Navigation proceeds even
 * when the request fails, because the BFF clears the cookie unconditionally
 * (see the route handler) — the local session is gone either way, and
 * stranding the user on a page that no longer works would be worse than a
 * silent best-effort revocation.
 *
 * `replace` THEN `refresh`, IN THAT ORDER. `refresh()` discards the cached RSC
 * payload rendered for the signed-in user. Without it a back-navigation can
 * paint the previous customer's data from the client router cache, which on a
 * shared machine is a real disclosure.
 *
 * THE PENDING FLAG IS NEVER RESET. Navigation follows, so the component
 * unmounts; clearing it would be a state update on a dead tree.
 */
export function SignOutButton({ className }: SignOutButtonProps) {
  const t = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick(): Promise<void> {
    setPending(true);
    await postJson("/api/auth/logout", { allDevices: false }, responseSchema);

    router.replace("/sign-in");
    // Discards the cached RSC payload rendered for the signed-in user. Without
    // it, a back-navigation can paint the previous customer's data from the
    // client router cache — on a shared machine that is a real disclosure.
    router.refresh();
  }

  return (
    <button
      role="menuitem"
      type="button"
      onClick={() => void handleClick()}
      disabled={pending}
      {...(className === undefined ? {} : { className })}
    >
      {pending ? t("signingOut") : t("signOut")}
    </button>
  );
}
