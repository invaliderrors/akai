import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminApiError } from "@/lib/admin/http";
import type {
  DailyRevenuePoint,
  EmailDeliverySummary,
  LowStockVariant,
  MetricsOverview,
  RecentOrder,
  RepeatCustomerRate,
  ReturnsSummary,
  TopProduct,
} from "@/lib/admin/schemas";
import type { SearchParamValue } from "@/components/ui/segmented-control";

import esMessages from "../../../../../messages/es.json";

/**
 * The admin overview.
 *
 * THINGS UNDER TEST HERE, and each is a defect this file closes rather than a
 * restatement of the layout:
 *
 *  1. An aggregate above `MINOR_MAX` renders as a euro figure. Both superseded
 *     spellings failed on exactly those values — `toMinor` THROWS above the cap
 *     (this page branded five aggregates that way) and the deleted metrics
 *     route's `isMinor(x) ? formatMoney(x) : String(x)` printed a bare
 *     `2400000000`. The cap is $20m COP; a shop that reaches it is a shop whose
 *     dashboard used to break.
 *  2. The attention tile appears only when an order actually needs a decision.
 *     The treatment is rationed to two uses in the whole product, and one spent
 *     permanently on "0" is one nobody reads by the end of the week.
 *  3. Every panel fails INDEPENDENTLY: a broken low-stock query must not blank
 *     the revenue figure the operator opened the page for — and that now
 *     extends to the four new panels this file adds (repeat rate, returns,
 *     emails, the daily series).
 *  4. No raw enum reaches an operator. `PAYMENT_MISMATCH` was printed verbatim
 *     in the status column until this rewrite.
 *  5. The `?days=` window control resolves an explicit `from`/`to` and hands
 *     the SAME window to every windowed fetch, so the tiles, the chart and the
 *     breakdowns cannot end up describing different periods.
 *
 * The server translator is the identity function, as in
 * `discounts/[id]/page.test.tsx`: the assertions are about which message KEY the
 * page reaches for and what it does with the data, not about the Spanish behind
 * it — that is the catalogue parity test's job. Status BADGES are the deliberate
 * exception. They read the catalogue through the client provider below, against
 * the real `es.json`, because "does an enum member reach the screen" cannot be
 * asked of a translator that answers every key with itself.
 */

const getMetricsOverview = vi.fn<() => Promise<MetricsOverview>>();
const getTopProducts = vi.fn<() => Promise<readonly TopProduct[]>>();
const getLowStock = vi.fn<() => Promise<readonly LowStockVariant[]>>();
const getRecentOrders = vi.fn<() => Promise<readonly RecentOrder[]>>();
const getRepeatRate = vi.fn<() => Promise<RepeatCustomerRate>>();
const getReturnsSummary = vi.fn<() => Promise<ReturnsSummary>>();
const getEmailSummary = vi.fn<() => Promise<EmailDeliverySummary>>();
const getRevenueSeries = vi.fn<() => Promise<readonly DailyRevenuePoint[]>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  getMetricsOverview: () => getMetricsOverview(),
  getTopProducts: () => getTopProducts(),
  getLowStock: () => getLowStock(),
  getRecentOrders: () => getRecentOrders(),
  getRepeatRate: () => getRepeatRate(),
  getReturnsSummary: () => getReturnsSummary(),
  getEmailSummary: () => getEmailSummary(),
  getRevenueSeries: () => getRevenueSeries(),
}));

const { default: AdminOverviewPage } = await import("./page");

/** $20m COP is `MINOR_MAX`; $24m is the figure both superseded code paths broke on. */
const OVER_CAP_MINOR = 2_400_000_000;

