import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { Address, Customer, OrderSummary } from "@akai/contracts";
import { AccountOverview } from "./account-overview";
import { buildAddress, buildCustomer, buildOrderSummary } from "@/lib/account/fixtures";
import { postJson } from "@/lib/bff/client";
import esMessages from "../../../messages/es.json";

/**
 * The resend control is the only thing on this screen that talks to the
 * network, and it does so through the BFF client — so that module is the
 * boundary the mock sits on, not `fetch`.
 */
vi.mock("@/lib/bff/client", () => ({
  postJson: vi.fn(async () => ({ ok: true, data: { status: "accepted" } })),
}));

const postJsonMock = vi.mocked(postJson);

function renderOverview(options: {
  customer?: Customer;
  recentOrders?: readonly OrderSummary[];
  defaultAddress?: Address | null;
  addressCount?: number;
} = {}) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AccountOverview
        customer={options.customer ?? buildCustomer()}
        recentOrders={options.recentOrders ?? [buildOrderSummary()]}
        defaultAddress={
          options.defaultAddress === undefined ? buildAddress() : options.defaultAddress
        }
        addressCount={options.addressCount ?? 2}
      />
    </NextIntlClientProvider>,
  );
}

describe("AccountOverview", () => {
  // Braced: an arrow returning the mock would be read by Vitest as a TEARDOWN
  // callback and invoked again after every test.
  beforeEach(() => {
    postJsonMock.mockClear();
  });

  it("greets the customer by name", () => {
    renderOverview();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hola, Elena Ruiz");
  });

  it("falls back to a plain greeting when no name is on file", () => {
    // "Hola, null" is the obvious failure; quietly greeting them by email
    // address is the subtle one.
    renderOverview({
      customer: buildCustomer({ firstName: null, lastName: null }),
    });

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Hola");
    expect(heading).not.toHaveTextContent("null");
    expect(heading).not.toHaveTextContent("elena@example.com");
  });

  describe("unverified email", () => {
    it("warns, and names the address the link goes to", () => {
      renderOverview({ customer: buildCustomer({ emailVerifiedAt: null }) });

      expect(screen.getByText(/aún no está verificado/)).toBeInTheDocument();
      expect(screen.getByText(/elena@example.com/)).toBeInTheDocument();
    });

    it("does not warn when the email is verified", () => {
      renderOverview();

      expect(screen.queryByText(/aún no está verificado/)).not.toBeInTheDocument();
    });

    it("offers a named resend control that posts rather than navigating", async () => {
      const user = userEvent.setup();
      renderOverview({ customer: buildCustomer({ emailVerifiedAt: null }) });

      // A BUTTON, not a link: the fix for the old amber block is an action, and
      // a link here would navigate away from the page it is correcting.
      const resend = screen.getByRole("button", { name: "Reenviar el enlace" });
      expect(screen.queryByRole("link", { name: "Reenviar el enlace" })).not.toBeInTheDocument();

      await user.click(resend);

      expect(postJsonMock).toHaveBeenCalledTimes(1);
      expect(postJsonMock.mock.calls[0]?.[0]).toBe("/api/auth/resend-verification");
      expect(postJsonMock.mock.calls[0]?.[1]).toMatchObject({ email: "elena@example.com" });
    });
  });

  describe("recent orders", () => {
    it("lists them with status and total, linked to their detail pages", () => {
      renderOverview();

      const section = screen.getByRole("region", { name: "Pedidos recientes" });
      expect(
        within(section).getByRole("link", { name: /AK-2026-000123/ }),
      ).toHaveAttribute("href", "/orders/AK-2026-000123");
      expect(within(section).getByText("Entregado")).toBeInTheDocument();
      expect(within(section).getByText(/120\.980/)).toBeInTheDocument();
    });

    it("offers a route to the full history", () => {
      renderOverview();

      expect(
        screen.getByRole("link", { name: "Ver todos los pedidos" }),
      ).toHaveAttribute("href", "/orders");
    });

    it("shows an empty state and hides the view-all link with no orders", () => {
      renderOverview({ recentOrders: [] });

      expect(screen.getByText("Todavía no tienes pedidos")).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Ver todos los pedidos" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("default address", () => {
    it("renders the saved default address", () => {
      renderOverview();

      const section = screen.getByRole("region", { name: "Dirección predeterminada" });
      expect(within(section).getByText("Calle 10 # 43-21")).toBeInTheDocument();
    });

    it("says so when there is none", () => {
      renderOverview({ defaultAddress: null });

      expect(screen.getByText("Sin dirección guardada")).toBeInTheDocument();
    });
  });

  describe("account links", () => {
    it("links to profile, addresses, returns and security", () => {
      renderOverview();

      const nav = screen.getByRole("navigation", { name: "Mi cuenta" });
      expect(within(nav).getByRole("link", { name: "Editar perfil" })).toHaveAttribute(
        "href",
        "/profile",
      );
      // The row's value is part of the link's accessible name — "Direcciones,
      // 2 guardadas" — which is the point of putting it inside the row.
      expect(within(nav).getByRole("link", { name: /Direcciones/ })).toHaveAttribute(
        "href",
        "/addresses",
      );
      expect(within(nav).getByRole("link", { name: /Devoluciones/ })).toHaveAttribute(
        "href",
        "/returns",
      );
      expect(within(nav).getByRole("link", { name: /Seguridad/ })).toHaveAttribute(
        "href",
        "/security",
      );
    });

    it("counts the address book", () => {
      renderOverview({ addressCount: 2 });

      expect(screen.getByText("2 guardadas")).toBeInTheDocument();
    });

    it("says two-step is off when it is", () => {
      renderOverview({ customer: buildCustomer({ twoFactorEnabled: false }) });

      expect(screen.getByText("Dos pasos desactivado")).toBeInTheDocument();
    });

    it("says two-step is on when it is", () => {
      renderOverview({ customer: buildCustomer({ twoFactorEnabled: true }) });

      expect(screen.getByText("Dos pasos activado")).toBeInTheDocument();
    });
  });
});
