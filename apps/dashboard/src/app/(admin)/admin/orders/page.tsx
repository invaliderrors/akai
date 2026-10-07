import { getTranslations } from "next-intl/server";
import type { AdminOrderSummary, OrderStatus } from "@akai/contracts";
import { orderStatusSchema } from "@akai/contracts";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { buttonClassName } from "@/components/ui/button";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { Money } from "@/components/ui/money";
import { activeCursor, cursorStack, CursorPagination, PAGE_SIZES } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column } from "@/components/ui/table";
import { formatDateTime } from "@/components/account/format";
import { PageTemplate } from "@/components/shell/page-template";
import Link from "next/link";
import { listOrders } from "@/lib/admin/api";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { createServerApiClient } from "@/lib/api/client";
import { SHIPPING_FILTERS, asShippingFilter } from "@/lib/admin/shipment-display";

/**
 * The operator order list.
 *
 * FILTERS LIVE IN THE URL AND THAT IS WHAT KEEPS THIS A SERVER COMPONENT.
 * `FilterBar` is one GET form with no `action` (it submits to this page), the cursor is a repeated param read off the same object,
 * and nothing on this page holds state. A filtered view is therefore linkable,
 * survives a reload, and steps back correctly — and no page of orders is ever
 * shipped to the browser as JSON.
 *
 * FOUR FILTERS, BECAUSE THE API SERVES FOUR. `adminOrderSummarySchema` is
 * `.strict()` — id, orderNumber, status, currency, grandTotal, itemCount,
 * placedAt and the newest `shipment` (which backs the `shipping` filter and the
 * Envío column) — so the artboard's Cliente (email)
 * column, its separate Pago column, its Desde/Hasta range and its CSV export
 * are all drawn against data that does not arrive here.
 *
 * NO ROW SELECTION: shipping is recorded per order, by hand, on the detail
 * page — there is no bulk label action any more. Email stays as a FILTER, which
 * it genuinely is server-side: support conversations start from an address far
 * more often than from an order number, and forcing staff through a UUID is
 * what drives people to query the database by hand.
 *
 * CURSOR PAGINATION, NEVER OFFSET. An order created between two page loads
 * shifts every offset by one, so a row appears twice and another is skipped.
 * The cursor stack in the URL is the page history; `activeCursor` reads its
 * TOP, which is the cursor this page must be fetched with.
 */
