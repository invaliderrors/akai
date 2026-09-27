import { useLocale, useTranslations } from "next-intl";
import type { Address, Customer, OrderSummary } from "@akai/contracts";

import { PageTemplate } from "@/components/shell/page-template";
import { Card, SectionHeader } from "@/components/ui/card";
import { ContentRow, DisclosureRow, GroupedList } from "@/components/ui/grouped-list";
import { Money } from "@/components/ui/money";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";

import { asLocale, formatDate, fullName } from "./format";
import { AddressBlock } from "./order-detail";
import { UnverifiedEmailNotice } from "./unverified-email-notice";

/**
 * The account landing page.
 *
 * A summary, not a second orders page: the three or four most recent orders,
 * the default address, and a route to everything else. Duplicating the full
 * history here would mean two components to keep in step and two places to fix
 * a pagination bug.
 *
 * IT OWNS ITS OWN `PageTemplate`, and the page does not wrap it. The `<h1>` of
 * this screen IS the greeting, and the greeting is derived from the customer
 * this component holds — hoisting the template to the page would move the
 * name-fallback rule away from the only place that can state it. The failure
 * path is symmetric: `AccountErrorPanel` brings its own template, so exactly
 * one renders whichever branch the page takes.
 *
 * NO `"use client"`. `next-intl` ships a `react-server` condition, so
 * `useTranslations` and `useLocale` resolve to the RSC implementations here and
 * to the context hooks when a test pulls this module into a client bundle.
 * The one genuinely interactive piece — the resend control — lives behind its
 * own boundary in `unverified-email-notice.tsx`.
 */

export interface AccountOverviewProps {
  readonly customer: Customer;
  /** Newest first, already truncated by the caller. */
  readonly recentOrders: readonly OrderSummary[];
  readonly defaultAddress: Address | null;
  /**
   * Size of the whole address book, not of the row above it.
   *
   * It reads 0 when the address read FAILED as well as when the book is
   * genuinely empty — the same degradation `defaultAddress: null` already
   * makes, and the page's documented partial-failure policy. A count is not
   * worth a second failure mode on a summary screen.
   */
  readonly addressCount: number;
}

export function AccountOverview({
  customer,
  recentOrders,
  defaultAddress,
  addressCount,
}: AccountOverviewProps) {
  const t = useTranslations("account.overview");
  const locale = asLocale(useLocale());

  const name = fullName(customer.firstName, customer.lastName);
  const twoStep = customer.twoFactorEnabled;

  return (
    <PageTemplate
      // A customer who never filled in a name gets a plain greeting rather than
      // "Hola, null" or an awkward fallback to their email address.
      title={name === null ? t("greetingFallback") : t("greeting", { name })}
      description={t("subtitle")}
      width="reading"
    >
      {/* 20px between groups, as drawn — one step looser than the template's
          own 16px region gap, because these are separate subjects rather than
          the four parts of one page. */}
      <div className="grid gap-5">
        {customer.emailVerifiedAt === null ? (
          <UnverifiedEmailNotice email={customer.email} />
        ) : null}

        <section aria-labelledby="recent-orders-heading">
          <SectionHeader id="recent-orders-heading" title={t("recentOrders")} />

          {recentOrders.length === 0 ? (
            // `flush` so the state sits edge-to-edge on the card the grouped
            // list would otherwise occupy; `package` rather than the default
            // `inbox` because this is specifically an orders list.
            <Card flush>
              <EmptyState
                icon="package"
                title={t("noOrdersTitle")}
                body={t("noOrdersBody")}
              />
            </Card>
          ) : (
            <GroupedList id="recent-orders" labelledBy="recent-orders-heading">
              {recentOrders.map((order) => (
                <ContentRow
                  key={order.id}
                  href={`/orders/${order.orderNumber}`}
                  // Mono for the identifier only. The whole ROW is the link, so
                  // its accessible name is its content — "AK-2026-000123, 02
                  // mar 2026, Entregado, 120,98 €" — which says strictly more
                  // than the "Ver el pedido X" aria-label this replaces, and
                  // says it without a second copy of the order number.
                  title={<span className="font-mono">{order.orderNumber}</span>}
                  meta={
                    <time dateTime={order.placedAt}>{formatDate(order.placedAt, locale)}</time>
                  }
                  aside={<StatusBadge domain="order" value={order.status} />}
                  trailing={
                    <Money
                      amount={order.grandTotal}
                      currency={order.currency}
                      locale={locale}
                      emphasis
                    />
                  }
                />
              ))}

              {/* The route to the full history is the LAST ROW of the list, as
                  drawn — which is also what makes its suppression structural:
                  no orders, no list, no dangling "view all" pointing at an
                  empty page. No chevron, because it closes the group rather
                  than opening a record. */}
              <DisclosureRow href="/orders" label={t("viewAllOrders")} chevron={false} />
            </GroupedList>
          )}
        </section>

        <section aria-labelledby="default-address-heading">
          <SectionHeader id="default-address-heading" title={t("defaultAddress")} />
          <Card>
            {defaultAddress === null ? (
              <p className="m-0 text-[15px] leading-5 text-[var(--label-secondary)]">
                {t("noDefaultAddress")}
              </p>
            ) : (
              <AddressBlock address={defaultAddress} />
            )}
          </Card>
        </section>

        {/* A landmark, not just a list of links: it is how a screen-reader user
            reaches the rest of the account without walking the whole page. The
            visible header says "Tu cuenta"; the landmark keeps the screen's own
            name, which is what the tab bar and the side nav also call it. */}
        <nav aria-label={t("title")}>
          <GroupedList id="account-links" label={t("accountSection")}>
            <DisclosureRow href="/profile" label={t("manageProfile")} icon="user" />
            <DisclosureRow
              href="/addresses"
              label={t("manageAddresses")}
              icon="map-pin"
              value={t("addressCount", { count: addressCount })}
            />
            {/* Accent, not the drawn warning tile. The artboard tints this one
                amber because it was drawn with a return in progress, and no
                count is available here — a standing amber tile would raise an
                alarm about an account that has never returned anything. */}
            <DisclosureRow href="/returns" label={t("manageReturns")} icon="undo-2" />
            <DisclosureRow
              href="/security"
              label={t("manageSecurity")}
              icon="shield"
              // Green states a fact; the OFF case is neutral rather than
              // warning, because two-step is not enrolled by default and there
              // is no enrolment route to send them to yet.
              iconTone={twoStep ? "success" : "neutral"}
              value={twoStep ? t("securityTwoStepOn") : t("securityTwoStepOff")}
            />
          </GroupedList>
        </nav>
      </div>
    </PageTemplate>
  );
}
