import { getTranslations } from "next-intl/server";
import type { Locale, Product, ProductStatus } from "@akai/contracts";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { buttonClassName } from "@/components/ui/button";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { Icon } from "@/components/ui/icon";
import { Money } from "@/components/ui/money";
import { CursorPagination, activeCursor, PAGE_SIZES } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/table";
import { PageTemplate } from "@/components/shell/page-template";
import { Link } from "@/i18n/navigation";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { listProducts } from "@/lib/admin/api";

/**
 * The admin catalogue list.
 *
 * FILTERS LIVE IN THE URL rather than in component state, and that is a
 * deliberate trade rather than laziness: a filtered view is then linkable,
 * survives a reload, and works with the browser's back button. It also means the
 * page stays a server component — no client-side fetching, no loading spinner,
 * no `useEffect` race between two filter changes.
 *
 * PAGINATION IS CURSOR-BASED because the API offers nothing else. Under OFFSET,
 * a product created between two page loads makes a row appear twice or vanish
 * entirely; on a catalogue an operator is auditing, that is indistinguishable
 * from a bug in the data. The cursor STACK lives in the URL as a repeated param,
 * which is what gives the operator a way back that is not the browser's own back
 * button.
 *
 * THERE IS NO SYNC COLUMN, and there is nothing to put in one. The catalog
 * mirror is deleted: publishing a product and being able to sell it are no
 * longer coupled through a queue, so "not mirrored to the payment provider" is
 * not a state this system can be in. The artboard draws that column; the drop
 * list wins.
 *
 * THE ATTENTION ROW IS THE SECOND AND LAST SANCTIONED USE of the loudest
 * treatment the product has — a tracked product at zero available that is
 * nevertheless ACTIVE, i.e. a listing a customer can reach and cannot buy. A
 * third use has to be argued in `lib/status`, not added here.
 */

const PRODUCT_STATUSES: readonly ProductStatus[] = ["DRAFT", "ACTIVE", "ARCHIVED"];

const PATHNAME = "/admin/products";

export default async function AdminProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = asLocale(rawLocale);

  const t = await getTranslations("admin.products");
  const tStatus = await getTranslations("status");
  const tUi = await getTranslations("ui");

  const search = single(query["search"]);
  const status = asStatus(single(query["status"]));
  const includeDeleted = single(query["includeDeleted"]) === "true";
  // The TOP of the cursor stack, not its first entry: `single()` would hand back
  // the cursor for page two on every page, so the operator would walk forward
  // and the list would never change.
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
        includeDeleted,
        labels: {
          search: t("searchLabel"),
          searchPlaceholder: t("searchPlaceholder"),
          status: t("statusLabel"),
          anyStatus: t("anyStatus"),
          includeDeleted: t("includeDeleted"),
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
      includeDeleted,
      locale,
      limit,
    });
  } catch (cause) {
    return (
      // The filter bar SURVIVES the failure, which is why it is built before the
      // fetch. A 400 caused by a filter the operator typed is otherwise only
      // recoverable by hand-editing the URL — and the bar is the one control on
      // the page that can still do something useful when the list cannot load.
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
        <span className="flex items-center gap-2">
          <Link
            href={`${PATHNAME}/${product.id}`}
            aria-label={t("editProduct", { name: displayName(product, locale) })}
            className={`font-medium no-underline hover:underline ${
              state.selected ? "text-[var(--label-on-accent)]" : "text-[var(--label)]"
            }`}
          >
            {displayName(product, locale)}
          </Link>
          {product.deletedAt !== null && (
            <Badge
              tone="neutral"
              density="compact"
              label={t("deleted")}
              onAccent={state.selected}
            />
          )}
        </span>
      ),
    },
    {
      key: "slug",
      header: t("columns.slug"),
      // A slug is an identifier: compared character by character against a URL,
      // which is what the mono face is for. It is not a link — the name beside
      // it already is one, and two links per row is two tab stops for one
      // destination.
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
      key: "variants",
      header: t("columns.variants"),
      kind: "numeric",
      cell: (product) => product.variants.length,
    },
    {
      key: "price",
      header: t("columns.priceFrom"),
      kind: "numeric",
      cell: (product) => {
        const cheapest = lowestPrice(product);
        return cheapest === undefined ? (
          "—"
        ) : (
          <Money amount={cheapest.gross} currency={cheapest.currency} locale={locale} />
        );
      },
    },
    {
      key: "available",
      header: t("columns.available"),
      kind: "numeric",
      // AVAILABILITY, NOT ON-HAND: stock already inside someone else's in-flight
      // checkout is not available to sell, and an operator deciding whether to
      // restock needs the number they can actually promise a customer.
      cell: (product, state) => {
        const shortage = availability(product);
        return shortage === null ? (
          totalAvailable(product)
        ) : (
          // At zero the figure stops being a quantity and becomes a state, so it
          // is badged and named. The BADGE is unconditional — zero is zero
          // whatever the product's status — while the row RAIL below is gated on
          // ACTIVE, because an archived product at zero is nobody's problem.
          <StatusBadge
            domain="stock"
            value={shortage}
            density="compact"
            onAccent={state.selected}
          />
        );
      },
    },
  ];

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/admin/categories"
            className={buttonClassName({
              variant: "standard",
              size: "compact",
              leadingIcon: true,
            })}
          >
            <Icon name="tag" size={14} />
            {t("categories")}
          </Link>
          <Link
            href={`${PATHNAME}/reorder`}
            className={buttonClassName({
              variant: "standard",
              size: "compact",
              leadingIcon: true,
            })}
          >
            <Icon name="chevrons-up-down" size={14} />
            {t("reorder")}
          </Link>
          <Link
            href={`${PATHNAME}/new`}
            className={buttonClassName({
              variant: "prominent",
              size: "compact",
              leadingIcon: true,
            })}
          >
            <Icon name="plus" size={14} />
            {t("new")}
          </Link>
        </div>
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
        rowTone={(product) =>
          availability(product) === "out" && product.status === "ACTIVE"
            ? "attention"
            : "default"
        }
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
  readonly includeDeleted: string;
  readonly statusOption: (value: ProductStatus) => string;
}

