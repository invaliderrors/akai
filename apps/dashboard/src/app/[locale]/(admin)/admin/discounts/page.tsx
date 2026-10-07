import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { type Locale } from "@akai/contracts";
import { formatMoney } from "@akai/money";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { DiscountEditor } from "@/components/admin/discount-editor";
import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { buildFilterHref, FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { Icon } from "@/components/ui/icon";
import {
  activeCursor,
  CursorPagination,
  type PaginationLabels,
  type PaginationRange,
} from "@/components/ui/pagination";
import type { SearchParamValue } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column, type RowTone } from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { listAffiliates, listDiscounts } from "@/lib/admin/api";
import { formatDate, formatValue, resolveState } from "@/lib/admin/discount-display";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { DEFAULT_CURRENCY, type AdminDiscount } from "@/lib/admin/schemas";
import { createServerApiClient } from "@/lib/api/client";

/**
 * The admin coupon list, and the editor for the one row an operator opened.
 *
 * Same shape as the product and stock lists and for the same reasons: the
 * filter lives in the URL so the view is linkable and survives a reload, which
 * keeps this a server component with no client-side fetch; and pagination is
 * CURSOR-based because the API offers nothing else — under OFFSET a code created
 * between two page loads makes a row appear twice or vanish.
 *
 * SELECTION IS A URL PARAMETER (`?edit=<id>`), the same mechanism row expansion
 * uses elsewhere, and for the same three reasons: the open record survives a
 * reload and a share, the row that opens it is a plain link that works with
 * JavaScript off, and holding it in React state would drag this whole page —
 * every row, every filter — into a client bundle. The selected row takes the
 * accent fill and its badge switches to `onAccent`, so the record being edited
 * below is the one the operator can see they picked.
 *
 * THE EDITOR IS THE SAME COMPONENT THE DETAIL ROUTE RENDERS. Nothing is
 * duplicated: `/admin/discounts/[id]` stays as the linkable, bookmarkable page
 * (and is where a freshly created code lands), carrying the usage figures this
 * panel has no room for. The row action reaches it; the code cell opens the
 * inline editor.
 *
 * TRANSLATED THROUGHOUT, and it was the first admin page that was — the other
 * nine followed it, so its key shape (`title`/`description`/`col*`/`state.*`)
 * is the house style rather than one page's invention.
 */
export const dynamic = "force-dynamic";

/** The page size an operator gets before touching the per-page control. */
const DEFAULT_LIMIT = 25;

/**
 * When a code's usage bar stops being information and starts being a warning.
 *
 * Four fifths spent is the point at which "this may run out mid-campaign"
 * becomes actionable — early enough to raise the cap before customers meet a
 * rejected code at the checkout, late enough that a quiet coupon never shouts.
 * EXHAUSTED (the badge) is the terminal state; this is the approach to it.
 */
const USAGE_WARNING_RATIO = 0.8;

/** The panel the code cell's `aria-controls` points at. */
const EDITOR_PANEL_ID = "discount-editor-panel";

