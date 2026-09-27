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

const ZONE_ES = "11111111-1111-4111-8111-111111111111";
const ZONE_EU = "22222222-2222-4222-8222-222222222222";
const RATE_ID = "33333333-3333-4333-8333-333333333333";
const T0 = "2026-09-24T10:00:00.000Z";

function rate(overrides: Partial<Record<string, unknown>> = {}): AdminShippingRate {
  return adminShippingRateSchema.parse({
    id: RATE_ID,
    zoneId: ZONE_ES,
    name: { es: "Envío en punto de recogida INPOST", en: "InPost pickup point" },
    strategy: "FLAT",
    minValue: null,
    maxValue: null,
    priceGross: 899,
    currency: "EUR",
    freeOverSubtotal: 25_000,
    isActive: true,
    deliveryType: "SERVICE_POINT",
    carrierCode: "inpost_es",
    sendcloudOptionCode: "inpost_es:service_point,national_c2c",
    transitDaysMin: 1,
    transitDaysMax: 2,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

function zones(rates: AdminShippingRate[] = [rate()]): AdminShippingZoneDetail[] {
  return [
    { id: ZONE_ES, name: "España", countryCodes: ["ES"], sortOrder: 0, createdAt: T0, updatedAt: T0, rates },
    { id: ZONE_EU, name: "Unión Europea", countryCodes: ["PT", "FR"], sortOrder: 1, createdAt: T0, updatedAt: T0, rates: [] },
  ];
}

/** A label that may carry a required-marker suffix, matched literally. */
function labelled(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

const COUNTRY_NAMES = { ES: "España", PT: "Portugal", FR: "Francia", IE: "Irlanda" };

type Handlers = Omit<ShippingManagerProps, "initialZones" | "countryNames" | "advertisedThreshold">;

let handlers: { [K in keyof Handlers]: ReturnType<typeof vi.fn> };

function renderManager(initial: AdminShippingZoneDetail[] = zones()) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ShippingManager
        initialZones={initial}
        countryNames={COUNTRY_NAMES}
        advertisedThreshold={25_000}
        onCreateZone={handlers.onCreateZone}
        onUpdateZone={handlers.onUpdateZone}
        onDeleteZone={handlers.onDeleteZone}
        onCreateRate={handlers.onCreateRate}
        onUpdateRate={handlers.onUpdateRate}
        onDeleteRate={handlers.onDeleteRate}
        loadSendcloudOptions={handlers.loadSendcloudOptions}
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
    loadSendcloudOptions: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        country: "ES",
        options: [
          {
            code: "ups:standard/service_point",
            name: "UPS Standard to Access Point",
            carrierCode: "ups",
            carrierName: "UPS",
            lastMile: "service_point",
            deliveryType: "SERVICE_POINT",
            requiresServicePoint: true,
            requiredFields: [],
            merchantCost: 600,
            currency: "EUR",
          },
        ],
      },
    }),
  };
});

