import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { getSession } from "@/lib/session/server";
import { isPrivileged } from "@akai/session";

/**
 * The signed-in customer area.
 *
 * Middleware has already redirected anonymous visitors, so the null check here
 * is a SECOND line rather than the only one. It stays because middleware can be
 * bypassed by configuration (a matcher edit, a route moved outside the matched
 * set) and the failure mode of trusting it alone is rendering someone's order
 * history with no session at all. Defence in depth costs one branch.
 *
 * A PARTNER SESSION IS REDIRECTED TO /partner, not rendered here. Every route
 * `route-policy.ts` classifies as `"authenticated"` (this whole group —
 * overview, orders, addresses, profile, security, returns) admits ANY signed-in
 * role by design, so middleware itself never stops a partner from reaching
 * `/`. But orders/addresses/returns are meaningless for an account that never
 * shops, and rendering them anyway is exactly the bug this fixes: a partner
 * who signs in through the plain /sign-in form (no `?next=/partner`, e.g. from
 * a bookmark or the bare app.akai.shop entry point) landed on an empty
 * "Hello, Mike / No orders yet" customer overview instead of their own stats
 * page — the ONE page this feature promises them. Catching it HERE, in the
 * layout every one of those routes shares, closes it regardless of which
 * specific customer-area URL a partner's browser happens to land on.
 */
export default async function CustomerLayout({ children }: { readonly children: ReactNode }) {
  const session = await getSession();

  if (session === null) {
    redirect("/sign-in");
  }

  if (session.role === "PARTNER") {
    redirect("/partner");
  }

  return (
    <DashboardShell area="account" email={session.email} showAdmin={isPrivileged(session)}>
      {children}
    </DashboardShell>
  );
}
