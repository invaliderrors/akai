import { getTranslations } from "next-intl/server";
import type { Address } from "@akai/contracts";
import { createServerApiClient } from "@/lib/api/client";
import { createAccountApi } from "@/lib/account";
import { AccountOverview } from "@/components/account/account-overview";
import { AccountErrorPanel } from "@/components/account/account-error-panel";

/** Per-customer and mutable; never statically cached. */
export const dynamic = "force-dynamic";

/** How many recent orders the overview summarises before deferring to /orders. */
const RECENT_ORDER_COUNT = 4;

/**
 * The account landing page.
 *
 * (Replaces the shell's provisional placeholder, as its own comment anticipated.)
 *
 * Three independent reads, issued CONCURRENTLY. Sequential awaits would make the
 * page as slow as the sum of the three for no benefit — none of them depends on
 * another's result.
 *
 * Partial failure is tolerated by design: a customer whose address book errors
 * should still see their orders. Only the profile read is fatal, because without
 * it there is no page to render.
 *
 * NO `PageTemplate` HERE, and that is deliberate rather than an omission. Both
 * branches below render a component that brings its own: `AccountOverview`,
 * because this screen's `<h1>` IS the greeting and only it holds the customer
 * the greeting is built from, and `AccountErrorPanel`, because a server
 * component cannot call `useTranslations` to render a typed failure. Wrapping
 * here would nest one template inside the other on the error path.
 */
export default async function OverviewPage() {
  const t = await getTranslations("account.overview");
  const account = createAccountApi(await createServerApiClient());

  const [profile, orders, addresses] = await Promise.all([
    account.getProfile(),
    account.listOrders({ limit: RECENT_ORDER_COUNT }),
    account.listAddresses(),
  ]);

  if (!profile.ok) {
    return <AccountErrorPanel title={t("title")} error={profile.error} />;
  }

  // One degradation for both facts drawn from this read: an errored address
  // book is an empty one here, so the overview shows "no saved address" and a
  // count of zero rather than a second error panel over a working page.
  const addressBook: readonly Address[] = addresses.ok ? addresses.data : [];
  const defaultAddress: Address | null =
    addressBook.find((address) => address.isDefault) ?? null;

  return (
    <AccountOverview
      customer={profile.data}
      recentOrders={orders.ok ? orders.data.items : []}
      defaultAddress={defaultAddress}
      addressCount={addressBook.length}
    />
  );
}
