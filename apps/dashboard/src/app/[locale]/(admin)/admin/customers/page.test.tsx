import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminCustomerSchema, type AdminCustomer } from "@akai/contracts";
import { AdminApiError } from "@/lib/admin/http";

import esMessages from "../../../../../../messages/es.json";

/**
 * The customer list.
 *
 * WHAT IS ACTUALLY UNDER TEST is the three things about this page that are
 * silent when they break:
 *
 *  1. The `anonymised` filter reaches the API as the literal string "false".
 *     The API parses it with `z.coerce.boolean()`, under which the non-empty
 *     string "false" is TRUTHY — so a "helpful" conversion here inverts the
 *     filter and shows an operator the erased accounts when they asked for the
 *     live ones. Nothing else in the stack would fail.
 *  2. The page fetches with the TOP of the cursor stack. Reading the first
 *     entry of the repeated param — which every admin list did before the stack
 *     landed — pins the operator to page two: the URL changes on Next and the
 *     rows do not.
 *  3. Lifetime value renders through the UNBRANDED aggregate path. `toMinor`
 *     throws above `MINOR_MAX` (2,000,000,000 minor units — $20m COP), so branding
 *     it would crash this page for a successful business.
 *
 * Rendered against the REAL Spanish catalogue rather than an identity
 * translator: the assertions are what an operator reads, and a fixture
 * translator is exactly the thing that keeps passing after somebody flattens
 * "Borrado (RGPD)" into a raw enum.
 */

const listCustomers = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const { createTranslator } = await import("next-intl");
    // Widened deliberately. `createTranslator` infers a literal union of every
    // key in the catalogue, and a `namespace` typed `string` is not a member of
    // it — so the double is typed against the SHAPE of a message tree rather
    // than against this one, which is also what lets the two branches below
    // exist at all under `exactOptionalPropertyTypes` (an explicit
    // `namespace: undefined` is not the same as an absent one).
    const messages: Record<string, unknown> = esMessages;
    return namespace === undefined
      ? createTranslator({ locale: "es", messages })
      : createTranslator({ locale: "es", messages, namespace });
  },
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  listCustomers: (http: unknown, params: unknown) => listCustomers(http, params),
}));

vi.mock("@/i18n/navigation", () => ({
  // Every prop is forwarded, unlike the usual children-only stub: this page's
  // row link is named by an `aria-label`, and a stub that swallowed it would
  // make the accessible-name assertion below unfalsifiable.
  Link: (props: ComponentProps<"a">) => <a {...props} />,
}));

const { default: AdminCustomersPage } = await import("./page");

/**
 * Parsed through the contract rather than cast, so a fixture that has drifted
 * from `adminCustomerSchema` fails HERE instead of passing against a shape the
 * API can no longer send.
 */
function customer(overrides: Partial<AdminCustomer> = {}): AdminCustomer {
  return adminCustomerSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ana@example.es",
    emailVerifiedAt: "2025-03-14T10:00:00.000Z",
    firstName: "Ana",
    lastName: "Mestra",
    phone: null,
    role: "CUSTOMER",
    preferredLocale: "es",
    twoFactorEnabled: false,
    anonymisedAt: null,
    createdAt: "2025-03-14T10:00:00.000Z",
    updatedAt: "2025-03-14T10:00:00.000Z",
    orderCount: 12,
    lifetimeValueMinor: 96_420,
    lastOrderAt: "2026-08-28T09:00:00.000Z",
    marketingConsentAt: null,
    ...overrides,
  });
}

