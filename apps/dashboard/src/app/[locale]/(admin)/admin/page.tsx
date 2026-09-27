import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { formatAggregateMinor } from "@akai/money";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { RevenueChart, MIN_CHART_POINTS } from "@/components/admin/revenue-chart";
import { StatusBreakdown } from "@/components/admin/status-breakdown";
import { asLocale, formatDate } from "@/components/account/format";
import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import type { IconName } from "@/components/ui/icon";
import { MetricTile } from "@/components/ui/metric-tile";
import { AggregateMoney } from "@/components/ui/money";
import { single } from "@/components/ui/filter-bar";
import { SegmentedControl, type Segment, type SearchParamValue } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  DataTable,
  type Column,
  type RowTone,
  type TableMinWidth,
} from "@/components/ui/table";
import { getPathname, Link } from "@/i18n/navigation";
import {
  getEmailSummary,
  getLowStock,
  getMetricsOverview,
  getRecentOrders,
  getRepeatRate,
  getReturnsSummary,
  getRevenueSeries,
  getTopProducts,
  type MetricsWindowParams,
} from "@/lib/admin/api";
import { intlLocale } from "@/lib/admin/discount-display";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import type { LowStockVariant, RecentOrder, TopProduct } from "@/lib/admin/schemas";
import type { StockState } from "@/lib/admin/inventory-display";
import { createServerApiClient } from "@/lib/api/client";

/**
 * The admin overview — the one landing screen, serving the one dataset.
 *
 * IT ABSORBED `/admin/metrics`, WHICH IS NOW DELETED. The two routes made the
 * same four calls, rendered the same four figures, and disagreed about how to
 * format them: this page branded every aggregate through `toMinor` (which
 * THROWS above `MINOR_MAX`, so it would start crashing on a successful
 * business) and the metrics page used an `isMinor(x) ? formatMoney(x) : String(x)`
 * fallback, which prints a bare `2400000000` for exactly the figures it was
 * guarding. Both are gone: aggregates render through `AggregateMoney` /
 * `formatAggregateMinor`, which take an UNBRANDED integer, apply no range check
 * and never throw. That is safe because nothing here can move money — an
 * aggregate is display-only, is never accepted back from a request and is never
 * the input to arithmetic.
 *
 * THE FOUR PANELS LOAD CONCURRENTLY AND FAIL INDEPENDENTLY. `Promise.allSettled`,
 * never `Promise.all`: a stalled low-stock query must not blank the revenue
 * figure the operator opened the page for. Each panel renders its own failure,
 * through `AdminErrorState`, so a stale second factor still produces one
 * actionable "sign in again" panel rather than a dead end per table.
 *
 * THE PERIOD CONTROL IS A SEGMENTED CONTROL OF LINKS, NOT CLIENT STATE.
 * `?days=7|30|90` selects the window every windowed panel below reads from —
 * revenue, best sellers, repeat rate, returns, emails and the daily series all
 * resolve `from`/`to` from the SAME `windowParams`, for the reason the overview
 * endpoint's own doc comment gives for bundling revenue and status counts: two
 * panels computed over different windows disagree with each other in a way
 * that reads as a data bug, not as "the operator picked different periods".
 *
 * THE CHART IS `RevenueChart`, a hand-rolled inline SVG polyline — no charting
 * library, the same call `icon.tsx` already made for forty-eight glyphs.
 * `/admin/metrics/revenue-series` is its own endpoint, fetched and failing
 * independently of the four scalar tiles above it; a `metricsOverviewSchema`
 * response still carries no series, and the chart draws from nothing else.
 *
 * STILL NO "UPDATED N MINUTES AGO" AND NO CSV EXPORT — neither is sourceable
 * from anything this page fetches, and inventing either would be the same
 * mistake the deleted chart used to be. `grep -rni csv apps/ libs/` returns
 * zero hits; there is nothing to export.
 *
 * Everything is still a SERVER component. The period control is a row of
 * `Link`s (`SegmentedControl`), the same idiom `FilterBar` uses elsewhere in
 * admin — a filtered/windowed view is linkable, survives a reload and steps
 * back with the back button, and none of it needs a hydration boundary.
 */