describe("ShippingManager — listing", () => {
  it("lists each zone with its countries and rates", () => {
    renderManager();

    expect(screen.getByRole("heading", { name: "España" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unión Europea" })).toBeInTheDocument();
    expect(screen.getByText("PT")).toBeInTheDocument();
    expect(screen.getByText("Envío en punto de recogida INPOST")).toBeInTheDocument();
    expect(screen.getByText("inpost_es:service_point,national_c2c")).toBeInTheDocument();
    expect(screen.getByText("1–2 días")).toBeInTheDocument();
  });

  it("warns when an active rate's free-shipping threshold is not the advertised 250 €", () => {
    renderManager(zones([rate({ freeOverSubtotal: 30_000 })]));

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
    await user.type(within(form).getByLabelText(labelled(t.zone.name)), "Península");
    await user.click(within(form).getByLabelText(/Portugal \(PT\)/));

    expect(
      within(form).getByText("Portugal ya pertenece a la zona «Unión Europea»; quítalo de allí primero."),
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
      message: "No current STANDARD tax_rate row for IE.",
    });
    renderManager();

    await user.click(screen.getByRole("button", { name: t.zone.new }));
    const form = screen.getByRole("form", { name: t.zone.createTitle });
    await user.type(within(form).getByLabelText(labelled(t.zone.name)), "Irlanda");
    await user.click(within(form).getByLabelText("Irlanda (IE)"));
    await user.click(within(form).getByRole("button", { name: t.zone.create }));

    expect(handlers.onCreateZone).toHaveBeenCalledWith({
      name: "Irlanda",
      countryCodes: ["IE"],
      sortOrder: 2,
    });
    expect(await within(form).findByText(t.reasons.TAX_RATE_MISSING)).toBeInTheDocument();
    expect(screen.queryByText(/tax_rate/)).not.toBeInTheDocument();
  });
});

describe("ShippingManager — rates", () => {
  it("fills the Sendcloud mapping from the picker and creates the rate", async () => {
    const user = userEvent.setup();
    handlers.onCreateRate.mockResolvedValueOnce({
      ok: true,
      data: rate({
        id: "44444444-4444-4444-8444-444444444444",
        name: { es: "UPS Access Point" },
        priceGross: 600,
        carrierCode: "ups",
        sendcloudOptionCode: "ups:standard/service_point",
      }),
    });
    renderManager();

    const spain = screen.getByRole("heading", { name: "España" }).closest("section") ?? document.body;
    await user.click(within(spain as HTMLElement).getByRole("button", { name: t.rate.add }));

    const form = screen.getByRole("form", { name: t.rate.createTitle });
    expect(handlers.loadSendcloudOptions).toHaveBeenCalledWith("ES");
    const picker = await within(form).findByLabelText(t.rate.sendcloudOption);
    await user.selectOptions(picker, "ups:standard/service_point");
    expect(within(form).getByLabelText(t.rate.carrierCode)).toHaveValue("ups");

    await user.type(within(form).getByLabelText(labelled(t.rate.nameEs)), "UPS Access Point");
    await user.type(within(form).getByLabelText(labelled(t.rate.price)), "6");
    await user.click(within(form).getByRole("button", { name: t.rate.create }));

    expect(handlers.onCreateRate).toHaveBeenCalledWith(
      ZONE_ES,
      expect.objectContaining({
        name: { es: "UPS Access Point" },
        priceGross: 600,
        carrierCode: "ups",
        sendcloudOptionCode: "ups:standard/service_point",
        deliveryType: "SERVICE_POINT",
      }),
    );
    expect(await screen.findByText("UPS Access Point")).toBeInTheDocument();
    expect(screen.getByText(t.rate.created)).toBeInTheDocument();
  });

  it("falls back to free text when Sendcloud is not configured", async () => {
    const user = userEvent.setup();
    handlers.loadSendcloudOptions.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
      reason: "FULFILMENT_NOT_CONFIGURED",
      message: "Shipping labels are not configured on this deployment.",
    });
    renderManager();

    await user.click(screen.getAllByRole("button", { name: t.rate.edit })[0] as HTMLElement);
    const form = screen.getByRole("form", { name: t.rate.editTitle });

    expect(await within(form).findByText(t.rate.optionsNotConfigured)).toBeInTheDocument();
    expect(within(form).getByLabelText(t.rate.optionCode)).toHaveValue(
      "inpost_es:service_point,national_c2c",
    );
  });

  it("refuses a pickup-point rate with no carrier before calling the server", async () => {
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getAllByRole("button", { name: t.rate.edit })[0] as HTMLElement);
    const form = screen.getByRole("form", { name: t.rate.editTitle });
    await user.clear(within(form).getByLabelText(t.rate.carrierCode));
    await user.click(within(form).getByRole("button", { name: t.save }));

    expect(within(form).getByText(t.fieldErrors.CARRIER_REQUIRED)).toBeInTheDocument();
    expect(handlers.onUpdateRate).not.toHaveBeenCalled();
  });

  it("deletes a rate after a confirmation that names it", async () => {
    const user = userEvent.setup();
    handlers.onDeleteRate.mockResolvedValueOnce({ ok: true, data: null });
    renderManager();

    await user.click(screen.getByRole("button", { name: t.rate.delete }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Envío en punto de recogida INPOST")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: t.rate.deleteConfirm }));

    await waitFor(() => expect(handlers.onDeleteRate).toHaveBeenCalledWith(ZONE_ES, RATE_ID));
    await waitFor(() =>
      expect(screen.queryByText("Envío en punto de recogida INPOST")).not.toBeInTheDocument(),
    );
  });
});