function filterFields({
  search,
  status,
  includeDeleted,
  labels,
}: {
  readonly search: string | undefined;
  readonly status: ProductStatus | undefined;
  readonly includeDeleted: boolean;
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
    {
      kind: "checkbox",
      name: "includeDeleted",
      label: labels.includeDeleted,
      checked: includeDeleted,
    },
  ];
}

function displayName(product: Product, locale: Locale): string {
  // Falls back to the other locale rather than rendering a blank cell: a
  // product with only Spanish copy is normal mid-translation, and an empty row
  // label is unusable.
  const preferred = product.translations.find(
    (translation) => translation.locale === locale,
  );
  return preferred?.name ?? product.translations[0]?.name ?? product.slug;
}

/** The cheapest ACTIVE variant's price, or the cheapest of any if none is active. */
function lowestPrice(product: Product): Product["variants"][number]["price"] | undefined {
  const active = product.variants.filter((variant) => variant.isActive);
  const considered = active.length > 0 ? active : product.variants;

  return considered.reduce<Product["variants"][number]["price"] | undefined>(
    (lowest, variant) =>
      lowest === undefined || variant.price.gross < lowest.gross ? variant.price : lowest,
    undefined,
  );
}

function totalAvailable(product: Product): number {
  return product.variants.reduce(
    (total, variant) => total + variant.inventory.available,
    0,
  );
}

/**
 * Nothing left to sell — and whether that is a problem.
 *
 * `null` means there is stock and the cell shows a number. Otherwise the same
 * ranking `resolveStockState` uses: a variant that takes backorders is still
 * sellable at zero, so it is `backorder` rather than the attention case. It
 * takes EVERY variant to be backorder-able for that, not one: a product whose
 * 500 g size is unbuyable is a product with a problem, however its 1 kg size is
 * configured.
 */
function availability(product: Product): "out" | "backorder" | null {
  if (totalAvailable(product) > 0) {
    return null;
  }
  const backorderable =
    product.variants.length > 0 &&
    product.variants.every((variant) => variant.inventory.allowBackorder);
  return backorderable ? "backorder" : "out";
}

function asStatus(value: string | undefined): ProductStatus | undefined {
  // Narrowed by comparison rather than cast: a query string is written by
  // whoever is holding the URL, and a value the API would reject must become
  // "no filter" instead of a 400 the operator cannot act on.
  return value === "DRAFT" || value === "ACTIVE" || value === "ARCHIVED" ? value : undefined;
}

/**
 * The page size, clamped to the three the control offers.
 *
 * `paginationQuerySchema` caps `limit` at 100, so an arbitrary number in the URL
 * is a 400 with the operator's filters lost. Anything unrecognised falls back to
 * the first offered size rather than being passed through.
 */
function asLimit(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return PAGE_SIZES.includes(parsed) ? parsed : (PAGE_SIZES[0] ?? 25);
}

function asLocale(value: string): Locale {
  return value === "en" ? "en" : "es";
}

export const dynamic = "force-dynamic";