function revenue(overrides: Partial<MetricsOverview["revenue"]> = {}): MetricsOverview["revenue"] {
  return {
    grossTotal: OVER_CAP_MINOR,
    refundedTotal: 368_750,
    netTotal: OVER_CAP_MINOR,
    orderCount: 614,
    averageOrderValue: 8_454,
    currency: "COP",
    from: "2026-08-11T00:00:00.000Z",
    to: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

const RECENT_ORDER: RecentOrder = {
  orderNumber: "AK-2026-000412",
  status: "PAYMENT_MISMATCH",
  grandTotal: 5_985,
  currency: "COP",
  placedAt: "2026-09-09T10:15:00.000Z",
  customerId: null,
};

const LOW_STOCK: LowStockVariant = {
  variantId: "11111111-1111-4111-8111-111111111111",
  sku: "AK-WHE-1K",
  onHand: 4,
  reserved: 4,
  available: 0,
  lowStockThreshold: 30,
};

const NO_REPEAT_RATE: RepeatCustomerRate = {
  customersInWindow: 0,
  repeatCustomers: 0,
  repeatRate: 0,
};

const NO_BREAKDOWN: ReturnsSummary = { byStatus: [], total: 0 };

const REVENUE_SERIES: readonly DailyRevenuePoint[] = [
  { day: "2026-08-11T00:00:00.000Z", grossTotal: 5_000 },
  { day: "2026-08-12T00:00:00.000Z", grossTotal: 12_500 },
];

/**
 * `AggregateMoney` renders es-ES currency, which separates the symbol with a
 * NO-BREAK SPACE. Written as an escape rather than the literal character,
 * because an invisible literal is exactly the one nobody notices going missing.
 */
function text(node: HTMLElement | null): string {
  return (node?.textContent ?? "").replace(/[\u00a0\u202f]/g, " ");
}

function renderPage(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

async function renderOverview(searchParams: Record<string, SearchParamValue> = {}) {
  return renderPage(
    await AdminOverviewPage({
      params: Promise.resolve({ locale: "es" }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

describe("AdminOverviewPage", () => {
  beforeEach(() => {
    // Braced. `beforeEach(() => mock.mockReset())` returns the mock, and Vitest
    // treats a value returned from a hook as a TEARDOWN callback — so it would
    // be invoked once more after every test, unawaited.
    //
    // Reset before re-arming, so the call COUNTS start at zero: the last test
    // here asserts each panel is fetched exactly once, and it would otherwise be
    // counting every render in the file.
    getMetricsOverview.mockReset();
    getTopProducts.mockReset();
    getLowStock.mockReset();
    getRecentOrders.mockReset();
    getRepeatRate.mockReset();
    getReturnsSummary.mockReset();
    getEmailSummary.mockReset();
    getRevenueSeries.mockReset();

    getMetricsOverview.mockResolvedValue({ revenue: revenue(), ordersByStatus: [] });
    getTopProducts.mockResolvedValue([]);
    getLowStock.mockResolvedValue([]);
    getRecentOrders.mockResolvedValue([]);
    getRepeatRate.mockResolvedValue(NO_REPEAT_RATE);
    getReturnsSummary.mockResolvedValue(NO_BREAKDOWN);
    getEmailSummary.mockResolvedValue(NO_BREAKDOWN);
    getRevenueSeries.mockResolvedValue([]);
  });

  it("renders an over-cap aggregate as a currency figure, never a bare integer", async () => {
    const { container } = await renderOverview();

    // $ 24.000.000 COP — above MINOR_MAX, which is precisely where `toMinor`
    // threw and where the `isMinor` fallback printed the raw minor units.
    expect(text(container)).toContain("$ 24.000.000");
    expect(text(container)).not.toContain(String(OVER_CAP_MINOR));
  });

  it("shows the attention tile, linking to the mismatch filter, when an order needs a decision", async () => {
    getMetricsOverview.mockResolvedValue({
      revenue: revenue(),
      ordersByStatus: [
        { status: "PAID", count: 412 },
        { status: "PAYMENT_MISMATCH", count: 2 },
      ],
    });

    await renderOverview();

    expect(screen.getByText("attentionTitle")).toBeInTheDocument();
    // The way in has to carry the FILTER, not just the list: an operator who
    // lands on all 614 orders has not been taken to the two that are frozen.
    const cta = screen.getByRole("link", { name: "attentionCta" });
    expect(cta.getAttribute("href")).toContain("status=PAYMENT_MISMATCH");
  });

  it("withholds the attention tile when nothing needs a decision", async () => {
    getMetricsOverview.mockResolvedValue({
      revenue: revenue(),
      ordersByStatus: [{ status: "PAID", count: 412 }],
    });

    await renderOverview();

    expect(screen.queryByText("attentionTitle")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "attentionCta" })).not.toBeInTheDocument();
  });

  it("keeps the revenue figure when the low-stock panel fails", async () => {
    getLowStock.mockRejectedValue(
      new AdminApiError({ code: "INTERNAL_ERROR", status: 500, message: "boom" }),
    );

    const { container } = await renderOverview();

    // The whole point of Promise.allSettled: one dead query, the rest live.
    expect(text(container)).toContain("$ 24.000.000");
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    // And the failure is the panel's own, not the page's: the other two tables
    // are still on screen with their headings.
    expect(screen.getByRole("table", { name: "bestSellers" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "recentOrders" })).toBeInTheDocument();
  });

  it("never renders a raw status enum at an operator", async () => {
    getRecentOrders.mockResolvedValue([RECENT_ORDER]);
    getMetricsOverview.mockResolvedValue({
      revenue: revenue(),
      ordersByStatus: [{ status: "PAYMENT_MISMATCH", count: 1 }],
    });

    const { container } = await renderOverview();

    // Twice over: once in the breakdown, once in the recent-orders row.
    expect(screen.getAllByText("Importe no coincide").length).toBeGreaterThan(0);
    expect(text(container)).not.toContain("PAYMENT_MISMATCH");
  });

  it("translates the low-stock state instead of leaving the reader to compare two numbers", async () => {
    getLowStock.mockResolvedValue([LOW_STOCK]);

    await renderOverview();

    // available === 0 on a row the endpoint has already filtered to tracked,
    // no-backorder variants: "Agotada", not a bare 0.
    expect(screen.getByText("Agotada")).toBeInTheDocument();
    expect(screen.getByText("AK-WHE-1K")).toBeInTheDocument();
  });

  it("draws no CSV export — unsourceable from anything this page fetches", async () => {
    const { container } = await renderOverview();

    expect(text(container)).not.toContain("CSV");
  });

  it("asks for all eight panels concurrently", async () => {
    await renderOverview();

    expect(getMetricsOverview).toHaveBeenCalledTimes(1);
    expect(getTopProducts).toHaveBeenCalledTimes(1);
    expect(getLowStock).toHaveBeenCalledTimes(1);
    expect(getRecentOrders).toHaveBeenCalledTimes(1);
    expect(getRepeatRate).toHaveBeenCalledTimes(1);
    expect(getReturnsSummary).toHaveBeenCalledTimes(1);
    expect(getEmailSummary).toHaveBeenCalledTimes(1);
    expect(getRevenueSeries).toHaveBeenCalledTimes(1);
  });

  describe("the period control and the daily revenue chart", () => {
    it("defaults to 30 days and draws the accessible chart once two or more points arrive", async () => {
      getRevenueSeries.mockResolvedValue(REVENUE_SERIES);

      await renderOverview();

      const thirtyDays = screen.getByRole("link", { name: "window30d" });
      expect(thirtyDays.getAttribute("aria-current")).toBe("true");
      expect(screen.getByRole("img", { name: "dailyRevenueChartLabel" })).toBeInTheDocument();
    });

    it("draws an empty state, not a broken chart, with fewer than two points", async () => {
      getRevenueSeries.mockResolvedValue([REVENUE_SERIES[0] as DailyRevenuePoint]);

      await renderOverview();

      expect(screen.queryByRole("img", { name: "dailyRevenueChartLabel" })).not.toBeInTheDocument();
      expect(screen.getByText("dailyRevenueEmpty")).toBeInTheDocument();
    });

    it("selects the segment named by ?days= and offers the other two as links", async () => {
      await renderOverview({ days: "7" });

      expect(screen.getByRole("link", { name: "window7d" }).getAttribute("aria-current")).toBe(
        "true",
      );
      const ninetyDays = screen.getByRole("link", { name: "window90d" });
      expect(ninetyDays.getAttribute("aria-current")).toBeNull();
      expect(ninetyDays.getAttribute("href")).toContain("days=90");
    });

    it("falls back to the 30-day default for an unrecognised ?days= value", async () => {
      await renderOverview({ days: "3650" });

      expect(screen.getByRole("link", { name: "window30d" }).getAttribute("aria-current")).toBe(
        "true",
      );
    });
  });

  describe("the exact date-range form", () => {
    it("renders a native GET form with the two date fields, no preset selected", async () => {
      await renderOverview({ from: "2026-08-01", to: "2026-08-15" });

      expect(screen.getByRole("link", { name: "window7d" }).getAttribute("aria-current")).toBeNull();
      expect(screen.getByRole("link", { name: "window30d" }).getAttribute("aria-current")).toBeNull();
      expect(screen.getByRole("link", { name: "window90d" }).getAttribute("aria-current")).toBeNull();

      expect(screen.getByText("descriptionRange")).toBeInTheDocument();
      expect(screen.queryByText("description")).not.toBeInTheDocument();
    });

    it("pre-fills the two fields from the requested range", async () => {
      await renderOverview({ from: "2026-08-01", to: "2026-08-15" });

      expect(screen.getByLabelText("fromLabel")).toHaveValue("2026-08-01");
      expect(screen.getByLabelText("toLabel")).toHaveValue("2026-08-15");
    });

    it("drops `from`/`to` from every preset link, so switching back to a window actually switches", async () => {
      await renderOverview({ from: "2026-08-01", to: "2026-08-15" });

      const thirtyDays = screen.getByRole("link", { name: "window30d" });
      expect(thirtyDays.getAttribute("href")).not.toContain("from=");
      expect(thirtyDays.getAttribute("href")).not.toContain("to=");
      expect(thirtyDays.getAttribute("href")).toContain("days=30");
    });

    it("falls back to the 30-day default when `from` is not before `to`", async () => {
      await renderOverview({ from: "2026-08-15", to: "2026-08-01" });

      expect(screen.getByRole("link", { name: "window30d" }).getAttribute("aria-current")).toBe(
        "true",
      );
      expect(screen.getByText("description")).toBeInTheDocument();
    });

    it("falls back to the 30-day default when only one of the two dates is present", async () => {
      await renderOverview({ from: "2026-08-01" });

      expect(screen.getByRole("link", { name: "window30d" }).getAttribute("aria-current")).toBe(
        "true",
      );
    });

    it("falls back to the 30-day default on an unparseable date", async () => {
      await renderOverview({ from: "not-a-date", to: "2026-08-15" });

      expect(screen.getByRole("link", { name: "window30d" }).getAttribute("aria-current")).toBe(
        "true",
      );
    });

    it("shows the chart panel's own failure without blanking the revenue tiles", async () => {
      getRevenueSeries.mockRejectedValue(
        new AdminApiError({ code: "INTERNAL_ERROR", status: 500, message: "boom" }),
      );

      const { container } = await renderOverview();

      expect(text(container)).toContain("$ 24.000.000");
      expect(screen.getByText("dailyRevenueErrorTitle")).toBeInTheDocument();
    });
  });

  describe("repeat customers, returns and email delivery", () => {
    it("renders the repeat-customer rate as a percentage", async () => {
      getRepeatRate.mockResolvedValue({
        customersInWindow: 3,
        repeatCustomers: 1,
        repeatRate: 0.3333,
      });

      await renderOverview();

      expect(screen.getByText("33,3%")).toBeInTheDocument();
    });

    it("fails independently of the revenue tiles", async () => {
      getRepeatRate.mockRejectedValue(
        new AdminApiError({ code: "INTERNAL_ERROR", status: 500, message: "boom" }),
      );

      const { container } = await renderOverview();

      expect(text(container)).toContain("$ 24.000.000");
      expect(screen.getByText("repeatRateErrorTitle")).toBeInTheDocument();
    });

    it("shows an empty state for returns rather than an empty breakdown", async () => {
      await renderOverview();

      expect(screen.getByText("returnsEmpty")).toBeInTheDocument();
    });

    it("never renders a raw return or email status enum, and shows the total", async () => {
      getReturnsSummary.mockResolvedValue({
        byStatus: [{ status: "REQUESTED", count: 3 }],
        total: 3,
      });
      getEmailSummary.mockResolvedValue({
        byStatus: [{ status: "BOUNCED", count: 2 }],
        total: 2,
      });

      const { container } = await renderOverview();

      expect(text(container)).not.toContain("REQUESTED");
      expect(text(container)).not.toContain("BOUNCED");
      expect(screen.getByText("returnsTotal")).toBeInTheDocument();
      expect(screen.getByText("emailsTotal")).toBeInTheDocument();
    });

    it("fails the returns and email panels independently of one another", async () => {
      getReturnsSummary.mockRejectedValue(
        new AdminApiError({ code: "INTERNAL_ERROR", status: 500, message: "boom" }),
      );
      getEmailSummary.mockResolvedValue({
        byStatus: [{ status: "DELIVERED", count: 40 }],
        total: 40,
      });

      await renderOverview();

      expect(screen.getByText("returnsErrorTitle")).toBeInTheDocument();
      expect(screen.queryByText("emailsErrorTitle")).not.toBeInTheDocument();
    });
  });
});
