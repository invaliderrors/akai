import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { redirect } from "@/i18n/navigation";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { apiBaseUrl } from "@/lib/api/client";
import { me } from "@/lib/api/auth";
import { getSession } from "@/lib/session/server";

/**
 * The partner route group's authorisation gate.
 *
 * SAME TWO-GATE SHAPE AS `(admin)/layout.tsx` — see that file's own doc
 * comment for the full reasoning (why both gates exist, why neither is the
 * real boundary, why the live re-check fails closed). The one structural
 * difference: this is an ALLOW-LIST at BOTH gates (`role !== "PARTNER"`),
 * not `(admin)/layout.tsx`'s deny-list-turned-allow-list — see
 * `route-policy.ts`'s own note on why the partner check was built this way
 * from the start.
 *
 * NO `DashboardShell` HERE, deliberately. That shell's `ToolbarArea` is
 * `"account" | "admin"` — built for an area with several pages and a nav
 * rail. A partner has exactly one page and one action (sign out), so this
 * file is its own minimal shell rather than a third `ToolbarArea` variant
 * built for a size of one.
 */
export default async function PartnerLayout({ children }: { readonly children: ReactNode }) {
  const session = await getSession();

  if (session === null) {
    redirect({ href: "/sign-in", locale: await getLocale() });
    return null;
  }

  // Cheap cached-role rejection first, so a customer or staff account poking
  // at /partner costs a 404 rather than an API round trip.
  if (session.role !== "PARTNER") {
    notFound();
  }

  const current = await me({ baseUrl: apiBaseUrl() }, session.accessToken);
  if (!current.ok || current.data.role !== "PARTNER") {
    notFound();
  }

  const t = await getTranslations("partner");

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg-grouped)]">
      <header className="flex items-center justify-between border-b border-[var(--separator-weak)] bg-[var(--bg-base)] px-4 py-3 sm:px-6">
        <span className="font-mono text-[13px] font-semibold tracking-wide text-[var(--label)]">
          {t("brand")}
        </span>
        <SignOutButton className="text-[13px] font-medium text-[var(--label-secondary)] hover:text-[var(--label)]" />
      </header>
      <main id="content" className="mx-auto w-full max-w-[var(--w-reading)] flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}