function pageOf(items: readonly AdminCustomer[], nextCursor: string | null = null) {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

async function renderPage(query: Record<string, string | string[] | undefined> = {}) {
  const ui = await AdminCustomersPage({
    params: Promise.resolve({ locale: "es" }),
    searchParams: Promise.resolve(query),
  });
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("AdminCustomersPage", () => {
  beforeEach(() => {
    // Braced. `beforeEach(() => mock.mockReset())` returns the mock, which
    // Vitest then treats as a TEARDOWN callback and invokes after every test.
    listCustomers.mockReset();
  });

  it("sends the anonymised filter as the literal string, never a boolean", async () => {
    listCustomers.mockResolvedValue(pageOf([customer()]));

    await renderPage({ anonymised: "false" });

    expect(listCustomers).toHaveBeenCalledTimes(1);
    const params = listCustomers.mock.calls[0]?.[1];
    expect(params).toMatchObject({ anonymised: "false" });
  });

  it("drops an anonymised value that is neither 'true' nor 'false'", async () => {
    listCustomers.mockResolvedValue(pageOf([customer()]));

    await renderPage({ anonymised: "yes" });

    expect(listCustomers.mock.calls[0]?.[1]).not.toHaveProperty("anonymised");
  });

  it("fetches with the TOP of the cursor stack, not the first entry", async () => {
    listCustomers.mockResolvedValue(pageOf([customer()]));

    await renderPage({ cursor: ["page-two", "page-three"] });

    expect(listCustomers.mock.calls[0]?.[1]).toMatchObject({ cursor: "page-three" });
  });

  it("ignores a page size the pagination control cannot offer", async () => {
    listCustomers.mockResolvedValue(pageOf([customer()]));

    // 500 would be a 400 from the API — `paginationQuerySchema` clamps to 100 —
    // and would also make the "showing 51–75" arithmetic in the footer a lie.
    await renderPage({ limit: "500" });

    expect(listCustomers.mock.calls[0]?.[1]).toMatchObject({ limit: 25 });
  });

  it("names each row link with the customer it opens", async () => {
    listCustomers.mockResolvedValue(pageOf([customer()]));

    await renderPage();

    const link = screen.getByRole("link", { name: "Ver la ficha de ana@example.es" });
    expect(link).toHaveAttribute(
      "href",
      "/admin/customers/11111111-1111-4111-8111-111111111111",
    );
  });

  it("renders the role as a translated badge and never the raw enum", async () => {
    listCustomers.mockResolvedValue(
      pageOf([
        customer(),
        customer({
          id: "22222222-2222-4222-8222-222222222222",
          email: "ops@akai.shop",
          role: "STAFF",
        }),
      ]),
    );

    await renderPage();

    // Scoped to the table on purpose: the role FILTER draws the same three
    // labels as options, off the same `status.role` namespace — which is the
    // point (one vocabulary, not two), and which makes an unscoped query match
    // the control instead of the row it is meant to be checking.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Cliente")).toBeInTheDocument();
    expect(table.getByText("Operador")).toBeInTheDocument();
    expect(screen.queryByText("CUSTOMER")).toBeNull();
    expect(screen.queryByText("STAFF")).toBeNull();
  });

  it("badges an erased account and keeps it in the list with its order history", async () => {
    listCustomers.mockResolvedValue(
      pageOf([
        customer({
          anonymisedAt: "2026-01-04T00:00:00.000Z",
          firstName: null,
          lastName: null,
          orderCount: 3,
        }),
      ]),
    );

    await renderPage();

    expect(screen.getByText("Borrado (RGPD)")).toBeInTheDocument();
    // The row survives erasure — that is the whole point of anonymising in
    // place — so the order count is still readable beside the badge.
    expect(screen.getByRole("cell", { name: "3" })).toBeInTheDocument();
  });

  it("badges an unverified address, and only an unverified one", async () => {
    listCustomers.mockResolvedValue(
      pageOf([
        customer({ emailVerifiedAt: null }),
        customer({ id: "33333333-3333-4333-8333-333333333333", email: "b@example.es" }),
      ]),
    );

    await renderPage();

    expect(screen.getAllByText("Sin verificar")).toHaveLength(1);
    expect(screen.queryByText("Verificado")).toBeNull();
  });

  it("formats a lifetime value above MINOR_MAX instead of throwing", async () => {
    // $ 24.000.000 COP — above the branded ceiling. `toMinor` would throw
    // here and `isMinor` would refuse to narrow, printing a bare 2400000000.
    listCustomers.mockResolvedValue(
      pageOf([customer({ lifetimeValueMinor: 2_400_000_000 })]),
    );

    await renderPage();

    expect(screen.getByText(/24\.000\.000/)).toBeInTheDocument();
    expect(screen.queryByText("2400000000")).toBeNull();
  });

  it("offers the three filters as a GET form, so the view stays linkable", async () => {
    listCustomers.mockResolvedValue(pageOf([customer()]));

    await renderPage({ email: "ana" });

    const form = screen.getByRole("search", { name: "Filtros de clientes" });
    expect(form).toHaveAttribute("method", "get");
    expect(within(form).getByLabelText("El correo contiene")).toHaveValue("ana");
    expect(within(form).getByLabelText("Rol")).toBeInTheDocument();
    expect(within(form).getByLabelText("Borrados")).toBeInTheDocument();
  });

  it("says nothing matched when a filter is applied, and nothing exists when none is", async () => {
    listCustomers.mockResolvedValue(pageOf([]));
    const filtered = await renderPage({ email: "nobody" });
    expect(
      screen.getByText("Ningún cliente coincide con estos filtros."),
    ).toBeInTheDocument();
    filtered.unmount();

    listCustomers.mockResolvedValue(pageOf([]));
    await renderPage();
    expect(screen.getByText("Aquí todavía no hay nada")).toBeInTheDocument();
  });

  it("renders a failure panel and never the API's own English", async () => {
    listCustomers.mockRejectedValue(
      new AdminApiError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "server-authored english",
        requestId: "req_8f21",
      }),
    );

    await renderPage();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("No hemos podido cargar los clientes")).toBeInTheDocument();
    expect(screen.queryByText(/server-authored english/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