/**
 * Carried over from the deleted metrics route.
 *
 * `createServerApiClient` reads the sealed session cookie, which already opts
 * this page out of static rendering, so this is belt-and-braces — but a revenue
 * figure served from a cache is a figure that is quietly wrong, and stating the
 * requirement is cheaper than rediscovering it.
 */
export const dynamic = "force-dynamic";

/**
 * The window's currency, asked for explicitly rather than left to the API's
 * default.
 *
 * `/admin/metrics/overview` and `/admin/metrics/top-products` each filter their
 * SQL on `currency = :currency` and default it to EUR independently. Passing the
 * same value to both is what guarantees the tiles and the best-seller column are
 * counting the same orders; the tiles themselves still format with the currency
 * the API ECHOES back, which is the authoritative answer for the window it
 * actually ran.
 */
const REPORTING_CURRENCY = "EUR";

/**
 * The one order status that needs a human, and the filter that isolates it.
 *
 * `PAYMENT_MISMATCH` means the provider settled an amount that is not ours:
 * money may already have moved, the order is frozen, and the state machine
 * refuses PAID from every automated path. It is one of exactly two places in the
 * product allowed to draw the attention treatment (`lib/status` argues the cap).
 */
const MISMATCH_STATUS = "PAYMENT_MISMATCH";
const MISMATCH_HREF = `/admin/orders?status=${MISMATCH_STATUS}`;

/** Rows for a panel that failed. Shared so the empty literal is not retyped. */
const NO_ROWS: readonly never[] = [];

/**
 * The histogram when the overview itself failed.
 *
 * A named empty array rather than `[]` inline, so the reduce and the lookup
 * below it read the same way whether or not the fetch landed — and so neither
 * has to be written twice under a status check.
 */
const NO_STATUS_COUNTS: readonly { readonly status: string; readonly count: number }[] = [];

/**
 * The three window presets, and the query param they live in.
 *
 * A closed set rather than a free-typed number of days: every windowed fetch
 * below shares this list with the API's own `MAX_WINDOW_DAYS` headroom (366),
 * so a caller cannot hand-edit the URL into a window costly enough to be the
 * denial-of-service `metricsWindowQuerySchema` was written to refuse — an
 * unrecognised value just falls back to the default rather than reaching a
 * fetch at all.
 */
const WINDOW_DAYS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOW_DAYS)[number];
const DEFAULT_WINDOW_DAYS: WindowDays = 30;
const WINDOW_PARAM = "days";
const RANGE_FROM_PARAM = "from";
const RANGE_TO_PARAM = "to";
/** Both params the exact-range form owns — dropped whenever a preset is followed. */
const RANGE_PARAMS = [RANGE_FROM_PARAM, RANGE_TO_PARAM] as const;

function isWindowDays(value: number): value is WindowDays {
  return (WINDOW_DAYS as readonly number[]).includes(value);
}

function resolveWindowDays(raw: string | undefined): WindowDays {
  const parsed = Number(raw);
  return isWindowDays(parsed) ? parsed : DEFAULT_WINDOW_DAYS;
}

/**
 * The reporting window — either an exact `?from=&to=` pair, or the
 * `?days=` preset it falls back to.
 *
 * `windowDays` comes back `null` in exact-range mode, which is what tells the
 * segmented control (and the page's own description line) which of the two
 * inputs is actually driving the fetches below — the two must never disagree
 * about that, or a tile could show one window's total under the other
 * window's label.
 *
 * AN INVALID RANGE FALLS BACK SILENTLY, the same instinct `resolveWindowDays`
 * already has for a stray `?days=`: a hand-edited or fat-fingered URL should
 * degrade to the default window rather than reach the API at all, which
 * `metricsWindowQuerySchema` would 400 on anyway (`from` must be before `to`).
 */
function resolveWindow(
  query: Record<string, SearchParamValue>,
): { readonly from: Date; readonly to: Date; readonly windowDays: WindowDays | null } {
  const fromRaw = single(query[RANGE_FROM_PARAM]);
  const toRaw = single(query[RANGE_TO_PARAM]);

  if (fromRaw !== undefined && toRaw !== undefined) {
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from < to) {
      return { from, to, windowDays: null };
    }
  }

  const windowDays = resolveWindowDays(single(query[WINDOW_PARAM]));
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return { from, to, windowDays };
}

