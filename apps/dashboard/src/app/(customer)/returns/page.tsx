import { getTranslations } from "next-intl/server";

import { isReturnOpen, type OrderSummary } from "@akai/contracts";

import { AccountErrorPanel } from "@/components/account/account-error-panel";
import { formatDate } from "@/components/account/format";
import {
  ReturnRequestForm,
  type EligibleOrder,
} from "@/components/account/return-request-form";
import { PageTemplate } from "@/components/shell/page-template";
import { Card } from "@/components/ui/card";
import { ContentRow, GroupedList } from "@/components/ui/grouped-list";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/states";
import { createAccountApi } from "@/lib/account";
import { createServerApiClient } from "@/lib/api/client";

import { requestReturnAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * How many recent orders to scan for returnable ones.
 *
 * The list endpoint is cursor-paginated with no status filter
 * (`customerOrderListQuerySchema` is pagination and nothing else), so the
 * eligible set is derived from a window of recent history rather than queried.
 * 50 covers a year of ordinary buying; a customer past that has older orders
 * outside any return window anyway.
 */
const ELIGIBLE_ORDER_LIMIT = 50;

/**
 * WHY THE 14-DAY WINDOW IS NOT APPLIED HERE.
 *
 * The policy is 14 days from DELIVERY, and `orderSummarySchema` is `.strict()`
 * with `{id, orderNumber, status, currency, grandTotal, itemCount, placedAt}` —
 * there is no delivery timestamp on the row. Filtering on `placedAt` instead
 * would be strictly WRONG in the direction that costs a customer money: an
 * order placed 20 days ago and delivered 3 days ago is returnable, and a
 * placed-at window hides it with no way to ask.
 *
 * So the picker offers exactly what the API accepts —
 * `RETURNABLE_ORDER_STATUSES = ["DELIVERED"]` in `returns.service.ts`, which
 * applies no date window at all — and the 14 days are stated as policy in the
 * form's copy. Narrowing this honestly needs `deliveredAt` on the projection.
 *
 * Orders with an OPEN return are dropped as well: the service rejects a second
 * one with 409 CONFLICT, and offering a choice that is refused a second later
 * is worse than not offering it. The list is one cursor page, so an older open
 * return can still slip through — which is why the `alreadyOpen` branch stays.
 */
function eligibleOrders(
  orders: readonly OrderSummary[],
  ordersWithOpenReturn: ReadonlySet<string>,
): readonly EligibleOrder[] {
  return orders
    .filter(
      (order) =>
        order.status === "DELIVERED" && !ordersWithOpenReturn.has(order.orderNumber),
    )
    .map((order) => ({
      orderNumber: order.orderNumber,
      placedAt: order.placedAt,
      grandTotal: order.grandTotal,
      currency: order.currency,
    }));
}

/**
 * `returnRequestSchema.returnLabelUrl` is `z.string().max(1024)` — NOT `.url()`,
 * unlike the admin write schema beside it. An operator-written string reaching
 * an `href` unchecked is a `javascript:` URL away from script execution in the
 * customer's own session, so the scheme is verified before it becomes a link.
 * Anything else renders as no link rather than as a live one.
 */
function labelHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Returns.
 *
 * WHOLE-ORDER, NOT PER-LINE — see `ReturnRequestForm` and
 * `libs/contracts/src/lib/returns.ts`. There are no return numbers and no
 * per-return amounts on this screen because `returnRequestSchema` carries
 * neither: the identifier is a uuid plus the denormalised order number, and
 * approving a return records a decision without moving money.
 *
 * Both halves are server-rendered so a customer checking on a request sees it
 * immediately, and the form posts through a server action so the bearer token
 * never reaches the browser — the same split the rest of the account area uses.
 */
export default async function ReturnsPage() {
  const t = await getTranslations("account.returns");
  const account = createAccountApi(await createServerApiClient());

  const [returns, orders] = await Promise.all([
    account.listReturns(),
    // DEGRADED INDEPENDENTLY. The history is what a customer opens this page
    // for; a transport failure fetching the pickable orders must cost them the
    // form, not the page. `ApiResult` already models an API error as a value,
    // so this catch is for a rejection — a network fault or a parse failure.
    account.listOrders({ limit: ELIGIBLE_ORDER_LIMIT }).catch(() => null),
  ]);

  if (!returns.ok) {
    return <AccountErrorPanel title={t("title")} error={returns.error} />;
  }

  const requests = returns.data.items;

  const ordersWithOpenReturn = new Set(
    requests.filter((request) => isReturnOpen(request.status)).map((r) => r.orderNumber),
  );

  const pickable =
    orders !== null && orders.ok ? eligibleOrders(orders.data.items, ordersWithOpenReturn) : [];

  return (
    <PageTemplate title={t("title")} description={t("subtitle")} width="reading">
      <ReturnRequestForm orders={pickable} onSubmit={requestReturnAction} />

      {requests.length === 0 ? (
        <Card title={t("listHeading")} titleAs="h2" titleId="returns-history-heading">
          <EmptyState title={t("emptyTitle")} body={t("emptyBody")} icon="undo-2" />
        </Card>
      ) : (
        // The test id predates this rewrite and is read from outside; it moves
        // to a wrapper because `GroupedList` owns the <ul> and takes no
        // arbitrary attributes. `within(...).getAllByRole("listitem")` is
        // unaffected.
        <div data-testid="returns-list">
          <GroupedList id="returns-history" label={t("listHeading")} headingAs="h2">
            {requests.map((request) => {
              const href = request.returnLabelUrl === null ? null : labelHref(request.returnLabelUrl);

              return (
                <ContentRow
                  key={request.id}
                  // Mono, because an order number is an identifier: it is read
                  // character by character against a printed one, which is what
                  // a fixed pitch is for. Money on this screen never is.
                  title={<span className="font-mono">{request.orderNumber}</span>}
                  // SIX statuses, not five: `APPROVED` is a real
                  // customer-visible state that REQUESTED → IN_TRANSIT routes
                  // through. `domain="return"` is what keeps its tone and label
                  // apart from an order's or a shipment's same-named members.
                  aside={<StatusBadge domain="return" value={request.status} />}
                  meta={
                    <>
                      {/* The customer's own words, at full contrast — the rest
                          of the meta line is chrome around them. */}
                      <span className="block text-[var(--label)]">{request.reason}</span>

                      <span className="block">
                        {t("requestedOn", { date: formatDate(request.requestedAt) })}
                        {request.resolvedAt === null
                          ? null
                          : ` · ${t("resolvedOn", {
                              date: formatDate(request.resolvedAt),
                            })}`}
                      </span>

                      {/* Operator-written and INTENDED for the customer, so it
                          is rendered — unlike an API error message, which is
                          English written for a log and never reaches a page. */}
                      {request.adminNote === null ? null : (
                        <span className="mt-2 block rounded-[var(--r-control)] bg-[var(--bg-grouped)] px-3 py-2">
                          <span className="block font-medium text-[var(--label)]">
                            {t("adminNote")}
                          </span>
                          {request.adminNote}
                        </span>
                      )}

                      {href === null ? null : (
                        <span className="mt-2 block">
                          <a
                            href={href}
                            // Off-site, so a plain anchor rather than `Link`,
                            // which is for in-app routes.
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-[var(--r-control)] font-medium text-[var(--accent)] no-underline hover:underline focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
                          >
                            <Icon name="file-text" size={14} />
                            {t("returnLabelAction")}
                            <span className="sr-only">{` — ${t("returnLabel")}`}</span>
                          </a>
                        </span>
                      )}
                    </>
                  }
                />
              );
            })}
          </GroupedList>
        </div>
      )}
    </PageTemplate>
  );
}
