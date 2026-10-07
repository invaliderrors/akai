import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminDiscountSchema, type AdminDiscount } from "@/lib/admin/schemas";

import esMessages from "../../../../../messages/es.json";

/**
 * The coupon list, and the editor for the row an operator opened.
 *
 * WHAT IS ACTUALLY UNDER TEST:
 *
 *  1. SELECTION IS A URL PARAMETER. `?edit=<id>` opens the editor below the
 *     table and nothing else does — which is what makes the open record
 *     survive a reload, a share and the back button, and what keeps this page
 *     a server component.
 *  2. A SELECTION THAT IS NOT ON THIS PAGE OPENS NOTHING. A stale link must not
 *     produce an editor for a record the operator cannot see in the table.
 *  3. `value` IS OVERLOADED AND FREE_SHIPPING HAS NONE. The cell reads as "not
 *     applicable", never as a figure somebody forgot to enter.
 *  4. NO RAW ENUM REACHES AN OPERATOR. The state is derived (the API has no
 *     status column) and badged through the shared `status` vocabulary.
 *  5. THE CURSOR IS THE TOP OF THE STACK, and the archived filter is what the
 *     API is actually asked for.
 *
 * The server translator returns the KEY PATH it was asked for, so an assertion
 * names the catalogue entry rather than the Spanish behind it. The client half
 * runs against the real `es.json` — the state badge is exactly where a raw enum
 * would leak.
 */

const listDiscounts = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  listDiscounts: (http: unknown, params: unknown) => listDiscounts(http, params),
  // Only fetched so `DiscountEditor` can render an affiliate picker — mocked
  // away below, so the response shape here is not itself under test.
  listAffiliates: async () => ({ items: [], hasMore: false, nextCursor: null }),
}));

/**
 * The editor is a client boundary over three server actions. It has its own
 * suite; here it stands in for itself, so this file stays about the LIST and
 * about which record the page decided to open.
 */
vi.mock("@/components/admin/discount-editor", () => ({
  DiscountEditor: () => <div>editor</div>,
}));

const { default: AdminDiscountsPage } = await import("./page");

const SUMMER_ID = "11111111-1111-4111-8111-111111111111";
const SHIPPING_ID = "22222222-2222-4222-8222-222222222222";
const BLACK_FRIDAY_ID = "33333333-3333-4333-8333-333333333333";

/** Parsed through the response schema, not cast to it. */
const DISCOUNTS: readonly AdminDiscount[] = [
  adminDiscountSchema.parse({
    id: SUMMER_ID,
    code: "VERANO26",
    type: "PERCENTAGE",
    value: 1500,
    minimumSubtotal: 5000,
    currency: "EUR",
    maxRedemptions: 500,
    maxRedemptionsPerCustomer: 1,
    timesRedeemed: 184,
    remainingRedemptions: 316,
    stackable: false,
    startsAt: null,
    endsAt: "2099-09-30T22:00:00.000Z",
    affiliateId: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    deletedAt: null,
  }),
  adminDiscountSchema.parse({
    id: SHIPPING_ID,
    code: "ENVIOGRATIS",
    type: "FREE_SHIPPING",
    value: 0,
    minimumSubtotal: null,
    currency: null,
    // Uncapped: no meter, and the count still groups in the reader's locale.
    // Five figures, because es-ES groups from 10.000 up (CLDR gives Spanish a
    // `minimumGroupingDigits` of 2) — the artboard's own "1.042" is not what
    // Intl produces for this locale, and a four-digit fixture would prove
    // nothing either way.
    maxRedemptions: null,
    maxRedemptionsPerCustomer: null,
    timesRedeemed: 10420,
    remainingRedemptions: null,
    stackable: true,
    startsAt: null,
    endsAt: null,
    affiliateId: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    deletedAt: null,
  }),
  adminDiscountSchema.parse({
    id: BLACK_FRIDAY_ID,
    code: "BLACKFRIDAY25",
    type: "FIXED_AMOUNT",
    value: 1000,
    minimumSubtotal: null,
    currency: "EUR",
    maxRedemptions: 2500,
    maxRedemptionsPerCustomer: null,
    timesRedeemed: 2310,
    remainingRedemptions: 190,
    stackable: false,
    startsAt: null,
    // Long past: the derived state is EXPIRED, which no column stores.
    endsAt: "2025-12-02T10:00:00.000Z",
    affiliateId: null,
    createdAt: "2025-11-01T10:00:00.000Z",
    updatedAt: "2025-12-03T10:00:00.000Z",
    deletedAt: null,
  }),
];

function pageOf(items: readonly AdminDiscount[]) {
  return { items, nextCursor: null, hasMore: false };
}

