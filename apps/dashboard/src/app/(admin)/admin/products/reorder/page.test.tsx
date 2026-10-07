import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { productSchema, type Product } from "@akai/contracts";

import esMessages from "../../../../../../messages/es.json";

/**
 * The catalogue-wide reorder screen's server wiring.
 *
 * The row-level interaction (move up/down, save) has its own suite in
 * `product-reorder-list.test.tsx`; what is worth pinning here is what this
 * page fetches WITH — `sort: "manual"`, the full 100-row ceiling in one
 * request, never a paginated slice — and that a failed fetch renders the
 * shared error state instead of an unhandled rejection.
 */

const listProducts = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const { createTranslator } = await import("next-intl");
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
vi.mock("@/lib/admin/actions", () => ({
  reorderProductsAction: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));

const { default: ProductReorderPage } = await import("./page");

const ISO = "2026-07-20T10:00:00.000Z";

function product(id: string, variantId: string, name: string, sku: string): Product {
  return productSchema.parse({
    id,
    slug: name.toLowerCase(),
    status: "ACTIVE",
    taxClass: "STANDARD",
    name,
    shortDescription: "",
    description: "",
    variants: [
      {
        id: variantId,
        productId: id,
        sku,
        name: null,
        options: {},
        price: { currency: "EUR", net: 2471, tax: 519, gross: 2990, compareAtGross: null, taxRateBps: 2100 },
        weightGrams: 500,
        inventory: {
          variantId,
          onHand: 10,
          reserved: 0,
          available: 10,
          lowStockThreshold: 5,
          allowBackorder: false,
        },
        image: null,
        isActive: true,
        version: 0,
      },
    ],
    media: [],
    categories: [],
    restrictedCountries: [],
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  });
}

async function renderReorderPage() {
  const element = await ProductReorderPage();
  render(<NextIntlClientProvider locale="es" messages={esMessages}>{element}</NextIntlClientProvider>);
}

describe("ProductReorderPage", () => {
  it("fetches with sort=manual and the API's full ceiling — never a paginated slice", async () => {
    listProducts.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    await renderReorderPage();

    expect(listProducts).toHaveBeenCalledWith(expect.anything(), { sort: "manual", limit: 100 });
  });

  it("renders every fetched product as a reorder row", async () => {
    listProducts.mockResolvedValue({
      items: [
        product(
          "11111111-1111-4111-8111-111111111111",
          "11111111-1111-4111-8111-111111111112",
          "Camiseta",
          "AK-CRE",
        ),
        product(
          "22222222-2222-4222-8222-222222222222",
          "22222222-2222-4222-8222-222222222223",
          "Gorra",
          "AK-MAG",
        ),
      ],
      nextCursor: null,
      hasMore: false,
    });

    await renderReorderPage();

    expect(screen.getByText("Camiseta")).toBeInTheDocument();
    expect(screen.getByText("Gorra")).toBeInTheDocument();
  });

  it("renders the shared error state, not an unhandled rejection, when the fetch fails", async () => {
    listProducts.mockRejectedValue(new Error("upstream down"));

    await renderReorderPage();

    expect(screen.getByText(esMessages.admin.productReorder.loadErrorTitle)).toBeInTheDocument();
  });
});
