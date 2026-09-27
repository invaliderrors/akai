import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { productSchema, type Product } from "@akai/contracts";

import esMessages from "../../../../../../messages/es.json";

/**
 * The admin catalogue list.
 *
 * WHAT IS ACTUALLY UNDER TEST is the handful of things about this page that are
 * silent when they break:
 *
 *  1. THE ATTENTION ROW. It is one of exactly two sanctioned uses of the
 *     loudest treatment the product has, and it is gated on the product being
 *     ACTIVE — an archived product at zero available is nobody's problem. The
 *     BADGE is not gated, because zero is zero. Nothing but a screenshot would
 *     catch the two being confused, so the rail is asserted as markup here.
 *  2. The page fetches with the TOP of the cursor stack. Reading the first
 *     entry of the repeated param — which every admin list did before the stack
 *     landed — pins the operator to page two: the URL changes on Next and the
 *     rows do not.
 *  3. `available`, not `onHand`. Stock inside someone else's in-flight checkout
 *     is not available to sell, and the two differ by exactly the number that
 *     makes an operator over-promise.
 *  4. THERE IS NO SYNC COLUMN. The catalog mirror is deleted and the artboard
 *     still draws one, so the negative assertion is the guard against it being
 *     "restored" from a drawing.
 *
 * Rendered against the REAL Spanish catalogue rather than an identity
 * translator: the assertions are what an operator reads, and a fixture
 * translator is exactly the thing that keeps passing after somebody flattens
 * "Agotada" into a raw enum.
 */

const listProducts = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const { createTranslator } = await import("next-intl");
    // Widened deliberately. `createTranslator` infers a literal union of every
    // key in the catalogue, and a `namespace` typed `string` is not a member of
    // it — so the double is typed against the SHAPE of a message tree rather
    // than against this one, which is also what lets the two branches below
    // exist at all under `exactOptionalPropertyTypes`.
    const messages: Record<string, unknown> = esMessages;
    return namespace === undefined
      ? createTranslator({ locale: "es", messages })
      : createTranslator({ locale: "es", messages, namespace });
  },
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  listProducts: (http: unknown, params: unknown) => listProducts(http, params),
}));

vi.mock("@/i18n/navigation", () => ({
  // Every prop is forwarded, unlike the usual children-only stub: the row link
  // is named by an `aria-label`, and a stub that swallowed it would make the
  // accessible-name assertion below unfalsifiable.
  Link: (props: ComponentProps<"a">) => <a {...props} />,
}));

const { default: AdminProductsPage } = await import("./page");

const ISO = "2026-07-20T10:00:00.000Z";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";

interface VariantOverrides {
  readonly available?: number;
  readonly onHand?: number;
  readonly reserved?: number;
  readonly allowBackorder?: boolean;
  readonly gross?: number;
}

/**
 * Parsed through the contract rather than cast, so a fixture that has drifted
 * from `productSchema` fails HERE instead of passing against a shape the API can
 * no longer send.
 */
function product(
  overrides: Partial<Product> = {},
  variant: VariantOverrides = {},
): Product {
  return productSchema.parse({
    id: PRODUCT_ID,
    slug: "camiseta-oversize",
    status: "ACTIVE",
    taxClass: "STANDARD",
    translations: [
      {
        locale: "es",
        name: "Camiseta oversize",
        shortDescription: "Micronizada",
        description: "Algodón orgánico de 240 g/m².",
      },
    ],
    variants: [
      {
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: "AK-TEE-BLK-M",
        name: { es: "M" },
        options: {},
        price: {
          currency: "EUR",
          net: 2471,
          tax: 519,
          gross: variant.gross ?? 2990,
          compareAtGross: null,
          taxRateBps: 2100,
        },
        weightGrams: 500,
        inventory: {
          variantId: VARIANT_ID,
          onHand: variant.onHand ?? 150,
          reserved: variant.reserved ?? 8,
          available: variant.available ?? 142,
          lowStockThreshold: 40,
          allowBackorder: variant.allowBackorder ?? false,
        },
        image: null,
        isActive: true,
        version: 1,
      },
    ],
    media: [],
    categories: [],
    restrictedCountries: [],
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    ...overrides,
  });
}

