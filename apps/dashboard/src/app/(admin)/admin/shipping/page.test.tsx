import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import esMessages from "../../../../../messages/es.json";

/**
 * The shipping admin screen's server wiring: it reads `GET
 * /admin/shipping/zones`, hands the zones and server-resolved country names to
 * the manager, and renders the shared error state when the read fails. The
 * editing itself is `shipping-manager.test.tsx`'s.
 */

const listShippingZones = vi.fn<(http: unknown) => Promise<unknown>>();

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
vi.mock("@/lib/admin/shipping-api", () => ({
  listShippingZones: (http: unknown) => listShippingZones(http),
}));
vi.mock("@/lib/admin/actions", () => ({
  createShippingZoneAction: vi.fn(),
  updateShippingZoneAction: vi.fn(),
  deleteShippingZoneAction: vi.fn(),
  createShippingRateAction: vi.fn(),
  updateShippingRateAction: vi.fn(),
  deleteShippingRateAction: vi.fn(),
}));

const { default: AdminShippingPage } = await import("./page");

async function renderPage() {
  const element = await AdminShippingPage();
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {element}
    </NextIntlClientProvider>,
  );
}

describe("AdminShippingPage", () => {
  it("renders every zone the API returns", async () => {
    listShippingZones.mockResolvedValue({
      zones: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Colombia",
          countryCodes: ["CO"],
          sortOrder: 2,
          createdAt: "2026-09-24T10:00:00.000Z",
          updatedAt: "2026-09-24T10:00:00.000Z",
          rates: [],
        },
      ],
    });

    await renderPage();

    expect(listShippingZones).toHaveBeenCalledWith(expect.anything());
    expect(screen.getByRole("heading", { name: "Colombia" })).toBeInTheDocument();
    // The country name was resolved on the server, in the operator's locale.
    expect(screen.getByTitle("Colombia")).toHaveTextContent("CO");
  });

  it("renders the shared error state, not an unhandled rejection, when the read fails", async () => {
    listShippingZones.mockRejectedValue(new Error("upstream down"));

    await renderPage();

    expect(screen.getByText(esMessages.admin.shipping.loadErrorTitle)).toBeInTheDocument();
  });
});
