import { getTranslations } from "next-intl/server";
import type { Product, ProductStatus } from "@akai/contracts";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { buttonClassName } from "@/components/ui/button";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { Icon } from "@/components/ui/icon";
import { Money } from "@/components/ui/money";
import { CursorPagination, activeCursor, PAGE_SIZES } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column } from "@/components/ui/table";
import { PageTemplate } from "@/components/shell/page-template";
import Link from "next/link";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { listProducts } from "@/lib/admin/api";

/**
 * The dedicated packs list — the "page to see available bundles" the client
 * asked for.
 *
 * A FILTERED VIEW OF THE SAME LIST, not a parallel data model: a pack is an
 * ordinary `Product` row with `kind: "PACK"` (see `ProductPackComponent`'s
 * schema comment for why), so this page calls the exact same `listProducts`
 * the catalogue list does, with `kind: "PACK"` pinned rather than left to the
 * operator — the one thing this list is FOR is never showing anything else.
 *
 * "New pack" LINKS TO THE EXISTING `/admin/products/new` PAGE — `?kind=PACK`
 * pre-selects the kind selector there, but the form itself, its validation and
 * its submit are all the one the catalogue already has. Same for each row's
 * edit link, at the existing `/admin/products/[id]`. There is no parallel
 * create/edit screen for packs, on purpose: see plan section 4.
 */

const PRODUCT_STATUSES: readonly ProductStatus[] = ["DRAFT", "ACTIVE", "ARCHIVED"];

const PATHNAME = "/admin/products/packs";

export default async function AdminPacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

  const t = await getTranslations("admin.productPacks");
  const tProducts = await getTranslations("admin.products");
  const tStatus = await getTranslations("status");
  const tUi = await getTranslations("ui");

  const search = single(query["search"]);
  const status = asStatus(single(query["status"]));
  // The TOP of the cursor stack, not its first entry — same reasoning as the
  // catalogue list's own comment on this exact line.
  const cursor = activeCursor(query["cursor"]);
  const limit = asLimit(single(query["limit"]));

  const filters = (
    <FilterBar
      label={t("filters")}
      pathname={PATHNAME}
      searchParams={query}
      fields={filterFields({
        search,
        status,
        labels: {
          search: t("searchLabel"),
          searchPlaceholder: t("searchPlaceholder"),
          status: t("statusLabel"),
          anyStatus: t("anyStatus"),
          statusOption: (value) => tStatus(`product.${value}`),
        },
      })}
      labels={{
        apply: tUi("apply"),
        clear: tUi("clear"),
        active: tUi("activeFilters"),
        remove: (name) => tUi("removeFilter", { name }),
      }}
    />
  );

  let page: Awaited<ReturnType<typeof listProducts>>;
  try {
    const http = createAdminHttp(await createServerApiClient());
    page = await listProducts(http, {
      ...(search === undefined ? {} : { search }),
      ...(status === undefined ? {} : { status }),
      ...(cursor === undefined ? {} : { cursor }),
      kind: "PACK",
      limit,
    });
  } catch (cause) {
    return (
      <PageTemplate
        title={t("title")}
        description={t("description")}
        width="admin"
        filters={filters}
      >
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  const columns: readonly Column<Product>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (product, state) => (
        <Link
          href={`/admin/products/${product.id}`}
          aria-label={t("editPack", { name: product.name })}
          className={`font-medium no-underline hover:underline ${
            state.selected ? "text-[var(--label-on-accent)]" : "text-[var(--label)]"
          }`}
        >
          {product.name}
        </Link>
      ),
    },
    {
      key: "slug",
      header: t("columns.slug"),
      kind: "identifier",
      cell: (product) => product.slug,
    },
    {
      key: "status",
      header: t("columns.status"),
      cell: (product, state) => (
        <StatusBadge
          domain="product"
          value={product.status}
          density="compact"
          onAccent={state.selected}
        />
      ),
    },
    {
      key: "components",
      header: t("columns.components"),
      kind: "numeric",
      cell: (product) => product.packComponents.length,
    },
    {
      key: "price",
      header: t("columns.price"),
      kind: "numeric",
      // A pack has exactly one variant — its own flat price — so there is no
      // "from" range to compute the way the catalogue list's cheapest-variant
      // column has to.
      cell: (product) => {
        const own = product.variants[0];
        return own === undefined ? (
          "—"
        ) : (
          <Money amount={own.price.gross} currency={own.price.currency} />
        );
      },
    },
  ];

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      breadcrumb={{
        label: tProducts("title"),
        links: [{ label: tProducts("title"), href: "/admin/products" }],
      }}
      actions={
        <Link
          href="/admin/products/new?kind=PACK"
          className={buttonClassName({
            variant: "prominent",
            size: "compact",
            leadingIcon: true,
          })}
        >
          <Icon name="plus" size={14} />
          {t("new")}
        </Link>
      }
      filters={filters}
      pagination={
        <CursorPagination
          labels={{
            nav: tUi("pagination"),
            first: tUi("first"),
            previous: tUi("previous"),
            next: tUi("next"),
            page: (value) => tUi("page", { page: value }),
            perPage: tUi("perPage"),
            showing: ({ from, to, hasMore }) =>
              hasMore ? tUi("showingMore", { from, to }) : tUi("showing", { from, to }),
          }}
          pathname={PATHNAME}
          searchParams={query}
          itemCount={page.items.length}
          pageSize={limit}
          hasMore={page.hasMore}
          nextCursor={page.nextCursor}
        />
      }
    >
      <DataTable
        caption={t("tableLabel")}
        columns={columns}
        rows={page.items}
        rowKey={(product) => product.id}
        minWidth="regular"
        empty={
          <EmptyState
            density="table"
            reason={search === undefined && status === undefined ? "nothing-yet" : "no-matches"}
            title={t("emptyTitle")}
            body={
              search === undefined && status === undefined
                ? t("emptyFirstBody")
                : t("emptyFilteredBody")
            }
          />
        }
      />
    </PageTemplate>
  );
}

interface FilterLabels {
  readonly search: string;
  readonly searchPlaceholder: string;
  readonly status: string;
  readonly anyStatus: string;
  readonly statusOption: (value: ProductStatus) => string;
}

function filterFields({
  search,
  status,
  labels,
}: {
  readonly search: string | undefined;
  readonly status: ProductStatus | undefined;
  readonly labels: FilterLabels;
}): readonly FilterField[] {
  return [
    {
      kind: "text",
      name: "search",
      label: labels.search,
      value: search,
      type: "search",
      placeholder: labels.searchPlaceholder,
      width: "lg",
    },
    {
      kind: "select",
      name: "status",
      label: labels.status,
      value: status,
      anyLabel: labels.anyStatus,
      options: PRODUCT_STATUSES.map((value) => ({
        value,
        label: labels.statusOption(value),
      })),
    },
  ];
}

function asStatus(value: string | undefined): ProductStatus | undefined {
  return value === "DRAFT" || value === "ACTIVE" || value === "ARCHIVED" ? value : undefined;
}

function asLimit(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return PAGE_SIZES.includes(parsed) ? parsed : (PAGE_SIZES[0] ?? 25);
}

export const dynamic = "force-dynamic";
