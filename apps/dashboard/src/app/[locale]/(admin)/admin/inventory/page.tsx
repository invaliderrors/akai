import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { inventoryFilterSchema, type InventoryFilter, type InventoryRow } from "@akai/contracts";

import { AdjustStockDialog } from "@/components/admin/adjust-stock-dialog";
import { AdminErrorState } from "@/components/admin/admin-error-state";
import { PageTemplate } from "@/components/shell/page-template";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import {
  activeCursor,
  CursorPagination,
  type PaginationLabels,
  type PaginationRange,
} from "@/components/ui/pagination";
import type { SearchParamValue } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column } from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { listInventory } from "@/lib/admin/api";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { asLocale, resolveStockState } from "@/lib/admin/inventory-display";
import { createServerApiClient } from "@/lib/api/client";

/**
 * The admin stock list.
 *
 * Same shape as the coupon and product lists: filters live in the URL so the
 * view is linkable and survives a reload, which keeps this a server component
 * with no client-side fetch, and pagination is CURSOR-based because stock rows
 * change under an operator's feet — under OFFSET a restocked variant makes a
 * row appear twice or vanish mid-scan.
 *
 * EACH ROW CARRIES AN "AJUSTAR" ACTION, AND IT IS THE PRODUCT PAGE'S DIALOG.
 * `AdjustStockDialog` is the one stock write surface in the app; it is rendered
 * here as-is (a client island inside this server component) rather than forked,
 * so there is still exactly ONE path to `/inventory/adjust`. The row already
 * carries everything the dialog needs — variantId, sku, onHand, reserved.
 *
 * AN UNTRACKED ROW IS ADJUSTABLE TOO. Its first adjustment creates the
 * `inventory_item` record server-side, so "untracked" means "no stock yet"
 * rather than "cannot be stocked"; its displayed on-hand is zero, which is also
 * the `expectedOnHand` the dialog sends, so a record someone else created in
 * the meantime is refused as STOCK_CHANGED instead of silently added to.
 *
 * The variant's POLICY (threshold, backorder) is still edited on the product
 * page only; the SKU links there.
 *
 * THE DRAWN "TODOS / ATENCIÓN" TWO-TAB FILTER IS NOT BUILT, and cannot be:
 * `inventoryFilterSchema` (libs/contracts/src/lib/inventory.ts) is a four-member
 * enum and `inventoryListQuerySchema` takes exactly ONE of them, while
 * "Atención" is the union low ∪ out ∪ untracked. A tab that sends one member and
 * claims three would under-report the very rows it exists to surface. The four
 * states the API does answer stay as they are.
 *
 * THE ATTENTION ROW RAIL IS WITHHELD HERE, and that is not an omission either.
 * The rail is spent on exactly two situations in the whole product, and the
 * stock one is zero-available ON AN ACTIVE PRODUCT — an archived product at zero
 * is nobody's problem. `inventoryRowSchema` is `.strict()` over ten fields and
 * product status is not among them (the API's own query excludes only
 * soft-deleted rows, so DRAFT and ARCHIVED products are both in this list), so
 * the gate cannot be evaluated from what the row carries. The BADGE tone is
 * unconditional and still says `attention` for an out-of-stock variant — that is
 * `lib/status`'s call, not this page's — but painting the row itself would
 * spend the loudest treatment the product has on rows that may not need anyone.
 */
export const dynamic = "force-dynamic";

/** The page size an operator gets before touching the per-page control. */
const DEFAULT_LIMIT = 50;