export default async function AdminDiscountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = asLocale(rawLocale);
  const t = await getTranslations("admin.discounts");
  const tUi = await getTranslations("ui");

  const pathname = "/admin/discounts";
  // The TOP of the cursor stack, not its first entry: the stack is a repeated
  // `cursor` param holding one entry per page walked, and reading the first
  // would refetch page two forever.
  const cursor = activeCursor(query["cursor"]);
  const includeDeleted = single(query["includeDeleted"]) === "true";
  const limit = readLimit(query["limit"]);
  const selectedId = single(query["edit"]);

  const http = createAdminHttp(await createServerApiClient());

  // Degrades to `undefined` on failure — the inline editor panel just renders
  // without an affiliate picker until the list loads; nothing else on this
  // page depends on it.
  const affiliates = await listAffiliates(http, { limit: 100 }).then(
    (result) => result.items,
    () => undefined,
  );

  let page: Awaited<ReturnType<typeof listDiscounts>>;
  try {
    page = await listDiscounts(http, {
      ...(cursor === undefined ? {} : { cursor }),
      includeDeleted,
      limit,
    });
  } catch (cause) {
    // The thrown `AdminApiError` carries the API's own English message, which is
    // written for a log. `AdminErrorState` renders the translated one — and
    // tells a stale admin session apart from a real permission failure, which
    // this page cannot do from the code alone (both are FORBIDDEN).
    return (
      <PageTemplate title={t("title")} description={t("description")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  const now = Date.now();
  // Resolved against THIS page's rows rather than fetched: a selection that is
  // not on the page in front of the operator (a stale link, a code filtered
  // away) simply opens nothing, instead of showing an editor for a record they
  // cannot see in the table above it.
  const selected = selectedId === undefined
    ? undefined
    : page.items.find((discount) => discount.id === selectedId);

  const counts = new Intl.NumberFormat(locale === "es" ? "es-CO" : "en-US");

  /**
   * Defined here rather than at module scope so it closes over `t`: next-intl's
   * translator type is not something a hand-written parameter annotation can
   * restate without either widening it or reaching for `any`.
   */
  function describeWindow(discount: AdminDiscount): string {
    const { startsAt, endsAt } = discount;
    if (startsAt === null && endsAt === null) {
      return t("always");
    }
    if (startsAt !== null && endsAt !== null) {
      return t("between", { from: formatDate(startsAt, locale), until: formatDate(endsAt, locale) });
    }
    if (startsAt !== null) {
      return t("from", { date: formatDate(startsAt, locale) });
    }
    return t("until", { date: endsAt === null ? "" : formatDate(endsAt, locale) });
  }

  /** Closes over `tUi`, for the reason `describeWindow` closes over `t`. */
  function paginationLabels(): PaginationLabels {
    return {
      nav: tUi("pagination"),
      first: tUi("first"),
      previous: tUi("previous"),
      next: tUi("next"),
      page: (value: number) => tUi("page", { page: value }),
      perPage: tUi("perPage"),
      showing: ({ from, to, hasMore }: PaginationRange) =>
        hasMore ? tUi("showingMore", { from, to }) : tUi("showing", { from, to }),
    };
  }

  /** Opens a row, or closes the one already open — one link does both. */
  function selectHref(discount: AdminDiscount): string {
    return buildFilterHref({
      pathname,
      searchParams: query,
      set: { edit: discount.id === selectedId ? undefined : discount.id },
    });
  }

  const fields: readonly FilterField[] = [
    {
      kind: "checkbox",
      name: "includeDeleted",
      label: t("filterIncludeDeleted"),
      checked: includeDeleted,
    },
  ];

  const columns: readonly Column<AdminDiscount>[] = [
    {
      key: "code",
      header: t("colCode"),
      kind: "identifier",
      cell: (discount, state) =>
        // On the selected row the link becomes plain text: it is already open,
        // and a link that leads to where you are is a dead control. The panel's
        // own close affordance is the Cancel button in its footer.
        state.selected ? (
          discount.code
        ) : (
          <Link
            href={selectHref(discount)}
            aria-expanded={false}
            aria-controls={EDITOR_PANEL_ID}
            // The accessible name CONTAINS the visible code, so the two agree
            // (WCAG 2.5.3) while the verb tells a screen-reader user what the
            // link does — which "VERANO26" alone does not.
            aria-label={t("editRow", { code: discount.code })}
          >
            {discount.code}
          </Link>
        ),
    },
    {
      key: "type",
      header: t("colType"),
      cell: (discount) => t(`type.${discount.type}`),
    },
    {
      key: "value",
      header: t("colValue"),
      kind: "numeric",
      // FREE_SHIPPING has no value at all, and `formatValue` renders that as an
      // em-dash — greyed here so it reads as "not applicable" rather than as a
      // figure someone forgot to fill in.
      cell: (discount) =>
        discount.type === "FREE_SHIPPING" ? (
          <Dash />
        ) : (
          formatValue(discount, locale)
        ),
    },
    {
      key: "minimum",
      header: t("colMinimum"),
      kind: "numeric",
      // `formatMoney` rather than `<Money>`: that component pins `--label` on
      // its figure, and this row can be accent-filled with white ink — two
      // `text-[…]` utilities at equal specificity resolve by stylesheet order,
      // which no call site controls. The column kind already supplies the
      // tabular figures and the right alignment.
      cell: (discount) =>
        discount.minimumSubtotal === null
          ? t("noMinimum")
          : formatMoney(discount.minimumSubtotal, discount.currency ?? DEFAULT_CURRENCY, locale),
    },
    {
      // Usage, not just the cap: an operator managing coupons needs to see how
      // much of a code's allowance is already spent, and how fast it is going.
      key: "usage",
      header: t("colUsage"),
      cell: (discount, state) =>
        discount.maxRedemptions === null ? (
          <span className="tabular-nums">
            {`${counts.format(discount.timesRedeemed)} · ${t("unlimited")}`}
          </span>
        ) : (
          <UsageMeter
            used={discount.timesRedeemed}
            max={discount.maxRedemptions}
            label={t("usageOf", {
              used: counts.format(discount.timesRedeemed),
              max: counts.format(discount.maxRedemptions),
            })}
            onAccent={state.selected}
          />
        ),
    },
    {
      key: "window",
      header: t("colWindow"),
      cell: (discount) => describeWindow(discount),
    },
    {
      key: "state",
      header: t("colState"),
      cell: (discount, state) => (
        <StatusBadge
          domain="discount"
          value={resolveState(discount, now)}
          density="compact"
          onAccent={state.selected}
        />
      ),
    },
    {
      key: "actions",
      header: tUi("actions"),
      kind: "actions",
      // The way to the full record: the detail route carries the usage figures
      // and the archived notice this panel has no room for, and it is the URL a
      // freshly created code lands on.
      cell: (discount) => (
        <Link
          href={`/admin/discounts/${discount.id}`}
          className={buttonClassName({ variant: "plain", size: "compact" })}
        >
          {tUi("view")}
        </Link>
      ),
    },
  ];

  function rowTone(discount: AdminDiscount): RowTone {
    return discount.id === selectedId ? "selected" : "default";
  }

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      actions={
        <Link
          href="/admin/discounts/new"
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
          pathname={pathname}
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
      <div className="grid gap-4">
        <DataTable
          caption={t("title")}
          columns={columns}
          rows={page.items}
          rowKey={(discount) => discount.id}
          rowTone={rowTone}
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

        {selected === undefined ? null : (
          // The id lives on a wrapper rather than on the card: `Card` names
          // itself from its title and takes no id of its own, and the row link
          // above needs something to point `aria-controls` at.
          <div id={EDITOR_PANEL_ID}>
            <Card title={selected.code} titleId={`${EDITOR_PANEL_ID}-title`}>
              <DiscountEditor
                discount={selected}
                {...(affiliates === undefined ? {} : { affiliates })}
                // Cancel closes the panel and leaves every filter, the page size
                // and the cursor stack exactly where they were.
                cancelHref={buildFilterHref({
                  pathname,
                  searchParams: query,
                  drop: ["edit"],
                })}
              />
            </Card>
          </div>
        )}
      </div>
    </PageTemplate>
  );
}

/** "Not applicable", drawn so it cannot be mistaken for a missing figure. */
function Dash() {
  return <span className="text-[var(--label-tertiary)]">—</span>;
}

interface UsageMeterProps {
  readonly used: number;
  readonly max: number;
  /** Already translated: "184 de 500". */
  readonly label: string;
  /** True on the accent-filled selected row, where every tint disappears. */
  readonly onAccent: boolean;
}

/**
 * How much of a capped code is spent.
 *
 * THE TRACK IS `aria-hidden` AND THE RATIO IS NEVER THE ONLY SIGNAL: the same
 * fact is written out beside it as "184 de 500", so the meter is redundant
 * decoration for anyone who cannot see it rather than information they lose.
 * That is also why this is not a `role="progressbar"` — a progressbar with a
 * name and a value announces the identical numbers a second time, in the middle
 * of a table row that is already dense.
 *
 * The bar turns `--warning` near the cap, and the FIGURE turns with it: colour
 * alone would leave the one row that needs attention indistinguishable in
 * greyscale from the twenty that do not (WCAG 1.4.1).
 */
function UsageMeter({ used, max, label, onAccent }: UsageMeterProps): ReactNode {
  // Clamped: `timesRedeemed` can legitimately exceed a cap that was lowered
  // after the fact, and a 140%-wide bar would paint outside its own track.
  const ratio = max <= 0 ? 1 : Math.min(1, used / max);
  const near = ratio >= USAGE_WARNING_RATIO;

  const track = onAccent ? "bg-[var(--accent-ink)]" : "bg-[var(--fill-tertiary)]";
  const fill = onAccent
    ? "bg-[var(--label-on-accent)]"
    : near
      ? "bg-[var(--warning)]"
      : "bg-[var(--accent)]";
  const ink = onAccent ? "" : near ? " text-[var(--warning-text)] font-semibold" : "";

  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-[4px] min-w-[48px] flex-1 overflow-hidden rounded-[var(--r-pill)] ${track}`}
      >
        {/* An inline width because the value is data: Tailwind finds utilities
            by scanning source text, so `w-[${percent}%]` is a class that is
            never generated — the bar would silently render at zero. */}
        <span
          className={`block h-full rounded-[var(--r-pill)] ${fill}`}
          style={{ width: `${(ratio * 100).toFixed(1)}%` }}
        />
      </span>
      <span className={`shrink-0 text-[12px] tabular-nums${ink}`}>{label}</span>
    </span>
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

function asLocale(value: string): Locale {
  return value === "en" ? "en" : "es";
}