/** `<input type="date">` wants `YYYY-MM-DD`; nothing here needs the time part. */
function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface AdminOverviewPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, SearchParamValue>>;
}

export default async function AdminOverviewPage({ params, searchParams }: AdminOverviewPageProps) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = asLocale(rawLocale);
  const t = await getTranslations("admin.overview");
  // The kit's own generic copy — the second line under an empty table. The
  // panel-specific sentence is the title above it.
  const tUi = await getTranslations("ui");

  /**
   * Counts are grouped in the reader's locale ("1.204", not "1204"). `MetricTile`
   * takes an already-formatted string for a non-money figure precisely because
   * the kit has no number formatter and inventing one there would put a second
   * opinion about grouping beside `@akai/money`'s.
   */
  const counts = new Intl.NumberFormat(intlLocale(locale));
  const percent = new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  });

  const { from: windowFrom, to: windowTo, windowDays } = resolveWindow(query);
  const windowParams: MetricsWindowParams = {
    from: windowFrom.toISOString(),
    to: windowTo.toISOString(),
    currency: REPORTING_CURRENCY,
  };
  const windowSegments: readonly Segment[] = WINDOW_DAYS.map((days) => ({
    value: String(days),
    label: t(`window${days}d`),
  }));
  const rangeFormAction = getPathname({ href: "/admin", locale: rawLocale });

  const http = createAdminHttp(await createServerApiClient());

  const [overview, topProducts, lowStock, recentOrders, repeatRate, returns, emails, revenueSeries] =
    await Promise.allSettled([
      getMetricsOverview(http, windowParams),
      getTopProducts(http, { ...windowParams, limit: 5 }),
      // These two take a bare limit, not a params object — they are point-in-time
      // snapshots (current stock, most recent orders), not windowed sums.
      getLowStock(http, 5),
      getRecentOrders(http, 5),
      getRepeatRate(http, windowParams),
      getReturnsSummary(http, windowParams),
      getEmailSummary(http, windowParams),
      getRevenueSeries(http, windowParams),
    ]);

  /*
   * Derived ONCE, outside the JSX, and read in two places: the attention tile
   * and the breakdown beside it (now `StatusBreakdown`, which computes its own
   * share-of-total). Recomputing per render site is how a tile saying "2" ends
   * up above a list saying 3 — the two would be reading the same array through
   * two different expressions, and only one of them would get fixed the day
   * the shape moves.
   */
  const ordersByStatus =
    overview.status === "fulfilled" ? overview.value.ordersByStatus : NO_STATUS_COUNTS;
  const mismatches = ordersByStatus.find((entry) => entry.status === MISMATCH_STATUS)?.count ?? 0;

  const topProductColumns: readonly Column<TopProduct>[] = [
    { key: "product", header: t("columns.product"), cell: (row) => row.productName },
    // No link: `topProductSchema` carries the order line's SNAPSHOTTED sku and
    // name (so last quarter's figures survive a rename) and no product id, so
    // there is no href to build. A dead link would be worse than none.
    { key: "sku", header: t("columns.sku"), kind: "identifier", cell: (row) => row.sku },
    {
      key: "units",
      header: t("columns.units"),
      kind: "numeric",
      cell: (row) => counts.format(row.unitsSold),
    },
    {
      key: "revenue",
      header: t("columns.revenue"),
      kind: "numeric",
      cell: (row) => (
        <AggregateMoney
          amountMinor={row.revenueGross}
          currency={REPORTING_CURRENCY}
          locale={locale}
        />
      ),
    },
  ];

  const lowStockColumns: readonly Column<LowStockVariant>[] = [
    { key: "sku", header: t("columns.sku"), kind: "identifier", cell: (row) => row.sku },
    {
      key: "state",
      header: t("columns.status"),
      cell: (row) => (
        <StatusBadge domain="stock" value={stockStateOf(row)} density="compact" />
      ),
    },
    {
      // `available` (onHand − reserved) is the only number here that means
      // anything on its own: stock already inside someone else's in-flight
      // checkout is not stock this shop can sell. On hand and reserved follow so
      // an operator can see WHY availability is where it is.
      key: "available",
      header: t("columns.available"),
      kind: "numeric",
      cell: (row) => counts.format(row.available),
    },
    {
      key: "onHand",
      header: t("columns.onHand"),
      kind: "numeric",
      cell: (row) => counts.format(row.onHand),
    },
    {
      key: "reserved",
      header: t("columns.reserved"),
      kind: "numeric",
      cell: (row) => counts.format(row.reserved),
    },
    {
      key: "threshold",
      header: t("columns.threshold"),
      kind: "numeric",
      cell: (row) => counts.format(row.lowStockThreshold),
    },
  ];

  const recentOrderColumns: readonly Column<RecentOrder>[] = [
    {
      key: "order",
      header: t("columns.order"),
      kind: "identifier",
      cell: (row) => <Link href={`/admin/orders/${row.orderNumber}`}>{row.orderNumber}</Link>,
    },
    {
      key: "status",
      header: t("columns.status"),
      // NEVER the raw member. `PAYMENT_MISMATCH` and `PARTIALLY_REFUNDED` were
      // printed verbatim at an operator here until this rewrite; the badge reads
      // (domain, member) through `lib/status`, so a cancelled ORDER and one dead
      // payment ATTEMPT cannot end up sharing a label.
      cell: (row, state) => (
        <StatusBadge
          domain="order"
          value={row.status}
          density="compact"
          onAccent={state.selected}
        />
      ),
    },
    {
      key: "placed",
      header: t("columns.placed"),
      cell: (row) => formatDate(row.placedAt, locale),
    },
    {
      // Each row carries its OWN currency: `/admin/metrics/recent-orders` takes
      // no currency filter, so a shop selling in two would otherwise have half
      // its totals relabelled.
      key: "total",
      header: t("columns.total"),
      kind: "numeric",
      cell: (row) => (
        <AggregateMoney amountMinor={row.grandTotal} currency={row.currency} locale={locale} />
      ),
    },
  ];

  return (
    <PageTemplate
      width="admin"
      title={t("title")}
      description={
        windowDays === null
          ? t("descriptionRange", {
              from: formatDate(windowFrom.toISOString(), locale),
              to: formatDate(windowTo.toISOString(), locale),
            })
          : t("description", { days: windowDays })
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label={t("windowLabel")}
            segments={windowSegments}
            value={windowDays === null ? undefined : String(windowDays)}
            pathname="/admin"
            param={WINDOW_PARAM}
            searchParams={query}
            resets={RANGE_PARAMS}
          />
          {/* A NATIVE GET FORM, not client state — same reasoning as the
              segmented control above: an exact range is a URL, survives a
              reload and a share, and needs no hydration boundary. Submitting
              it drops `?days=` implicitly (the preset param is simply absent
              from this form), the same way a preset click drops `from`/`to`
              via `resets`. */}
          <form
            action={rangeFormAction}
            method="GET"
            className="flex flex-wrap items-center gap-2"
            aria-label={t("exactRangeLabel")}
          >
            <label className="flex items-center gap-1.5 text-[13px] text-[var(--label-secondary)]">
              {t("fromLabel")}
              <input
                type="date"
                name={RANGE_FROM_PARAM}
                defaultValue={toDateInputValue(windowFrom)}
                max={toDateInputValue(windowTo)}
                className="rounded-[var(--r-control)] border-0 bg-[var(--fill-tertiary)] px-2 py-1 text-[13px] text-[var(--label)]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-[var(--label-secondary)]">
              {t("toLabel")}
              <input
                type="date"
                name={RANGE_TO_PARAM}
                defaultValue={toDateInputValue(windowTo)}
                className="rounded-[var(--r-control)] border-0 bg-[var(--fill-tertiary)] px-2 py-1 text-[13px] text-[var(--label)]"
              />
            </label>
            <button
              type="submit"
              className={buttonClassName({ variant: "standard", size: "compact" })}
            >
              {t("applyRange")}
            </button>
          </form>
        </div>
      }
    >
      <div className="grid gap-5">
        {overview.status === "rejected" ? (
          <AdminErrorState cause={causeOf(overview)} title={t("revenueErrorTitle")} />
        ) : (
          <>
            {/* `auto-fit` rather than a column count: the attention tile is
                CONDITIONAL, so the row is four tiles or five, and a fixed
                `lg:grid-cols-4` would leave the fifth alone on its own line. */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
              <MetricTile
                label={t("netRevenue")}
                value={{
                  kind: "money",
                  amountMinor: overview.value.revenue.netTotal,
                  currency: overview.value.revenue.currency,
                  locale,
                }}
                footnote={t("netRevenueHint")}
              />
              <MetricTile
                label={t("grossRevenue")}
                value={{
                  kind: "money",
                  amountMinor: overview.value.revenue.grossTotal,
                  currency: overview.value.revenue.currency,
                  locale,
                }}
                // The refunded total has no tile of its own: it is not revenue,
                // and a fifth headline figure for it would compete with the one
                // tile on this row that means someone has work to do.
                footnote={t("grossRevenueHint", {
                  amount: formatAggregateMinor(
                    overview.value.revenue.refundedTotal,
                    overview.value.revenue.currency,
                    locale,
                  ),
                })}
              />
              <MetricTile
                label={t("orders")}
                value={{ kind: "text", value: counts.format(overview.value.revenue.orderCount) }}
                footnote={t("ordersHint")}
              />
              <MetricTile
                label={t("averageOrder")}
                value={{
                  kind: "money",
                  amountMinor: overview.value.revenue.averageOrderValue,
                  currency: overview.value.revenue.currency,
                  locale,
                }}
                footnote={t("averageOrderHint")}
              />

              {/*
                RENDERED ONLY WHEN THERE IS SOMETHING TO DECIDE. The attention
                treatment is rationed to two uses in the whole product, and a
                permanent tile reading "0 need a decision" spends one of them on
                good news — after a week nobody reads the red any more, which is
                exactly the failure the cap exists to prevent. `MetricTile`'s
                `attention` tone is the hairline-and-red-ink variant, not the
                solid fill: a tile SUMMARISES the rows that need a human, it is
                not one of them.
              */}
              {mismatches > 0 && (
                <MetricTile
                  tone="attention"
                  label={t("attentionTitle")}
                  value={{ kind: "text", value: counts.format(mismatches) }}
                  footnote={t("attentionBody", { count: mismatches })}
                  link={{ href: MISMATCH_HREF, label: t("attentionCta") }}
                />
              )}
            </div>

            {ordersByStatus.length > 0 && (
              <Card title={t("byStatus")} titleId="orders-by-status-title">
                {/* No link on the mismatch row, though the artboard draws one:
                    the attention tile directly above already owns the way into
                    that filter, and a second control whose visible text
                    ("Importe no coincide") is not contained in its accessible
                    name would fail WCAG 2.5.3. */}
                <StatusBreakdown
                  domain="order"
                  entries={ordersByStatus}
                  formatCount={(count) => counts.format(count)}
                  emphasize={(status) => status === MISMATCH_STATUS}
                />
              </Card>
            )}
          </>
        )}

        <Card title={t("dailyRevenueTitle")} titleId="daily-revenue-title">
          {revenueSeries.status === "rejected" ? (
            <AdminErrorState
              cause={causeOf(revenueSeries)}
              title={t("dailyRevenueErrorTitle")}
              density="table"
            />
          ) : revenueSeries.value.length < MIN_CHART_POINTS ? (
            <EmptyState
              density="table"
              title={t("dailyRevenueEmpty")}
              body={tUi("emptyBody")}
              icon="chart-line"
            />
          ) : (
            <RevenueChart points={revenueSeries.value} label={t("dailyRevenueChartLabel")} />
          )}
        </Card>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          <Card title={t("repeatRate")} titleId="repeat-rate-title">
            {repeatRate.status === "rejected" ? (
              <AdminErrorState
                cause={causeOf(repeatRate)}
                title={t("repeatRateErrorTitle")}
                density="table"
              />
            ) : (
              <>
                <p className="m-0 text-[22px] leading-[26px] font-bold tabular-nums text-[var(--label)]">
                  {percent.format(repeatRate.value.repeatRate)}
                </p>
                <p className="m-0 mt-1.5 text-[12px] text-[var(--label-secondary)]">
                  {t("repeatRateHint", { count: repeatRate.value.customersInWindow })}
                </p>
              </>
            )}
          </Card>

          <Card title={t("returnsTitle")} titleId="returns-title">
            {returns.status === "rejected" ? (
              <AdminErrorState
                cause={causeOf(returns)}
                title={t("returnsErrorTitle")}
                density="table"
              />
            ) : returns.value.byStatus.length === 0 ? (
              <EmptyState
                density="table"
                title={t("returnsEmpty")}
                body={tUi("emptyBody")}
                icon="undo-2"
              />
            ) : (
              <>
                <StatusBreakdown
                  domain="return"
                  entries={returns.value.byStatus}
                  formatCount={(count) => counts.format(count)}
                />
                <p className="m-0 mt-2.5 text-[12px] text-[var(--label-secondary)]">
                  {t("returnsTotal", { count: returns.value.total })}
                </p>
              </>
            )}
          </Card>

          <Card title={t("emailsTitle")} titleId="emails-title">
            {emails.status === "rejected" ? (
              <AdminErrorState
                cause={causeOf(emails)}
                title={t("emailsErrorTitle")}
                density="table"
              />
            ) : emails.value.byStatus.length === 0 ? (
              <EmptyState
                density="table"
                title={t("emailsEmpty")}
                body={tUi("emptyBody")}
                icon="mail"
              />
            ) : (
              <>
                <StatusBreakdown
                  domain="email"
                  entries={emails.value.byStatus}
                  formatCount={(count) => counts.format(count)}
                />
                <p className="m-0 mt-2.5 text-[12px] text-[var(--label-secondary)]">
                  {t("emailsTotal", { count: emails.value.total })}
                </p>
              </>
            )}
          </Card>
        </div>

        <OverviewTable<LowStockVariant>
          settled={lowStock}
          id="low-stock"
          title={t("lowStock")}
          emptyTitle={t("lowStockEmpty")}
          emptyBody={tUi("emptyBody")}
          emptyIcon="boxes"
          errorTitle={t("lowStockErrorTitle")}
          columns={lowStockColumns}
          rowKey={(row) => row.variantId}
          minWidth="regular"
          action={
            <Link
              href="/admin/inventory"
              className={buttonClassName({ variant: "plain", size: "compact" })}
            >
              {t("lowStockCta")}
            </Link>
          }
        />

        <OverviewTable<TopProduct>
          settled={topProducts}
          id="best-sellers"
          title={t("bestSellers")}
          emptyTitle={t("bestSellersEmpty")}
          emptyBody={tUi("emptyBody")}
          emptyIcon="star"
          errorTitle={t("bestSellersErrorTitle")}
          columns={topProductColumns}
          rowKey={(row) => row.sku}
          minWidth="regular"
        />

        <OverviewTable<RecentOrder>
          settled={recentOrders}
          id="recent-orders"
          title={t("recentOrders")}
          emptyTitle={t("recentOrdersEmpty")}
          emptyBody={tUi("emptyBody")}
          emptyIcon="package"
          errorTitle={t("recentOrdersErrorTitle")}
          columns={recentOrderColumns}
          rowKey={(row) => row.orderNumber}
          minWidth="regular"
          /*
           * ONE OF THE TWO SANCTIONED ATTENTION ROWS, and this one is
           * unconditional: an order in PAYMENT_MISMATCH is frozen with money
           * possibly already moved, whatever else is true about it. (The other
           * — zero available stock — is gated on the product being ACTIVE by the
           * products and inventory screens, which is why the low-stock panel
           * above paints no rail: `lowStockVariantSchema` carries no product
           * status, so this page cannot prove the listing is reachable.)
           */
          rowTone={(row) => (row.status === MISMATCH_STATUS ? "attention" : "default")}
          action={
            <Link
              href="/admin/orders"
              className={buttonClassName({ variant: "plain", size: "compact" })}
            >
              {t("recentOrdersCta")}
            </Link>
          }
        />
      </div>
    </PageTemplate>
  );
}