export default async function AdminInventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = asLocale(rawLocale);
  const t = await getTranslations("admin.inventory");
  const tUi = await getTranslations("ui");

  const pathname = "/admin/inventory";
  // The TOP of the cursor stack, not its first entry: the stack is a repeated
  // `cursor` param holding one entry per page walked, and reading the first
  // would refetch page two forever.
  const cursor = activeCursor(query["cursor"]);
  const search = single(query["search"]);
  const limit = readLimit(query["limit"]);

  // Parsed against the closed enum rather than trusted: `?filter=` is user input
  // straight off the address bar, and an unrecognised value degrades to "all"
  // instead of reaching the API as a validation failure the operator cannot read.
  const parsedFilter = inventoryFilterSchema.safeParse(single(query["filter"]));
  const filter: InventoryFilter = parsedFilter.success ? parsedFilter.data : "all";

  const http = createAdminHttp(await createServerApiClient());

  let page: Awaited<ReturnType<typeof listInventory>>;
  try {
    page = await listInventory(http, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(search === undefined ? {} : { search }),
      filter,
      locale,
      limit,
    });
  } catch (cause) {
    return (
      <PageTemplate title={t("title")} description={t("description")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  // es-ES / en-IE, the same tags `@akai/money` formats with, so a count and a
  // euro figure group their thousands the same way across one screen.
  const counts = new Intl.NumberFormat(locale === "es" ? "es-CO" : "en-US");

  /**
   * A tracked count, or the em-dash an untracked variant has instead.
   *
   * Defined inside the component so it closes over `counts` and, through it,
   * the active locale — and returned as a NODE rather than a string so the
   * dash can carry `--label-tertiary`: a row of four grey dashes reads as
   * "there is nothing to count here", where four black zeros would read as a
   * stock level of zero, which is the one thing untracked does not mean.
   */
  function figure(row: InventoryRow, value: number): ReactNode {
    return row.tracked ? (
      counts.format(value)
    ) : (
      <span className="text-[var(--label-tertiary)]">—</span>
    );
  }

  /**
   * The pagination copy, from the `ui` namespace.
   *
   * Defined here rather than at module scope for the reason the coupon list's
   * `describeWindow` is: it closes over `tUi`, and next-intl's translator type
   * cannot be restated in a hand-written parameter annotation without either
   * widening it or reaching for a banned `any`.
   *
   * `showing` branches on `hasMore` because the two sentences say different
   * things — "Mostrando 51–75" is the end of the list and "… · hay más" is not,
   * and the control cannot know which without being told.
   */
  function paginationLabels(): PaginationLabels {
    return {
      nav: tUi("pagination"),
      first: tUi("first"),
      previous: tUi("previous"),
      next: tUi("next"),
      page: (page: number) => tUi("page", { page }),
      perPage: tUi("perPage"),
      showing: ({ from, to, hasMore }: PaginationRange) =>
        hasMore ? tUi("showingMore", { from, to }) : tUi("showing", { from, to }),
    };
  }

  const fields: readonly FilterField[] = [
    {
      kind: "text",
      name: "search",
      label: t("searchLabel"),
      value: search,
      type: "search",
      placeholder: t("searchPlaceholder"),
      width: "lg",
    },
    {
      kind: "select",
      name: "filter",
      label: t("filterLabel"),
      // "all" IS the absence of a filter, so it is the bar's any-option rather
      // than a fourth token: a chip reading "Filtro: Todas" describes nothing.
      value: filter === "all" ? undefined : filter,
      anyLabel: t("filters.all"),
      options: [
        { value: "low", label: t("filters.low") },
        { value: "out", label: t("filters.out") },
        { value: "untracked", label: t("filters.untracked") },
      ],
      width: "md",
    },
  ];

  const columns: readonly Column<InventoryRow>[] = [
    {
      key: "sku",
      header: t("columns.sku"),
      kind: "identifier",
      cell: (row) => <Link href={`/admin/products/${row.productId}`}>{row.sku}</Link>,
    },
    {
      key: "product",
      header: t("columns.product"),
      // The slug is the fallback, not a blank cell: a product with no
      // translation in ANY locale is a data defect, and showing the slug makes
      // it identifiable instead of anonymous.
      cell: (row) => row.productName ?? row.productSlug,
    },
    {
      key: "state",
      header: t("columns.state"),
      cell: (row) => (
        <StatusBadge domain="stock" value={resolveStockState(row)} density="compact" />
      ),
    },
    {
      key: "onHand",
      header: t("columns.onHand"),
      kind: "numeric",
      cell: (row) => figure(row, row.onHand),
    },
    {
      key: "reserved",
      header: t("columns.reserved"),
      kind: "numeric",
      cell: (row) => figure(row, row.reserved),
    },
    {
      // AVAILABLE IS THE SELLABLE NUMBER — on-hand minus what live checkouts
      // hold — so it is the one an operator acts on and the one the state above
      // is derived from. It reads emphasised for that reason.
      key: "available",
      header: t("columns.available"),
      kind: "numeric",
      cell: (row) => (
        <span className="font-semibold text-[var(--label)]">{figure(row, row.available)}</span>
      ),
    },
    {
      key: "threshold",
      header: t("columns.threshold"),
      kind: "numeric",
      cell: (row) => figure(row, row.lowStockThreshold),
    },
    {
      key: "actions",
      header: t("columns.actions"),
      kind: "actions",
      cell: (row) => (
        <AdjustStockDialog
          variantId={row.variantId}
          sku={row.sku}
          onHand={row.onHand}
          reserved={row.reserved}
        />
      ),
    },
  ];

  const filtered = filter !== "all" || search !== undefined;

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      filters={
        <FilterBar
          label={tUi("filters")}
          fields={fields}
          pathname={pathname}
          searchParams={query}
          labels={{
            apply: t("apply"),
            clear: tUi("clear"),
            active: tUi("activeFilters"),
            remove: (name) => tUi("removeFilter", { name }),
          }}
        />
      }
    >
      <DataTable
        caption={t("title")}
        columns={columns}
        rows={page.items}
        rowKey={(row) => row.variantId}
        minWidth="wide"
        empty={
          <EmptyState
            title={filtered ? tUi("noMatchesTitle") : t("emptyTitle")}
            body={filtered ? tUi("noMatchesBody") : t("emptyBody")}
            reason={filtered ? "no-matches" : "nothing-yet"}
            density="table"
          />
        }
        footer={
          page.items.length === 0 ? null : (
            <CursorPagination
              labels={paginationLabels()}
              pathname={pathname}
              searchParams={query}
              itemCount={page.items.length}
              pageSize={limit}
              hasMore={page.hasMore}
              nextCursor={page.nextCursor}
            />
          )
        }
      />
    </PageTemplate>
  );
}

/**
 * `limit` off the address bar, clamped to what the contract accepts.
 *
 * `paginationQuerySchema` is 1..100, so anything else would come back as a 400
 * with the operator's filters lost — a URL they can no longer read. An
 * unparseable value falls back to the default instead.
 */
function readLimit(raw: SearchParamValue): number {
  const parsed = Number(single(raw));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : DEFAULT_LIMIT;
}

