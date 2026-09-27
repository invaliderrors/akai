import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryRowSchema, type InventoryRow } from "@akai/contracts";

import esMessages from "../../../../../../messages/es.json";

/**
 * The stock list.
 *
 * WHAT IS ACTUALLY UNDER TEST — the four facts this page can get wrong in ways
 * nobody would notice from a screenshot:
 *
 *  1. UNTRACKED IS NOT ZERO. A variant with no inventory record shows four
 *     em-dashes, not four zeros: sold out is fixed by restocking and this is
 *     fixed by creating the record, and a column of zeros says the first.
 *  2. THE FILTER IS PARSED AGAINST THE CLOSED ENUM. `?filter=` is user input
 *     off the address bar; an unrecognised value degrades to "all" rather than
 *     reaching the API as a 400 the operator cannot read.
 *  3. THE CURSOR IS THE TOP OF THE STACK. The stack is a repeated `cursor`
 *     param, one entry per page walked — taking the FIRST entry (which every
 *     admin list used to do) refetches page two forever.
 *  4. NO PRODUCT NAME IS A DATA DEFECT, SO THE SLUG SHOWS. A blank cell hides
 *     it; the slug makes the row identifiable and the defect visible.
 *
 * The server translator returns the KEY PATH it was asked for, so an assertion
 * names the catalogue entry rather than the Spanish behind it. The client half
 * runs against the real `es.json`, because the state badge is exactly where a
 * raw enum would leak.
 */

const listInventory = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  listInventory: (http: unknown, params: unknown) => listInventory(http, params),
}));

