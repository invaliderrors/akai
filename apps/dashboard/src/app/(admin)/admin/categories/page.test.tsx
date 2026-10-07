import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import esMessages from "../../../../../messages/es.json";

/**
 * The category admin screen's server wiring.
 *
 * The row-level interaction (create, rename, reorder, delete) has its own
 * suite in `category-manager.test.tsx`; what is worth pinning here is that
 * this page reads through `GET /admin/categories` and that a failed fetch
 * renders the shared error state instead of an unhandled rejection.
 */

const listCategories = vi.fn<(http: unknown) => Promise<unknown>>();

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
  listCategories: (http: unknown) => listCategories(http),
}));
vi.mock("@/lib/admin/actions", () => ({
  createCategoryAction: vi.fn(),
  updateCategoryAction: vi.fn(),
  reorderCategoriesAction: vi.fn(),
  deleteCategoryAction: vi.fn(),
}));

const { default: AdminCategoriesPage } = await import("./page");

async function renderCategoriesPage() {
  const element = await AdminCategoriesPage();
  render(<NextIntlClientProvider locale="es" messages={esMessages}>{element}</NextIntlClientProvider>);
}

describe("AdminCategoriesPage", () => {
  it("fetches the admin category list", async () => {
    listCategories.mockResolvedValue({ items: [] });

    await renderCategoriesPage();

    expect(listCategories).toHaveBeenCalledWith(expect.anything());
  });

  it("renders every fetched category as a row", async () => {
    listCategories.mockResolvedValue({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "recuperacion",
          name: "Recuperación",
          sortOrder: 0,
          productCount: 4,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          slug: "rendimiento",
          name: "Rendimiento",
          sortOrder: 1,
          productCount: 0,
        },
      ],
    });

    await renderCategoriesPage();

    expect(screen.getByText("Recuperación")).toBeInTheDocument();
    expect(screen.getByText("Rendimiento")).toBeInTheDocument();
  });

  it("renders the shared error state, not an unhandled rejection, when the fetch fails", async () => {
    listCategories.mockRejectedValue(new Error("upstream down"));

    await renderCategoriesPage();

    expect(screen.getByText(esMessages.admin.categoryManager.loadErrorTitle)).toBeInTheDocument();
  });
});
