import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { apiBaseUrl } from "@/lib/api/client";
import { me } from "@/lib/api/auth";
import { getSession } from "@/lib/session/server";

/**
 * The admin route group's authorisation gate.
 *
 * WHY THIS EXISTS WHEN MIDDLEWARE ALREADY GATES `/admin` (route-policy.ts
 * classifies it `privileged`): middleware runs on a role cached in a sealed
 * cookie, so it is a UX gate — it decides what to render without a round trip.
 * This layout is the second, server-side assertion the architecture spec §3
 * requires, and the two fail differently. If middleware is ever misconfigured,
 * reordered, or its matcher stops covering a new path, this still refuses.
 *
 * NEITHER IS THE SECURITY BOUNDARY. That is the API's `RolesGuard`, which
 * re-reads the role from the database session row on every request (spec §8) —
 * a token minted before a demotion still says ADMIN, and only the database
 * knows the truth. Everything here could be bypassed by an attacker crafting
 * requests straight at the API, and it would change nothing. That is exactly the
 * property that makes rendering decisions from a cached role safe.
 *
 * `notFound()` rather than a 403: a 403 confirms that `/admin/orders` exists and
 * is worth attacking. A signed-in CUSTOMER poking at admin URLs learns nothing
 * from a 404 that they did not already know.
 *
 * Admin pages below this layout are SERVER components, so no admin logic and no
 * admin-only copy is shipped in the customer bundle.
 *
 * ---------------------------------------------------------------------------
 * THE ROLE IS RE-READ FROM THE API, not taken from the cookie.
 *
 * An earlier revision of this file gated on `session.role` alone. That value is
 * a cache: it is written at sign-in and CARRIED OVER unchanged by every token
 * refresh (see `rotate()` in middleware.ts, which only receives new tokens),
 * so a user demoted from STAFF an hour ago still presents `role: "STAFF"` until
 * they sign in again. `GET /auth/me` resolves the role from the database
 * session row, which is the same source the API's RolesGuard uses — so this
 * layout and the API now agree, and a demotion takes effect on the next page
 * view instead of at the next sign-in.
 *
 * The call FAILS CLOSED: a 401, a 500 or an unreachable API is a 404, never a
 * fallback to the cached role. "The check errored, so allow it" is how an API
 * outage turns into a privilege escalation.
 * ---------------------------------------------------------------------------
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getSession();

  if (session === null) {
    // Anonymous gets a sign-in prompt rather than a 404: there is nothing to
    // conceal from someone who has not identified themselves yet, and a 404
    // here would strand a legitimate admin whose session merely expired.
    redirect({ href: "/sign-in", locale: await getLocale() });

    // Unreachable — `redirect` throws. Present only because TypeScript applies
    // never-returning-call narrowing to explicitly annotated identifiers, and
    // next-intl's redirect is inferred from `createNavigation(routing)`.
    return null;
  }

  // Cheap cached-role rejection first, so a customer poking at /admin costs a
  // 404 rather than an API round trip.
  if (session.role !== "ADMIN" && session.role !== "STAFF") {
    notFound();
  }

  const current = await me({ baseUrl: apiBaseUrl() }, session.accessToken);
  if (!current.ok || current.data.role === "CUSTOMER") {
    notFound();
  }

  return (
    <DashboardShell area="admin" email={current.data.email} showAdmin>
      {children}
    </DashboardShell>
  );
}
