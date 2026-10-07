import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminAffiliateSchema, type AdminAffiliate } from "@/lib/admin/schemas";
import { AdminApiError } from "@/lib/admin/http";

import esMessages from "../../../../../messages/es.json";

/**
 * The affiliate list. Mirrors `admin/customers/page.test.tsx`'s own shape —
 * a read-only list with no inline editor — for the reasons that page's own
 * doc comment gives for its identical structure.
 */

const listAffiliates = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

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
  listAffiliates: (http: unknown, params: unknown) => listAffiliates(http, params),
}));

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));

const { default: AdminAffiliatesPage } = await import("./page");

const ISO = "2026-07-20T10:00:00.000Z";

function affiliate(overrides: Partial<AdminAffiliate> = {}): AdminAffiliate {
  return adminAffiliateSchema.parse({
    id: "88888888-8888-4888-8888-888888888888",
    name: "Ana",
    country: "ES",
    socialHandle: "@ana",
    email: "ana@example.com",
    discountCodes: ["SAVE10"],
    redemptionCount: 3,
    revenueMinor: 14997,
    hasLogin: false,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    ...overrides,
  });
}

function pageOf(items: readonly AdminAffiliate[], nextCursor: string | null = null) {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

async function renderPage(query: Record<string, string | string[] | undefined> = {}) {
  const ui = await AdminAffiliatesPage({
    searchParams: Promise.resolve(query),
  });
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("AdminAffiliatesPage", () => {
  beforeEach(() => {
    listAffiliates.mockReset();
  });

  it("fetches with the TOP of the cursor stack, not the first entry", async () => {
    listAffiliates.mockResolvedValue(pageOf([affiliate()]));

    await renderPage({ cursor: ["page-two", "page-three"] });

    expect(listAffiliates.mock.calls[0]?.[1]).toMatchObject({ cursor: "page-three" });
  });

  it("asks the API for archived affiliates only when the filter says so", async () => {
    listAffiliates.mockResolvedValue(pageOf([affiliate()]));

    await renderPage({});
    expect(listAffiliates.mock.calls[0]?.[1]).toMatchObject({ includeDeleted: false });

    listAffiliates.mockClear();
    listAffiliates.mockResolvedValue(pageOf([affiliate()]));
    await renderPage({ includeDeleted: "true" });
    expect(listAffiliates.mock.calls[0]?.[1]).toMatchObject({ includeDeleted: true });
  });

  it("ignores a page size the pagination control cannot offer", async () => {
    listAffiliates.mockResolvedValue(pageOf([affiliate()]));

    await renderPage({ limit: "500" });

    expect(listAffiliates.mock.calls[0]?.[1]).toMatchObject({ limit: 25 });
  });

  it("names each row link with the affiliate it opens", async () => {
    listAffiliates.mockResolvedValue(pageOf([affiliate()]));

    await renderPage();

    const link = screen.getByRole("link", { name: "Ver el afiliado Ana" });
    expect(link).toHaveAttribute(
      "href",
      "/admin/affiliates/88888888-8888-4888-8888-888888888888",
    );
  });

  it("shows the assigned coupons, or an em dash when there are none", async () => {
    listAffiliates.mockResolvedValue(
      pageOf([
        affiliate({ discountCodes: ["SAVE10", "SUMMER20"] }),
        affiliate({
          id: "99999999-9999-4999-8999-999999999999",
          name: "Iker",
          discountCodes: [],
        }),
      ]),
    );

    await renderPage();

    expect(screen.getByText("SAVE10, SUMMER20")).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("—")).toBeInTheDocument();
  });

  it("badges the state, active or archived, never a raw column the API does not have", async () => {
    listAffiliates.mockResolvedValue(
      pageOf([
        affiliate(),
        affiliate({
          id: "99999999-9999-4999-8999-999999999999",
          deletedAt: "2026-08-01T10:00:00.000Z",
        }),
      ]),
    );

    await renderPage();

    expect(screen.getByText("Activo")).toBeInTheDocument();
    expect(screen.getByText("Archivado")).toBeInTheDocument();
  });

  it("says nothing matched when a filter is applied, and nothing exists when none is", async () => {
    listAffiliates.mockResolvedValue(pageOf([]));
    const filtered = await renderPage({ includeDeleted: "true" });
    expect(screen.getByText("Nada coincide con estos filtros")).toBeInTheDocument();
    filtered.unmount();

    listAffiliates.mockResolvedValue(pageOf([]));
    await renderPage();
    expect(screen.getByText("Todavía no hay afiliados")).toBeInTheDocument();
  });

  it("renders a failure panel and never the API's own English", async () => {
    listAffiliates.mockRejectedValue(
      new AdminApiError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "server-authored english",
        requestId: "req_8f21",
      }),
    );

    await renderPage();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("No hemos podido cargar los afiliados")).toBeInTheDocument();
    expect(screen.queryByText(/server-authored english/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
