import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminShippingRateSchema,
  type AdminShippingRate,
  type AdminShippingZoneDetail,
} from "@akai/contracts";

import esMessages from "../../../messages/es.json";
import { ShippingManager, type ShippingManagerProps } from "./shipping-manager";

/**
 * The zones/rates screen: what it lists, what it warns about, and the two
 * editors' round trips — including the refusals, which must arrive TRANSLATED
 * from a closed reason, never as the API's English.
 */

const t = esMessages.admin.shipping;

const ZONE_CO = "11111111-1111-4111-8111-111111111111";
const ZONE_EMPTY = "22222222-2222-4222-8222-222222222222";
const RATE_ID = "33333333-3333-4333-8333-333333333333";
const T0 = "2026-09-24T10:00:00.000Z";

function rate(overrides: Partial<Record<string, unknown>> = {}): AdminShippingRate {
  return adminShippingRateSchema.parse({
    id: RATE_ID,
    zoneId: ZONE_CO,
    name: { es: "Envío nacional", en: "National shipping" },
    strategy: "FLAT",
    minValue: null,
    maxValue: null,
    priceGross: 1_500_000,
    currency: "COP",
    freeOverSubtotal: 30_000_000,
    isActive: true,
    transitDaysMin: 2,
    transitDaysMax: 5,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

const EMPTY_ZONE: AdminShippingZoneDetail = {
  id: ZONE_EMPTY,
  name: "Sin países",
  countryCodes: [],
  sortOrder: 1,
  createdAt: T0,
  updatedAt: T0,
  rates: [],
};

function zones(rates: AdminShippingRate[] = [rate()]): AdminShippingZoneDetail[] {
  return [
    { id: ZONE_CO, name: "Colombia", countryCodes: ["CO"], sortOrder: 0, createdAt: T0, updatedAt: T0, rates },
    EMPTY_ZONE,
  ];
}

/** A label that may carry a required-marker suffix, matched literally. */
function labelled(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

const COUNTRY_NAMES = { CO: "Colombia" };

type Handlers = Omit<ShippingManagerProps, "initialZones" | "countryNames" | "advertisedThreshold">;

let handlers: { [K in keyof Handlers]: ReturnType<typeof vi.fn> };

function renderManager(initial: AdminShippingZoneDetail[] = zones()) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ShippingManager
        initialZones={initial}
        countryNames={COUNTRY_NAMES}
        advertisedThreshold={30_000_000}
        onCreateZone={handlers.onCreateZone}
        onUpdateZone={handlers.onUpdateZone}
        onDeleteZone={handlers.onDeleteZone}
        onCreateRate={handlers.onCreateRate}
        onUpdateRate={handlers.onUpdateRate}
        onDeleteRate={handlers.onDeleteRate}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  handlers = {
    onCreateZone: vi.fn(),
    onUpdateZone: vi.fn(),
    onDeleteZone: vi.fn(),
    onCreateRate: vi.fn(),
    onUpdateRate: vi.fn(),
    onDeleteRate: vi.fn(),
  };
});

describe("ShippingManager — listing", () => {
  it("lists each zone with its countries and rates", () => {
    renderManager();

    expect(screen.getByRole("heading", { name: "Colombia" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sin países" })).toBeInTheDocument();
    expect(screen.getByText("CO")).toBeInTheDocument();
    expect(screen.getByText("Envío nacional")).toBeInTheDocument();
    expect(screen.getByText("2–5 días")).toBeInTheDocument();
  });

  it("warns when an active rate's free-shipping threshold is not the advertised $ 300.000", () => {
    renderManager(zones([rate({ freeOverSubtotal: 40_000_000 })]));

    expect(screen.getByText(t.threshold.title)).toBeInTheDocument();
  });

  it("stays quiet when every active rate matches the advertised threshold", () => {
    renderManager();

    expect(screen.queryByText(t.threshold.title)).not.toBeInTheDocument();
  });
});

describe("ShippingManager — zones", () => {
  it("surfaces a country already held by another zone and does not submit", async () => {
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByRole("button", { name: t.zone.new }));
    const form = screen.getByRole("form", { name: t.zone.createTitle });
    await user.type(within(form).getByLabelText(labelled(t.zone.name)), "Nacional");
    await user.click(within(form).getByLabelText(/Colombia \(CO\)/));

    expect(
      within(form).getByText("Colombia ya pertenece a la zona «Colombia»; quítalo de allí primero."),
    ).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: t.zone.create }));
    expect(handlers.onCreateZone).not.toHaveBeenCalled();
  });

  it("creates a zone and translates a server refusal from its reason", async () => {
    const user = userEvent.setup();
    handlers.onCreateZone.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
      reason: "TAX_RATE_MISSING",
      message: "No current STANDARD tax_rate row for CO.",
    });
    renderManager([EMPTY_ZONE]);

    await user.click(screen.getByRole("button", { name: t.zone.new }));
    const form = screen.getByRole("form", { name: t.zone.createTitle });
    await user.type(within(form).getByLabelText(labelled(t.zone.name)), "Colombia");
    await user.click(within(form).getByLabelText("Colombia (CO)"));
    await user.click(within(form).getByRole("button", { name: t.zone.create }));

    expect(handlers.onCreateZone).toHaveBeenCalledWith({
      name: "Colombia",
      countryCodes: ["CO"],
      sortOrder: 2,
    });
    expect(await within(form).findByText(t.reasons.TAX_RATE_MISSING)).toBeInTheDocument();
    expect(screen.queryByText(/tax_rate/)).not.toBeInTheDocument();
  });
});

