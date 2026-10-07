import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminCustomerSchema, type AdminCustomer, type OrderSummary } from "@akai/contracts";
import { AdminApiError } from "@/lib/admin/http";

import esMessages from "../../../../../../../messages/es.json";

/**
 * One customer, read-only.
 *
 * WHAT IS ACTUALLY UNDER TEST:
 *
 *  1. The order history is fetched by EMAIL, not by customer id. Email is also
 *     the claim key for guest orders, so a customer who checked out before
 *     registering has orders carrying no customerId at all — keying on the id
 *     hides exactly the history support is looking for, and nothing about the
 *     page would look broken.
 *  2. The two fetches degrade INDEPENDENTLY. A failed order query must leave
 *     the profile on screen, because that is what the agent on the phone is
 *     reading; the failure is scoped to its own section.
 *  3. `notFound()` is keyed on the error CODE, never on the HTTP status. A
 *     proxy returning a bare 404 with no envelope must land in the error panel
 *     rather than tell an operator this customer has been deleted.
 *  4. Lifetime value goes through the unbranded aggregate path — `toMinor`
 *     throws above `MINOR_MAX`, so branding it crashes the page for a
 *     successful business.
 *  5. An erased account keeps its order history and says so.
 */

const notFound = vi.fn(() => {
  // Throws, exactly as the real one does: `notFound()` raises a control-flow
  // signal Next catches, so a no-op mock would let execution fall through and
  // hide the branch this file exists to pin.
  throw new Error("NEXT_NOT_FOUND");
});

const getCustomer = vi.fn<(http: unknown, id: string) => Promise<unknown>>();
const listOrders = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

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
  getCustomer: (http: unknown, id: string) => getCustomer(http, id),
  listOrders: (http: unknown, params: unknown) => listOrders(http, params),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: (props: ComponentProps<"a">) => <a {...props} />,
}));

const { default: AdminCustomerDetailPage } = await import("./page");

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

/** Parsed through the contract, so a drifted fixture fails here and not later. */
function customer(overrides: Partial<AdminCustomer> = {}): AdminCustomer {
  return adminCustomerSchema.parse({
    id: CUSTOMER_ID,
    email: "ana@example.es",
    emailVerifiedAt: "2025-03-14T10:00:00.000Z",
    firstName: "Ana",
    lastName: "Mestra",
    phone: "+34 600 000 000",
    role: "CUSTOMER",
    preferredLocale: "es",
    twoFactorEnabled: true,
    anonymisedAt: null,
    createdAt: "2025-03-14T10:00:00.000Z",
    updatedAt: "2025-03-14T10:00:00.000Z",
    orderCount: 12,
    lifetimeValueMinor: 96_420_000,
    lastOrderAt: "2026-08-28T09:00:00.000Z",
    marketingConsentAt: "2025-03-14T10:00:00.000Z",
    ...overrides,
  });
}

/**
 * Cast-free: the mocked module hands the page plain objects, and shaping them
 * as `OrderSummary` here is what keeps the columns honest about the `.strict()`
 * seven-field projection the API actually serves.
 */
function order(overrides: Partial<OrderSummary> = {}): unknown {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    orderNumber: "AK-2026-00412",
    status: "PAID",
    currency: "COP",
    grandTotal: 5_490,
    itemCount: 2,
    placedAt: "2026-08-28T09:00:00.000Z",
    ...overrides,
  };
}

function apiError(code: AdminApiError["code"], status: number): AdminApiError {
  return new AdminApiError({
    code,
    status,
    message: "server-authored english",
    requestId: "req_8f21",
  });
}