// ---------------------------------------------------------------------------
// One panel
// ---------------------------------------------------------------------------

interface OverviewTableProps<Row> {
  /** The panel's own fetch, settled independently of its three neighbours. */
  readonly settled: PromiseSettledResult<readonly Row[]>;
  /** Prefix for the heading id the section names itself by. */
  readonly id: string;
  /** Already translated. Doubles as the table's `sr-only` caption. */
  readonly title: string;
  readonly emptyTitle: string;
  readonly emptyBody: string;
  readonly emptyIcon?: IconName;
  readonly errorTitle: string;
  readonly columns: readonly Column<Row>[];
  readonly rowKey: (row: Row) => string;
  readonly rowTone?: (row: Row) => RowTone;
  readonly minWidth?: TableMinWidth;
  /** Trailing slot of the heading row — the way into the full list. */
  readonly action?: ReactNode;
}

/**
 * A heading, its way-in link, and a table that renders its own three states.
 *
 * Extracted because the three panels below the tiles differ only in their
 * columns and their copy — and because the two routes this page replaces had
 * already drifted on exactly that: `/admin` gave a failed panel a red error box,
 * `/admin/metrics` gave the identical failure a grey sentence with no reference
 * to quote and no way to tell it apart from an empty list.
 *
 * The failure goes through `AdminErrorState` rather than `ui/states`' bare
 * `ErrorState` because a stale second factor is by far the most likely way an
 * admin fetch fails, all three of its situations arrive as `FORBIDDEN`, and only
 * the envelope's `reason` tells them apart. At `table` density, so the column
 * headings stay on screen above it.
 */