function pageOf(items: readonly Product[], nextCursor: string | null = null) {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

async function renderPage(query: Record<string, string | string[] | undefined> = {}) {
  const ui = await AdminProductsPage({
    params: Promise.resolve({ locale: "es" }),
    searchParams: Promise.resolve(query),
  });
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

/** The row a product renders into, found by the cell that names it. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (row === null) {
    throw new Error(`no row rendered for ${name}`);
  }
  return row;
}

describe("AdminProductsPage", () => {
  beforeEach(() => {
    // Braced. `beforeEach(() => mock.mockReset())` returns the mock, which
    // Vitest then treats as a TEARDOWN callback and invokes after every test.
    listProducts.mockReset();
  });

  it("fetches with the TOP of the cursor stack, not the first entry", async () => {
    listProducts.mockResolvedValue(pageOf([product()]));

    await renderPage({ cursor: ["page-two", "page-three"] });

    expect(listProducts).toHaveBeenCalledTimes(1);
    expect(listProducts.mock.calls[0]?.[1]).toMatchObject({ cursor: "page-three" });
  });

  it("ignores a page size the pagination control cannot offer", async () => {
    listProducts.mockResolvedValue(pageOf([product()]));

    // 500 would be a 400 from the API — `paginationQuerySchema` clamps to 100 —
    // and would also make the footer's "mostrando 51–75" arithmetic a lie.
    await renderPage({ limit: "500" });

    expect(listProducts.mock.calls[0]?.[1]).toMatchObject({ limit: 25 });
  });

  it("drops a status the API would reject rather than passing it through", async () => {
    listProducts.mockResolvedValue(pageOf([product()]));

    await renderPage({ status: "PUBLISHED" });

    expect(listProducts.mock.calls[0]?.[1]).not.toHaveProperty("status");
  });

  it("shows AVAILABLE stock, not on-hand", async () => {
    listProducts.mockResolvedValue(
      pageOf([product({}, { onHand: 150, reserved: 8, available: 142 })]),
    );

    await renderPage();

    const row = within(rowFor("Camiseta oversize"));
    expect(row.getByText("142")).toBeInTheDocument();
    // 150 is on hand, and eight of them are already inside someone else's
    // checkout. Promising them is how a shop oversells.
    expect(row.queryByText("150")).toBeNull();
  });

  it("gives an ACTIVE product at zero available the attention row and its rail", async () => {
    listProducts.mockResolvedValue(
      pageOf([product({ status: "ACTIVE" }, { available: 0, onHand: 0, reserved: 0 })]),
    );

    await renderPage();

    const row = rowFor("Camiseta oversize");
    // The fill is on the row; the 3px rail is an inset shadow on its LEADING
    // CELL, because under `border-collapse: collapse` a row box does not paint
    // a box-shadow at all in Chrome or Safari.
    expect(row.className).toContain("--danger-fill");
    const leading = row.querySelector("td");
    expect(leading?.className).toContain("inset_3px_0_0_var(--attention-fill)");
    // And the state is named, not merely coloured.
    expect(within(row).getByText("Agotada")).toBeInTheDocument();
  });

  it("badges zero on an ARCHIVED product but does NOT give it the attention row", async () => {
    listProducts.mockResolvedValue(
      pageOf([
        product({ status: "ARCHIVED" }, { available: 0, onHand: 0, reserved: 0 }),
      ]),
    );

    await renderPage();

    const row = rowFor("Camiseta oversize");
    // The badge is unconditional — zero is zero — while the rail is spent only
    // where a customer can reach the listing and cannot buy it.
    expect(within(row).getByText("Agotada")).toBeInTheDocument();
    expect(row.className).not.toContain("--danger-fill");
    expect(row.querySelector("td")?.className).not.toContain("--attention-fill");
  });

  it("calls a backorder-enabled variant at zero what it is, which is still sellable", async () => {
    listProducts.mockResolvedValue(
      pageOf([
        product({}, { available: 0, onHand: 0, reserved: 0, allowBackorder: true }),
      ]),
    );

    await renderPage();

    const row = rowFor("Camiseta oversize");
    expect(within(row).getByText("Bajo pedido")).toBeInTheDocument();
    expect(row.className).not.toContain("--danger-fill");
  });

  it("falls back to another locale's name rather than rendering a blank cell", async () => {
    listProducts.mockResolvedValue(
      pageOf([
        product({
          id: "33333333-3333-4333-8333-333333333333",
          slug: "solo-ingles",
          translations: [
            { locale: "en", name: "English only", shortDescription: "", description: "" },
          ],
        }),
      ]),
    );

    await renderPage();

    // A product with only English copy is normal mid-translation, and a blank
    // row label is unusable.
    expect(screen.getByText("English only")).toBeInTheDocument();

    // The chain's third link — the slug — is DEFENSIVE ONLY and cannot be
    // exercised from the API: `productSchema.translations` is `.min(1)`, so a
    // fixture with none is rejected by the parse above rather than rendering.
    // It stays in the code because the cell must never be empty; it is not
    // asserted here because a test would have to fabricate an impossible
    // product to reach it.
  });

  it("renders the status as a translated badge and never the raw enum", async () => {
    listProducts.mockResolvedValue(
      pageOf([
        product(),
        product({
          id: "55555555-5555-4555-8555-555555555555",
          slug: "borrador",
          status: "DRAFT",
          translations: [
            { locale: "es", name: "Borrador de producto", shortDescription: "", description: "" },
          ],
        }),
      ]),
    );

    await renderPage();

    const table = within(screen.getByRole("table"));
    expect(table.getByText("Activo")).toBeInTheDocument();
    expect(table.getByText("Borrador")).toBeInTheDocument();
    expect(screen.queryByText("ACTIVE")).toBeNull();
    expect(screen.queryByText("DRAFT")).toBeNull();
  });

  it("has no sync column, because there is no mirror to report on", async () => {
    listProducts.mockResolvedValue(pageOf([product()]));

    await renderPage();

    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Nombre",
      "Slug",
      "Estado",
      "Variantes",
      "Precio desde",
      "Disponible",
    ]);
    expect(screen.queryByText(/sincroniza/i)).toBeNull();
  });

  it("names each row link with the product it opens", async () => {
    listProducts.mockResolvedValue(pageOf([product()]));

    await renderPage();

    const link = screen.getByRole("link", { name: "Editar Camiseta oversize" });
    expect(link).toHaveAttribute("href", `/admin/products/${PRODUCT_ID}`);
  });

  it("tells an operator with filters applied to clear them, not to create a product", async () => {
    listProducts.mockResolvedValue(pageOf([]));

    await renderPage({ search: "camiseta" });

    expect(screen.getByText(esMessages.admin.products.emptyFilteredBody)).toBeInTheDocument();
    expect(screen.queryByText(esMessages.admin.products.emptyFirstBody)).toBeNull();
  });
});
