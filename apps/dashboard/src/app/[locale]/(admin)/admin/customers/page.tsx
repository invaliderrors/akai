import { getTranslations } from "next-intl/server";
import { roleSchema, type AdminCustomer, type Locale, type Role } from "@akai/contracts";

import { Link } from "@/i18n/navigation";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { listCustomers } from "@/lib/admin/api";
import { DEFAULT_CURRENCY } from "@/lib/admin/schemas";
import { asLocale, formatDate, fullName } from "@/components/account/format";
import { AdminErrorState } from "@/components/admin/admin-error-state";
import { PageTemplate } from "@/components/shell/page-template";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { AggregateMoney } from "@/components/ui/money";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { activeCursor, CursorPagination, PAGE_SIZES } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { DataTable, type Column } from "@/components/ui/table";

/**
 * The customer list. READ-ONLY, and deliberately so: there is no endpoint that
 * mutates a customer from here, so there is no row action, no bulk selection
 * and no "impersonate". The way to act on an account is the account itself.
 *
 * THE `anonymised` FILTER IS THE INTERESTING ONE. A customer who exercised
 * GDPR Art. 17 erasure is anonymised IN PLACE rather than deleted — their
 * orders still have to exist for tax and accounting — so they remain a row here
 * with their identifying fields stripped, carrying an Erased badge. Surfacing
 * that as a visible state stops an operator concluding the erasure silently
 * failed, and keeping the row is what keeps the order history reachable.
 *
 * FILTERS LIVE IN THE URL and pagination is a CURSOR STACK, which is what keeps
 * this file a server component: there is no client state to hydrate, the view
 * is linkable and reload-proof, and the back button lands where the operator
 * expects. Under OFFSET a customer registering between two page loads would
 * make a row appear twice or vanish; the API offers cursors for that reason and
 * nothing else.
 */

const PATHNAME = "/admin/customers";

/** Typographic placeholder for a field the API has nothing in. Not prose. */
const NO_VALUE = "—";