function renderPage(element: ReactElement) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {element}
    </NextIntlClientProvider>,
  );
}

async function renderList(query: Record<string, string | string[] | undefined> = {}) {
  const element = await AdminDiscountsPage({
    searchParams: Promise.resolve(query),
  });
  return renderPage(element);
}

function requestedParams(): Record<string, unknown> {
  const call = listDiscounts.mock.calls[0];
  if (call === undefined) {
    throw new Error("the page did not call listDiscounts");
  }
  const params = call[1];
  if (typeof params !== "object" || params === null) {
    throw new Error("listDiscounts was called without a params object");
  }
  return { ...params };
}

/**
 * The TABLE row for a code — scoped to the table on purpose, because the open
 * editor's panel heading carries the same code and an unscoped query would
 * match both.
 */
function rowFor(code: string): HTMLElement {
  const cell = within(screen.getByRole("table")).getByText(code);
  const row = cell.closest("tr");
  if (row === null) {
    throw new Error(`no row for ${code}`);
  }
  return row;
}

describe("AdminDiscountsPage", () => {
  beforeEach(() => {
    listDiscounts.mockReset();
    listDiscounts.mockResolvedValue(pageOf(DISCOUNTS));
  });

  it("opens no editor until a row is selected", async () => {
    await renderList();

    expect(screen.queryByRole("region", { name: "VERANO26" })).toBeNull();
  });

  it("opens the editor for the record named in the URL", async () => {
    await renderList({ edit: SUMMER_ID });

    // The panel names itself after the code, so an operator can see which
    // record the form below the table belongs to.
    expect(screen.getByRole("region", { name: "VERANO26" })).toBeInTheDocument();
  });

  it("opens nothing for a selection that is not on this page", async () => {
    // A stale link, or a code the archived filter dropped. An editor for a row
    // the operator cannot see above it is worse than no editor.
    await renderList({ edit: "99999999-9999-4999-8999-999999999999" });

    expect(screen.queryByRole("region", { name: "VERANO26" })).toBeNull();
    expect(screen.queryByText("editor")).toBeNull();
  });

  it("turns the selected row's code from a link into plain text", async () => {
    await renderList({ edit: SUMMER_ID });

    // The open row's code is already where it leads, and a link to the page you
    // are on is a dead control. Every other row still opens from its code —
    // named with a verb, because "VERANO26" alone tells a screen-reader user
    // nothing about what the link does.
    expect(
      within(rowFor("VERANO26")).queryByRole("link", { name: "admin.discounts.editRow" }),
    ).toBeNull();
    expect(
      within(rowFor("ENVIOGRATIS")).getByRole("link", { name: "admin.discounts.editRow" }),
    ).toBeInTheDocument();
  });

  it("keeps a way through to the full record on every row", async () => {
    await renderList({ edit: SUMMER_ID });

    // The detail route carries the usage figures and the archived notice the
    // inline panel has no room for, and it is where a newly created code lands.
    expect(within(rowFor("VERANO26")).getByRole("link", { name: "ui.view" })).toHaveAttribute(
      "href",
      `/admin/discounts/${SUMMER_ID}`,
    );
  });

  it("renders no value for free shipping, and never a bare zero", async () => {
    await renderList();

    // `value` is overloaded by `type`: 0 here would read as "no discount".
    expect(within(rowFor("ENVIOGRATIS")).getByText("—")).toBeInTheDocument();
  });

  it("says 'unlimited' rather than drawing a meter with no cap", async () => {
    await renderList();

    expect(
      within(rowFor("ENVIOGRATIS")).getByText("10.420 · admin.discounts.unlimited"),
    ).toBeInTheDocument();
  });

  it("badges the DERIVED state, never a raw column the API does not have", async () => {
    await renderList();

    // Translated through the shared `status` vocabulary: ACTIVE and EXPIRED are
    // computed here from the window and the remaining redemptions.
    expect(within(rowFor("VERANO26")).getByText("Activo")).toBeInTheDocument();
    expect(within(rowFor("BLACKFRIDAY25")).getByText("Caducado")).toBeInTheDocument();
  });

  it("asks the API for archived codes only when the filter says so", async () => {
    await renderList();
    expect(requestedParams()["includeDeleted"]).toBe(false);

    listDiscounts.mockClear();
    await renderList({ includeDeleted: "true" });
    expect(requestedParams()["includeDeleted"]).toBe(true);
  });

  it("fetches with the TOP of the cursor stack, not its first entry", async () => {
    await renderList({ cursor: ["cursor-page-2", "cursor-page-3"] });

    expect(requestedParams()["cursor"]).toBe("cursor-page-3");
  });
});