async function renderPage() {
  const ui = await AdminCustomerDetailPage({
    params: Promise.resolve({ locale: "es", customerId: CUSTOMER_ID }),
  });
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("AdminCustomerDetailPage", () => {
  beforeEach(() => {
    notFound.mockClear();
    getCustomer.mockReset();
    listOrders.mockReset();
  });

  it("fetches the order history by EMAIL, not by customer id", async () => {
    getCustomer.mockResolvedValue(customer());
    listOrders.mockResolvedValue({ items: [order()], nextCursor: null, hasMore: false });

    await renderPage();

    const params = listOrders.mock.calls[0]?.[1];
    expect(params).toMatchObject({ email: "ana@example.es" });
    expect(params).not.toHaveProperty("customerId");
  });

  it("keeps the profile on screen when the order history fails", async () => {
    getCustomer.mockResolvedValue(customer());
    listOrders.mockRejectedValue(apiError("INTERNAL_ERROR", 500));

    await renderPage();

    // The figures the agent opened the page for survive the scoped failure.
    expect(screen.getByText("Valor total")).toBeInTheDocument();
    expect(screen.getByText(/964\.200/)).toBeInTheDocument();
    // …and the failure is announced, without the API's own English.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("No hemos podido cargar el historial")).toBeInTheDocument();
    expect(screen.queryByText(/server-authored english/)).toBeNull();
  });

  it("calls notFound() when the API's code is NOT_FOUND", async () => {
    getCustomer.mockRejectedValue(apiError("NOT_FOUND", 404));

    await expect(
      AdminCustomerDetailPage({
        params: Promise.resolve({ locale: "es", customerId: CUSTOMER_ID }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("does NOT call notFound() for a 404 carrying no error envelope", async () => {
    getCustomer.mockRejectedValue(apiError("INTERNAL_ERROR", 404));

    await renderPage();

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("No hemos podido cargar este cliente")).toBeInTheDocument();
  });

  it("draws four tiles and neither of the two figures the API cannot send", async () => {
    getCustomer.mockResolvedValue(customer());
    listOrders.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    await renderPage();

    expect(screen.getByText("Pedidos")).toBeInTheDocument();
    expect(screen.getByText("Valor total")).toBeInTheDocument();
    expect(screen.getByText("Último pedido")).toBeInTheDocument();
    expect(screen.getByText("Correo verificado")).toBeInTheDocument();
    // `adminCustomerSchema` is `.strict()` and carries neither, so neither can
    // be computed from what the API sends.
    expect(screen.queryByText("Ticket medio")).toBeNull();
    expect(screen.queryByText("Reembolsado")).toBeNull();
  });

  it("formats a lifetime value above MINOR_MAX instead of throwing", async () => {
    getCustomer.mockResolvedValue(customer({ lifetimeValueMinor: 2_400_000_000 }));
    listOrders.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    await renderPage();

    expect(screen.getByText(/24\.000\.000/)).toBeInTheDocument();
    expect(screen.queryByText("2400000000")).toBeNull();
  });

  it("explains an erased account and still shows its order history", async () => {
    getCustomer.mockResolvedValue(
      customer({
        anonymisedAt: "2026-01-04T00:00:00.000Z",
        firstName: null,
        lastName: null,
      }),
    );
    listOrders.mockResolvedValue({ items: [order()], nextCursor: null, hasMore: false });

    await renderPage();

    expect(screen.getByText("Borrado (RGPD)")).toBeInTheDocument();
    expect(screen.getByText(/derecho de supresión/)).toBeInTheDocument();
    expect(screen.getByText("Sin nombre en la ficha")).toBeInTheDocument();
    // The history is the reason the row is kept rather than deleted.
    expect(
      within(screen.getByRole("table")).getByRole("link", { name: "AK-2026-00412" }),
    ).toHaveAttribute("href", "/admin/orders/AK-2026-00412");
  });

  it("never prints a raw order status to an operator", async () => {
    getCustomer.mockResolvedValue(customer());
    listOrders.mockResolvedValue({
      items: [order({ status: "PAYMENT_MISMATCH" })],
      nextCursor: null,
      hasMore: false,
    });

    await renderPage();

    // The defect this redesign fixes: PAYMENT_MISMATCH was printed verbatim.
    expect(screen.queryByText("PAYMENT_MISMATCH")).toBeNull();
    expect(
      within(screen.getByRole("table")).getByText("Importe no coincide"),
    ).toBeInTheDocument();
  });

  it("names the language rather than printing its code", async () => {
    getCustomer.mockResolvedValue(customer({ preferredLocale: "en" }));
    listOrders.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    await renderPage();

    expect(screen.getByText("Idioma preferido")).toBeInTheDocument();
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.queryByText("en")).toBeNull();
  });

  it("says the customer has no orders rather than that the fetch failed", async () => {
    getCustomer.mockResolvedValue(customer({ orderCount: 0, lastOrderAt: null }));
    listOrders.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    await renderPage();

    expect(
      screen.getByText("Este cliente todavía no ha hecho ningún pedido."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