function OverviewTable<Row>({
  settled,
  id,
  title,
  emptyTitle,
  emptyBody,
  emptyIcon,
  errorTitle,
  columns,
  rowKey,
  rowTone,
  minWidth,
  action,
}: OverviewTableProps<Row>) {
  const titleId = `${id}-title`;

  return (
    <section aria-labelledby={titleId} className="min-w-0">
      <SectionHeader
        id={titleId}
        title={title}
        density="compact"
        {...(action === undefined ? {} : { action })}
      />
      <DataTable<Row>
        caption={title}
        columns={columns}
        rows={settled.status === "fulfilled" ? settled.value : NO_ROWS}
        rowKey={rowKey}
        {...(rowTone === undefined ? {} : { rowTone })}
        {...(minWidth === undefined ? {} : { minWidth })}
        empty={
          <EmptyState
            density="table"
            title={emptyTitle}
            body={emptyBody}
            {...(emptyIcon === undefined ? {} : { icon: emptyIcon })}
          />
        }
        {...(settled.status === "rejected"
          ? {
              error: (
                <AdminErrorState
                  cause={causeOf(settled)}
                  title={errorTitle}
                  density="table"
                />
              ),
            }
          : {})}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * The stock state of a low-stock row.
 *
 * `resolveStockState` cannot be reused here: it takes an `InventoryRow`, and
 * `lowStockVariantSchema` carries no `tracked` or `allowBackorder`. It does not
 * need to — the endpoint's own SQL is `allowBackorder = false AND (onHand −
 * reserved) <= lowStockThreshold` over `inventory_item`, so every row it returns
 * is tracked, is not on backorder, and is at or below its threshold. That leaves
 * exactly two of the five states reachable, and the split between them is the
 * one an operator acts on: zero available is a listing customers cannot buy from
 * today, anything above it is a reorder due this week.
 */
function stockStateOf(row: LowStockVariant): StockState {
  return row.available <= 0 ? "out" : "low";
}

/**
 * `PromiseRejectedResult.reason` is typed `any` by the standard library.
 *
 * Widening it to `unknown` at the boundary is what keeps the rest of this file
 * honest: `AdminErrorState` takes `unknown` and does its own narrowing, and an
 * `any` threaded through four call sites is four places a property could be read
 * off a rejection that is not an Error at all.
 */
function causeOf(settled: PromiseRejectedResult): unknown {
  const cause: unknown = settled.reason;
  return cause;
}