// The row action is the product page's own client dialog. Its server action is
// replaced at the module boundary (the real one pulls in the sealed session),
// and so is the router hook, which needs a mounted app router.
const adjustInventoryAction = vi.fn<(variantId: string, input: unknown) => Promise<unknown>>();
vi.mock("@/lib/admin/actions", () => ({
  adjustInventoryAction: (variantId: string, input: unknown) =>
    adjustInventoryAction(variantId, input),
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: AdminInventoryPage } = await import("./page");

const stock = esMessages.admin.productForm.stock;

/** Parsed through the contract, not cast to it. */
const ROWS: readonly InventoryRow[] = [
  inventoryRowSchema.parse({
    variantId: "11111111-1111-4111-8111-111111111111",
    sku: "AK-WHE-1K",
    productId: "aaaaaaaa-1111-4111-8111-111111111111",
    productSlug: "whey-isolate",
    productName: "Whey isolate 1 kg",
    tracked: true,
    onHand: 0,
    reserved: 0,
    available: 0,
    lowStockThreshold: 30,
    allowBackorder: false,
  }),
  inventoryRowSchema.parse({
    variantId: "22222222-2222-4222-8222-222222222222",
    sku: "AK-SHK-01",
    productId: "aaaaaaaa-2222-4222-8222-222222222222",
    productSlug: "shaker-700-ml",
    // No translation in ANY locale — the defect the slug fallback exposes.
    productName: null,
    tracked: false,
    onHand: 0,
    reserved: 0,
    available: 0,
    lowStockThreshold: 0,
    allowBackorder: false,
  }),
  inventoryRowSchema.parse({
    variantId: "33333333-3333-4333-8333-333333333333",
    sku: "AK-CRE-500",
    productId: "aaaaaaaa-3333-4333-8333-333333333333",
    productSlug: "creatina-monohidrato",
    productName: "Creatina monohidrato 500 g",
    tracked: true,
    // Five figures on purpose: es-ES groups from 10.000 up (CLDR's
    // `minimumGroupingDigits` is 2 for Spanish), so a four-digit fixture would
    // prove nothing about grouping at all.
    onHand: 16000,
    reserved: 1800,
    available: 14200,
    lowStockThreshold: 40,
    allowBackorder: false,
  }),
];

function pageOf(items: readonly InventoryRow[]) {
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
  const element = await AdminInventoryPage({
    params: Promise.resolve({ locale: "es" }),
    searchParams: Promise.resolve(query),
  });
  return renderPage(element);
}

function requestedParams(): Record<string, unknown> {
  const call = listInventory.mock.calls[0];
  if (call === undefined) {
    throw new Error("the page did not call listInventory");
  }
  const params = call[1];
  if (typeof params !== "object" || params === null) {
    throw new Error("listInventory was called without a params object");
  }
  return { ...params };
}

/** The row whose first cell holds this SKU. */
function rowFor(sku: string): HTMLElement {
  const cell = screen.getByText(sku);
  const row = cell.closest("tr");
  if (row === null) {
    throw new Error(`no row for ${sku}`);
  }
  return row;
}

describe("AdminInventoryPage", () => {
  beforeEach(() => {
    listInventory.mockReset();
    listInventory.mockResolvedValue(pageOf(ROWS));
    adjustInventoryAction.mockReset();
  });

  it("renders an untracked variant as four em-dashes, never as four zeros", async () => {
    await renderList();

    const untracked = within(rowFor("AK-SHK-01"));
    // On hand, reserved, available and threshold: all four, because a single
    // zero left among them reads as a stock level.
    expect(untracked.getAllByText("—")).toHaveLength(4);
    // Its state is a missing RECORD, not a stock level, and the badge says so.
    expect(untracked.getByText("Sin registro")).toBeInTheDocument();
  });

  it("shows the slug when a product has no name in any locale", async () => {
    await renderList();

    expect(within(rowFor("AK-SHK-01")).getByText("shaker-700-ml")).toBeInTheDocument();
  });

  it("badges zero available as the state an operator has to act on", async () => {
    await renderList();

    // From `lib/status`, unconditionally: the tone is the loudest the product
    // draws, and it is spelt out in words as well as in colour.
    expect(within(rowFor("AK-WHE-1K")).getByText("Agotada")).toBeInTheDocument();
  });

  it("groups counts in the reader's locale rather than printing bare integers", async () => {
    await renderList();

    expect(within(rowFor("AK-CRE-500")).getByText("16.000")).toBeInTheDocument();
    expect(within(rowFor("AK-CRE-500")).getByText("14.200")).toBeInTheDocument();
  });

  it("degrades an unrecognised filter to 'all' instead of sending it", async () => {
    await renderList({ filter: "atencion" });

    // "Atención" is the union low ∪ out ∪ untracked and the query takes ONE
    // member, so it is not a filter this API can answer — and a value off the
    // address bar must never reach it as a validation failure.
    expect(requestedParams()["filter"]).toBe("all");
  });

  it("passes a real filter and search through", async () => {
    await renderList({ filter: "out", search: "whe" });

    const params = requestedParams();
    expect(params["filter"]).toBe("out");
    expect(params["search"]).toBe("whe");
  });

  it("fetches with the TOP of the cursor stack, not its first entry", async () => {
    await renderList({ cursor: ["AK-AAA-001", "AK-BBB-002"] });

    // The stack is the history: one entry per page walked. Reading the first
    // would pin the operator to page two however far they paged.
    expect(requestedParams()["cursor"]).toBe("AK-BBB-002");
  });

  it("gives every row an Adjust action that opens the stock dialog for THAT variant", async () => {
    const user = userEvent.setup();
    await renderList();

    const row = within(rowFor("AK-CRE-500"));
    await user.click(row.getByRole("button", { name: stock.adjust }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(stock.title.replace("{sku}", "AK-CRE-500")),
    ).toBeInTheDocument();
    // The counts the dialog computes its delta from are this row's.
    expect(within(dialog).getByText("16000")).toBeInTheDocument();
    expect(within(dialog).getByText("1800")).toBeInTheDocument();
  });

  it("lets an untracked row be adjusted, sending the zero it displayed as the expectation", async () => {
    // Untracked means "no stock yet", not "cannot be stocked": the API creates
    // the record on the first adjustment.
    adjustInventoryAction.mockResolvedValue({ ok: true, data: null });
    const user = userEvent.setup();
    await renderList();

    await user.click(within(rowFor("AK-SHK-01")).getByRole("button", { name: stock.adjust }));
    const dialog = await screen.findByRole("dialog");
    const target = within(dialog).getByLabelText(stock.targetLabel);
    await user.clear(target);
    await user.type(target, "24");
    await user.click(within(dialog).getByRole("button", { name: stock.confirm }));

    expect(adjustInventoryAction).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", {
      delta: 24,
      reason: "STOCK_COUNT",
      expectedOnHand: 0,
    });
  });

  it("clamps a page size the contract would reject", async () => {
    await renderList({ limit: "5000" });

    // `paginationQuerySchema` is 1..100. An out-of-range limit falls back
    // rather than 400ing with the operator's filters lost.
    expect(requestedParams()["limit"]).toBe(50);
  });
});
