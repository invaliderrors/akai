import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { Locale, OrderSummary } from "@akai/contracts";

import { ContentRow, GroupedList } from "@/components/ui/grouped-list";
import { Money } from "@/components/ui/money";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column } from "@/components/ui/table";
import { Link } from "@/i18n/navigation";

import { formatDate } from "./format";

/**
 * Purchase history: one page of orders, drawn twice.
 *
 * NO `"use client"`, AND THAT IS THE CHANGE. This used to be a client component
 * holding an accumulated array, an in-flight flag, a next-cursor and an injected
 * `onLoadMore` — a state machine whose entire job was to append. The cursor now
 * lives in the URL (see `ui/pagination`), so the list holds nothing: props in,
 * markup out. A customer who reloads, shares or presses back lands on the page
 * they were actually looking at, which append-on-demand could never give them,
 * and the whole thing renders on the server.
 *
 * WHY "PREVIOUS / NEXT" AND STILL NOT NUMBERED PAGES. The reason the old file
 * gave is unchanged and still binding: `paginationQuerySchema` is cursor+limit,
 * because OFFSET double-counts or skips rows when a write lands between page
 * fetches — for an order list that means an order visibly vanishing. A cursor
 * cannot address "page 4", so there is no page-number list here either. What is
 * new is that a STACK of cursors in the URL makes "previous" representable,
 * which is the one thing the old design genuinely could not do.
 *
 * TWO RENDERINGS, ONE DATA SET. Desktop gets a real `<table>` — five columns
 * read across, which is what a table is for. A 400px phone gets the same rows
 * as `ContentRow`s in a grouped card, because five columns on a phone is a
 * sideways scroll and a lost total. Exactly one of the two is displayed at any
 * width, so assistive technology is never offered both.
 */

/**
 * The kit's focus contract, restated because `table.tsx` keeps its copy private:
 * opt OUT of the layered global outline FIRST, then paint the ring.
 *
 * The two `focus-visible:outline …` declarations this file used to carry did the
 * opposite — they ADDED an outline matching the global one, so a focused order
 * number drew the ring twice at two offsets. They were also the last two in the
 * app.
 */
const FOCUS_RING =
  "rounded-[var(--r-check)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";

export interface OrderListProps {
  /** One cursor page, already fetched by the page. Fetch high, render pure. */
  readonly orders: readonly OrderSummary[];
  /**
   * Narrowed by the caller with `asLocale`, never cast: `<Money>` and
   * `formatDate` both need the union, and a raw `useLocale()` string would
   * silently format a Spanish-default store in en-US.
   */
  readonly locale: Locale;
  /**
   * The pagination bar. A SLOT, not built here: the cursor stack is a property
   * of the URL, which belongs to the page, and keeping it out of this component
   * is what lets the list stay a pure function of its rows.
   *
   * Rendered ONCE, below both renderings rather than inside the table's frame.
   * A copy in each would put every pagination link in the document twice and
   * give the page two identically-named navigation landmarks — only one is
   * displayed, but both are in the DOM.
   */
  readonly footer?: ReactNode;
  /** Rendered inside the empty state, e.g. a link to the storefront catalogue. */
  readonly emptyAction?: ReactNode;
}

export function OrderList({ orders, locale, footer, emptyAction }: OrderListProps) {
  const t = useTranslations("account.orders");

  if (orders.length === 0) {
    return (
      <div className="grid gap-4">
        {/*
         * NO TABLE FRAME HERE, unlike an admin list, which keeps its headings
         * above the empty state so the operator can see what they have none of.
         * That argument is about FILTERS: an operator has usually just narrowed
         * something. This screen has no filters — the API takes cursor and limit
         * and nothing else — so an empty list means the customer has never
         * ordered, and five column headings over a blank row is furniture
         * explaining a table that has never had anything in it.
         */}
        <EmptyState
          title={t("emptyTitle")}
          body={t("emptyBody")}
          icon="package"
          {...(emptyAction === undefined ? {} : { action: emptyAction })}
        />
        {/*
         * The footer still renders. An empty page is reachable at a non-zero
         * cursor depth (an order cancelled out from under a shared link), and
         * "previous" is then the only way back.
         */}
        {footer}
      </div>
    );
  }

  const columns: readonly Column<OrderSummary>[] = [
    {
      key: "orderNumber",
      header: t("colOrder"),
      // `identifier` is what puts the number on the mono face: an order number
      // is compared character by character against a printed one.
      kind: "identifier",
      cell: (order) => (
        <Link
          href={`/orders/${order.orderNumber}`}
          // The visible text is the bare number, which on its own reads as
          // "NX dash 2026 dash…" in a list of links with no verb. The label
          // says what following it does.
          aria-label={t("viewDetail", { orderNumber: order.orderNumber })}
          className={FOCUS_RING}
        >
          {order.orderNumber}
        </Link>
      ),
    },
    {
      key: "placedAt",
      header: t("colDate"),
      cell: (order) => <time dateTime={order.placedAt}>{formatDate(order.placedAt, locale)}</time>,
    },
    {
      key: "status",
      header: t("colStatus"),
      // `domain="order"` is required and load-bearing: DELIVERED, PENDING,
      // CANCELLED and FAILED all name something else in the shipment, payment
      // and email vocabularies.
      cell: (order) => <StatusBadge domain="order" value={order.status} density="compact" />,
    },
    {
      key: "itemCount",
      header: t("colItems"),
      cell: (order) => t("itemCount", { count: order.itemCount }),
    },
    {
      key: "grandTotal",
      header: t("colTotal"),
      kind: "numeric",
      cell: (order) => (
        <Money amount={order.grandTotal} currency={order.currency} locale={locale} emphasis />
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      {/*
       * `hidden sm:block` / `sm:hidden`, at the breakpoint `--gutter` already
       * steps at. Both renderings are in the DOM; `display: none` takes the
       * inactive one out of the accessibility tree, so a screen reader is
       * offered the table or the list, never both.
       */}
      <div className="hidden sm:block">
        <DataTable
          caption={t("title")}
          columns={columns}
          rows={orders}
          rowKey={(order) => order.id}
          // `narrow`, not the default `regular`: this is five columns, not the
          // admin table's nine, and the invoice action column the artboard
          // draws is dropped (apps/api/src/modules/invoices is an empty module).
          // 760px would scroll sideways on a 640px tablet for no reason.
          minWidth="narrow"
          // NO `rowTone`. `attention` is rationed to the two cases an OPERATOR
          // must rule on now, and PAYMENT_MISMATCH is one of them — but not
          // here: the customer cannot resolve it, and a red rail down their own
          // order history is an alarm with no action behind it. The status badge
          // already carries the tone.
        />
      </div>

      <div className="sm:hidden">
        {/*
         * No `label`: the page's own `<h1>` is directly above this card, and a
         * section header would repeat it. Deliberately an unnamed list rather
         * than one named by an invented string.
         */}
        <GroupedList id="orders-list">
          {orders.map((order) => (
            <ContentRow
              key={order.id}
              href={`/orders/${order.orderNumber}`}
              title={<span className="font-mono">{order.orderNumber}</span>}
              meta={`${formatDate(order.placedAt, locale)} · ${t("itemCount", {
                count: order.itemCount,
              })}`}
              aside={<StatusBadge domain="order" value={order.status} density="compact" />}
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
        </GroupedList>
      </div>

      {footer}
    </div>
  );
}