describe("ShippingManager — rates", () => {
  it("creates a rate priced in whole pesos", async () => {
    const user = userEvent.setup();
    handlers.onCreateRate.mockResolvedValueOnce({
      ok: true,
      data: rate({
        id: "44444444-4444-4444-8444-444444444444",
        name: { es: "Envío express" },
        priceGross: 2_500_000,
      }),
    });
    renderManager();

    const colombia =
      screen.getByRole("heading", { name: "Colombia" }).closest("section") ?? document.body;
    await user.click(within(colombia as HTMLElement).getByRole("button", { name: t.rate.add }));

    const form = screen.getByRole("form", { name: t.rate.createTitle });
    await user.type(within(form).getByLabelText(labelled(t.rate.nameEs)), "Envío express");
    await user.type(within(form).getByLabelText(labelled(t.rate.price)), "25.000");
    await user.click(within(form).getByRole("button", { name: t.rate.create }));

    expect(handlers.onCreateRate).toHaveBeenCalledWith(
      ZONE_CO,
      expect.objectContaining({
        name: { es: "Envío express" },
        priceGross: 2_500_000,
        currency: "COP",
      }),
    );
    expect(await screen.findByText("Envío express")).toBeInTheDocument();
    expect(screen.getByText(t.rate.created)).toBeInTheDocument();
  });

  it("has no Sendcloud mapping fields", async () => {
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getAllByRole("button", { name: t.rate.edit })[0] as HTMLElement);
    const form = screen.getByRole("form", { name: t.rate.editTitle });

    expect(within(form).queryByText(/Sendcloud/)).not.toBeInTheDocument();
    expect(within(form).getByText(t.rate.transitLegend)).toBeInTheDocument();
  });

  it("refuses centavos on a peso price before calling the server", async () => {
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getAllByRole("button", { name: t.rate.edit })[0] as HTMLElement);
    const form = screen.getByRole("form", { name: t.rate.editTitle });
    const price = within(form).getByLabelText(labelled(t.rate.price));
    await user.clear(price);
    await user.type(price, "15000,50");
    await user.click(within(form).getByRole("button", { name: t.save }));

    expect(within(form).getAllByText(t.fieldErrors.TOO_MANY_DECIMALS).length).toBeGreaterThan(0);
    expect(handlers.onUpdateRate).not.toHaveBeenCalled();
  });

  it("deletes a rate after a confirmation that names it", async () => {
    const user = userEvent.setup();
    handlers.onDeleteRate.mockResolvedValueOnce({ ok: true, data: null });
    renderManager();

    await user.click(screen.getByRole("button", { name: t.rate.delete }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Envío nacional")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: t.rate.deleteConfirm }));

    await waitFor(() => expect(handlers.onDeleteRate).toHaveBeenCalledWith(ZONE_CO, RATE_ID));
    await waitFor(() => expect(screen.queryByText("Envío nacional")).not.toBeInTheDocument());
  });
});