export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

  const t = await getTranslations("admin.orders");
  const tUi = await getTranslations("ui");
  const tStatus = await getTranslations("status.order");
  const tFulfilment = await getTranslations("admin.fulfilment");

  const status = asOrderStatus(single(query["status"]));
  const email = single(query["email"]);
  const orderNumber = single(query["orderNumber"]);
  const shipping = asShippingFilter(single(query["shipping"]));
  const cursor = activeCursor(query["cursor"]);
  const limit = asPageSize(single(query["limit"]));

  let page: Awaited<ReturnType<typeof listOrders>>;
  try {
    const http = createAdminHttp(await createServerApiClient());
    page = await listOrders(http, {
      // Spread conditionally rather than passing `undefined`:
      // `exactOptionalPropertyTypes` makes an explicit `undefined` a type error
      // on an optional property, and the query builder treats absent as absent.
      ...(status === undefined ? {} : { status }),
      ...(email === undefined ? {} : { email }),
      ...(orderNumber === undefined ? {} : { orderNumber }),
      ...(shipping === undefined ? {} : { shipping }),
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
  } catch (cause) {
    return (
      <PageTemplate title={t("title")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  const fields: readonly FilterField[] = [
    {
      kind: "text",
      name: "orderNumber",
      label: t("orderNumberLabel"),
      value: orderNumber,
      placeholder: t("orderNumberPlaceholder"),
      // An order number is compared character by character against something a
      // customer read out or pasted, so it takes the mono face. Money never does.
      mono: true,
      width: "lg",
    },
    {
      kind: "text",
      name: "email",
      label: t("emailLabel"),
      value: email,
      placeholder: t("emailPlaceholder"),
      width: "lg",
    },
    {
      kind: "select",
      name: "status",
      label: t("statusLabel"),
      value: status,
      anyLabel: t("anyStatus"),
      // Straight off the CONTRACT's enum rather than a hand-listed union, so a
      // status added to the platform appears here automatically instead of
      // being silently unfilterable.
      options: orderStatusSchema.options.map((option) => ({
        value: option,
        label: tStatus(option),
      })),
      width: "lg",
    },
    {
      // "Sin enviar" is the packing to-do list; "Incidencia" is the one for a
      // human (a returned or lost parcel).
      kind: "select",
      name: "shipping",
      label: tFulfilment("shippingLabel"),
      value: shipping,
      anyLabel: tFulfilment("anyShipping"),
      options: SHIPPING_FILTERS.map((option) => ({
        value: option,
        label: tFulfilment(`shippingFilter.${option}`),
      })),
      width: "lg",
    },
  ];

  const columns: readonly Column<AdminOrderSummary>[] = [
    {
      key: "order",
      header: t("columns.order"),
      kind: "identifier",
      cell: (order) => (
        <Link href={`/admin/orders/${order.orderNumber}`}>{order.orderNumber}</Link>
      ),
    },
    {
      key: "status",
      header: t("columns.status"),
      // `domain="order"` is required by the badge and is the whole point of it:
      // PENDING, CANCELLED, FAILED and DELIVERED all exist in more than one
      // vocabulary and do not mean the same thing. Nothing here renders a raw
      // enum — PAYMENT_MISMATCH reads as "Importe no coincide", not as itself.
      cell: (order) => <StatusBadge domain="order" value={order.status} density="compact" />,
    },
    {
      key: "shipping",
      header: tFulfilment("shippingColumn"),
      // The NEWEST parcel only — the detail page has the history.
      cell: (order) =>
        order.shipment === null ? (
          <span className="text-[var(--label-secondary)]" aria-label={tFulfilment("shippingFilter.NOT_SHIPPED")}>
            —
          </span>
        ) : (
          <StatusBadge domain="shipment" value={order.shipment.status} density="compact" />
        ),
    },
    {
      key: "items",
      header: t("columns.items"),
      kind: "numeric",
      cell: (order) => order.itemCount,
    },
    {
      key: "placed",
      header: t("columns.placed"),
      cell: (order) => (
        <time dateTime={order.placedAt} className="text-[var(--label-secondary)] tabular-nums">
          {formatDateTime(order.placedAt)}
        </time>
      ),
    },
    {
      key: "total",
      header: t("columns.total"),
      kind: "numeric",
      cell: (order) => (
        <Money
          amount={order.grandTotal}
          currency={order.currency}
          emphasis={order.status === "PAYMENT_MISMATCH"}
        />
      ),
    },
    {
      key: "actions",
      header: tUi("actions"),
      kind: "actions",
      /*
       * The red "Revisar" is the row action for the ONE state that needs a
       * human now. Every other row gets the quiet "Ver", which is the same
       * destination — the difference is the claim the row is making about
       * whose turn it is.
       */
      cell: (order) =>
        order.status === "PAYMENT_MISMATCH" ? (
          <Link
            href={`/admin/orders/${order.orderNumber}`}
            aria-label={t("reviewOrder", { orderNumber: order.orderNumber })}
            className={buttonClassName({ variant: "destructive" })}
          >
            {t("review")}
          </Link>
        ) : (
          <Link
            href={`/admin/orders/${order.orderNumber}`}
            aria-label={t("viewOrder", { orderNumber: order.orderNumber })}
            className={buttonClassName({ variant: "plain" })}
          >
            {tUi("view")}
          </Link>
        ),
    },
  ];

  // The footer is chrome for a result set: on a first, empty page there is no
  // position to report and no page to step to, so it would be a row of dead
  // controls under a "nothing matches" message.
  const showPagination = page.items.length > 0 || cursorStack(query["cursor"]).length > 0;

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      filters={
        <FilterBar
          label={t("filters")}
          fields={fields}
          pathname="/admin/orders"
          searchParams={query}
          labels={{
            apply: tUi("apply"),
            clear: tUi("clear"),
            active: tUi("activeFilters"),
            remove: (filter) => tUi("removeFilter", { name: filter }),
          }}
        />
      }
    >
      <DataTable
        caption={t("tableLabel")}
        columns={columns}
        rows={page.items}
        rowKey={(order) => order.id}
        /*
         * ONE OF EXACTLY TWO SANCTIONED USES of the attention treatment in the
         * whole product (the other is zero-available stock on an ACTIVE
         * product). A PAYMENT_MISMATCH order means the provider settled an
         * amount that is not ours: money may already have moved, the state
         * machine refuses to take it to PAID from any automated path, and only
         * a person can decide. It renders as an ordinary row today, which is
         * the defect this fixes. A third use dilutes all three.
         */
        rowTone={(order) => (order.status === "PAYMENT_MISMATCH" ? "attention" : "default")}
        minWidth="wide"
        empty={
          <EmptyState
            density="table"
            reason="no-matches"
            icon="package"
            title={t("emptyTitle")}
            body={t("emptyBody")}
          />
        }
        footer={
          showPagination ? (
            <CursorPagination
              labels={{
                nav: tUi("pagination"),
                first: tUi("first"),
                previous: tUi("previous"),
                next: tUi("next"),
                page: (value) => tUi("page", { page: value }),
                perPage: tUi("perPage"),
                showing: (range) =>
                  range.hasMore
                    ? tUi("showingMore", { from: range.from, to: range.to })
                    : tUi("showing", { from: range.from, to: range.to }),
              }}
              pathname="/admin/orders"
              searchParams={query}
              itemCount={page.items.length}
              pageSize={limit}
              hasMore={page.hasMore}
              nextCursor={page.nextCursor}
            />
          ) : null
        }
      />
    </PageTemplate>
  );
}

/**
 * Narrowed through the contract's own enum with `safeParse`, never cast: the
 * value comes from a URL a stranger can write. An unrecognised status is
 * dropped rather than forwarded, so the list falls back to "all" instead of
 * sending the API a 400 and losing the operator's other filters with it.
 */
function asOrderStatus(value: string | undefined): OrderStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = orderStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The page size, narrowed to one of the three the control offers.
 *
 * `PAGE_SIZES` is fixed because `paginationQuerySchema` clamps `limit` to
 * 1..100; a hand-edited `?limit=500` is a 400 from the API rather than a bigger
 * page, so it degrades to the default here instead.
 */
function asPageSize(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return PAGE_SIZES.find((size) => size === parsed) ?? 25;
}

export const dynamic = "force-dynamic";
