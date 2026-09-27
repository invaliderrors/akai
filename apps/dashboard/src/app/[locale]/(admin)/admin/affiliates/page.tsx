import { getTranslations } from "next-intl/server";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { PageTemplate } from "@/components/shell/page-template";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { Icon } from "@/components/ui/icon";
import { AggregateMoney } from "@/components/ui/money";
import { activeCursor, CursorPagination } from "@/components/ui/pagination";
import type { SearchParamValue } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/states";
import { DataTable, type Column } from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { listAffiliates } from "@/lib/admin/api";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { asLocale } from "@/lib/admin/inventory-display";
import { DEFAULT_CURRENCY, type AdminAffiliate } from "@/lib/admin/schemas";
import { createServerApiClient } from "@/lib/api/client";

/**
 * The affiliate list. §14 of
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`.
 *
 * READ-ONLY LIKE `admin/customers`, not editable-inline like `admin/discounts`
 * — the name cell links straight to the detail route rather than opening an
 * inline panel. An affiliate has four plain fields and no usage figures that
 * need a bigger stage than the detail page already gives them, so the second
 * surface `admin/discounts` maintains for its heavier form bought nothing
 * here.
 *
 * `redemptionCount`/`revenueMinor` are the SAME derived stats the detail page
 * shows — see `AffiliateAdminService`'s own doc comment for exactly which
 * order statuses they count. Showing them in the list is what makes this
 * screen answer "who is actually selling" at a glance, without opening every
 * row.
 */
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const PATHNAME = "/admin/affiliates";
const NO_VALUE = "—";

export default async function AdminAffiliatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = asLocale(rawLocale);
  const query = await searchParams;
  const t = await getTranslations("admin.affiliates");
  const tUi = await getTranslations("ui");

  const cursor = activeCursor(query["cursor"]);
  const includeDeleted = single(query["includeDeleted"]) === "true";
  const limit = readLimit(query["limit"]);

  const http = createAdminHttp(await createServerApiClient());

  let page: Awaited<ReturnType<typeof listAffiliates>>;
  try {
    page = await listAffiliates(http, {
      ...(cursor === undefined ? {} : { cursor }),
      includeDeleted,
      limit,
    });
  } catch (cause) {
    return (
      <PageTemplate title={t("title")} description={t("description")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  const counts = new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-IE");

  const fields: readonly FilterField[] = [
    {
      kind: "checkbox",
      name: "includeDeleted",
      label: t("filterIncludeDeleted"),
      checked: includeDeleted,
    },
  ];

  const columns: readonly Column<AdminAffiliate>[] = [
    {
      key: "name",
      header: t("colName"),
      kind: "identifier",
      cell: (affiliate) => (
        <Link
          href={`${PATHNAME}/${affiliate.id}`}
          aria-label={t("viewRow", { name: affiliate.name })}
        >
          {affiliate.name}
        </Link>
      ),
    },
    {
      key: "country",
      header: t("colCountry"),
      cell: (affiliate) => affiliate.country,
    },
    {
      key: "socialHandle",
      header: t("colSocialHandle"),
      cell: (affiliate) => affiliate.socialHandle,
    },
    {
      key: "discountCodes",
      header: t("colCoupons"),
      cell: (affiliate) =>
        affiliate.discountCodes.length === 0 ? NO_VALUE : affiliate.discountCodes.join(", "),
    },
    {
      key: "redemptions",
      header: t("colRedemptions"),
      kind: "numeric",
      cell: (affiliate) => counts.format(affiliate.redemptionCount),
    },
    {
      key: "revenue",
      header: t("colRevenue"),
      kind: "numeric",
      // `AggregateMoney`, never `Money` — same reasoning the customer list's
      // `lifetimeValue` column gives for its own identical choice:
      // `revenueMinor` is an unbranded aggregate sum with no `Minor` ceiling,
      // and this column never settles anything.
      cell: (affiliate) => (
        <AggregateMoney
          amountMinor={affiliate.revenueMinor}
          currency={DEFAULT_CURRENCY}
          locale={locale}
        />
      ),
    },
    {
      key: "state",
      header: t("colState"),
      cell: (affiliate) =>
        affiliate.deletedAt === null ? (
          <Badge tone="success" density="compact" label={t("state.ACTIVE")} />
        ) : (
          <Badge tone="neutral" density="compact" label={t("state.ARCHIVED")} />
        ),
    },
  ];

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      actions={
        <Link
          href="/admin/affiliates/new"
          className={buttonClassName({ variant: "prominent", size: "compact", leadingIcon: true })}
        >
          <Icon name="plus" size={14} />
          {t("new")}
        </Link>
      }
      filters={
        <FilterBar
          label={tUi("filters")}
          fields={fields}
          pathname={PATHNAME}
          searchParams={query}
          labels={{
            apply: t("filterApply"),
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
        rowKey={(affiliate) => affiliate.id}
        minWidth="wide"
        empty={
          <EmptyState
            title={includeDeleted ? tUi("noMatchesTitle") : t("emptyTitle")}
            body={includeDeleted ? tUi("noMatchesBody") : t("emptyBody")}
            reason={includeDeleted ? "no-matches" : "nothing-yet"}
            density="table"
          />
        }
        footer={
          page.items.length === 0 ? null : (
            <CursorPagination
              labels={{
                nav: tUi("pagination"),
                first: tUi("first"),
                previous: tUi("previous"),
                next: tUi("next"),
                page: (value: number) => tUi("page", { page: value }),
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
          )
        }
      />
    </PageTemplate>
  );
}

function readLimit(raw: SearchParamValue): number {
  const parsed = Number(single(raw));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : DEFAULT_LIMIT;
}