export default async function AdminCustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = asLocale(rawLocale);
  const t = await getTranslations("admin.customers");
  const tUi = await getTranslations("ui");
  const tStatus = await getTranslations("status.role");

  const email = single(query["email"]);
  const role = asRole(single(query["role"]));
  const anonymised = asBooleanFilter(single(query["anonymised"]));
  // `activeCursor`, NOT `single`: the stack is a repeated `cursor` param and
  // the page in view is fetched with its TOP entry. Reading the first one — as
  // every admin list did before the cursor stack landed — pins the operator to
  // page two, where "next" changes the URL and never the rows.
  const cursor = activeCursor(query["cursor"]);
  const limit = asPageSize(single(query["limit"]));

  let page: Awaited<ReturnType<typeof listCustomers>>;
  try {
    const http = createAdminHttp(await createServerApiClient());
    page = await listCustomers(http, {
      ...(email === undefined ? {} : { email }),
      ...(role === undefined ? {} : { role }),
      ...(anonymised === undefined ? {} : { anonymised }),
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
      name: "email",
      label: t("emailLabel"),
      // `search`, never `type="email"`: this is a CONTAINS match, and the
      // browser would refuse to submit a bare "acme".
      type: "search",
      value: email,
      placeholder: t("emailPlaceholder"),
      width: "lg",
    },
    {
      kind: "select",
      name: "role",
      label: t("roleLabel"),
      value: role,
      anyLabel: t("anyRole"),
      // Driven off the contract enum rather than a hand-typed list, so a new
      // role appears in the filter the day it appears on the wire — and its
      // label comes from the same `status.role` namespace the badges read, so
      // the filter and the column can never name the same role differently.
      options: roleSchema.options.map((option) => ({
        value: option,
        label: tStatus(option),
      })),
    },
    {
      // A SELECT AND NOT A CHECKBOX, though the artboard draws "Incluir
      // borrados". The API's filter is three-valued — erased only, active only,
      // or absent for both — and a checkbox can only express two of those. The
      // one it would have to drop is "active only", which is the state an
      // operator auditing a live customer base actually wants.
      kind: "select",
      name: "anonymised",
      label: t("erasedLabel"),
      value: anonymised,
      anyLabel: t("anyErased"),
      options: [
        { value: "false", label: t("activeOnly") },
        { value: "true", label: t("erasedOnly") },
      ],
    },
  ];

  const columns: readonly Column<AdminCustomer>[] = [
    {
      key: "email",
      header: t("columns.email"),
      cell: (customer) => (
        <span className="flex flex-wrap items-center gap-[6px]">
          <Link
            href={`${PATHNAME}/${customer.id}`}
            aria-label={t("viewCustomer", { email: customer.email })}
            className="rounded-[var(--r-check)] text-[var(--accent)] no-underline hover:underline focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
          >
            {customer.email}
          </Link>
          {/*
            ERASURE IS NOT A STATUS DOMAIN. `lib/status` covers the twelve
            badged VOCABULARIES; anonymisation is a nullable timestamp, so its
            badge is a plain warning capsule with its own translated label
            rather than a thirteenth domain holding one member.
          */}
          {customer.anonymisedAt !== null && (
            <Badge tone="warning" density="compact" label={t("erased")} />
          )}
          {/*
            Only the UNVERIFIED half is drawn. A verified address is the normal
            case, and a badge on every row is a badge nobody reads — the column
            is scanned for the exception.
          */}
          {customer.emailVerifiedAt === null && (
            <StatusBadge domain="emailVerification" value="unverified" density="compact" />
          )}
        </span>
      ),
    },
    {
      key: "name",
      header: t("columns.name"),
      cell: (customer) => fullName(customer.firstName, customer.lastName) ?? NO_VALUE,
    },
    {
      key: "role",
      header: t("columns.role"),
      cell: (customer) => (
        <StatusBadge domain="role" value={customer.role} density="compact" />
      ),
    },
    {
      key: "orders",
      header: t("columns.orders"),
      kind: "numeric",
      cell: (customer) => formatCount(customer.orderCount, locale),
    },
    {
      key: "lifetimeValue",
      header: t("columns.lifetimeValue"),
      kind: "numeric",
      /*
       * `AggregateMoney`, NEVER `Money`. `lifetimeValueMinor` is declared
       * `z.number().int()` on purpose: an aggregate has no ceiling where the
       * branded `Minor` does, so `toMinor` would THROW on a successful business
       * and an `isMinor` guard would fall through to a bare integer where a
       * euro figure belongs. This column is display-only and never settles.
       */
      cell: (customer) => (
        <AggregateMoney
          amountMinor={customer.lifetimeValueMinor}
          currency={DEFAULT_CURRENCY}
          locale={locale}
        />
      ),
    },
    {
      key: "lastOrder",
      header: t("columns.lastOrder"),
      cell: (customer) =>
        customer.lastOrderAt === null ? NO_VALUE : formatDate(customer.lastOrderAt, locale),
    },
  ];

  const filtered = email !== undefined || role !== undefined || anonymised !== undefined;

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      filters={
        <FilterBar
          label={t("filters")}
          fields={fields}
          pathname={PATHNAME}
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
        rowKey={(customer) => customer.id}
        minWidth="narrow"
        empty={
          // Two different nothings. "No customer matches these filters" is a
          // statement about the QUERY and is a lie on an unfiltered list, where
          // the honest answer is that the store has no accounts yet.
          filtered ? (
            <EmptyState
              density="table"
              reason="no-matches"
              title={t("emptyTitle")}
              body={tUi("noMatchesBody")}
            />
          ) : (
            <EmptyState
              density="table"
              icon="users"
              title={tUi("emptyTitle")}
              body={tUi("emptyBody")}
            />
          )
        }
        footer={
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
            pathname={PATHNAME}
            searchParams={query}
            itemCount={page.items.length}
            pageSize={limit}
            hasMore={page.hasMore}
            nextCursor={page.nextCursor}
          />
        }
      />
    </PageTemplate>
  );
}

/**
 * Counts go through `Intl`, not `String(n)`: 1.204 in Spanish and 1,204 in
 * English, matching the grouped figures beside them in the money column.
 */
function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-IE").format(value);
}

function asRole(value: string | undefined): Role | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = roleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The API takes this as the literal string "true" or "false", not a boolean.
 *
 * That is deliberate on its side: `z.coerce.boolean()` is a truthiness cast, so
 * the string "false" is non-empty and coerces to TRUE, inverting the filter. The
 * client must therefore not "helpfully" convert it to a boolean here.
 */
function asBooleanFilter(value: string | undefined): "true" | "false" | undefined {
  return value === "true" || value === "false" ? value : undefined;
}

/**
 * The page size, narrowed to the three sizes the control offers.
 *
 * `paginationQuerySchema` clamps `limit` to 1..100, so a hand-edited 500 is a
 * 400 from the API with the operator's filters lost — and any value outside the
 * offered set would also make `CursorPagination`'s "showing 51–75" arithmetic
 * wrong, since that is derived from the stack depth times this number.
 */
function asPageSize(value: string | undefined): number {
  if (value === undefined) {
    return 25;
  }
  const parsed = Number.parseInt(value, 10);
  return PAGE_SIZES.includes(parsed) ? parsed : 25;
}

export const dynamic = "force-dynamic";
