import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { AdminOrderShipment } from "@akai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { UnshippedLine } from "@/lib/admin/shipment-display";
import esMessages from "../../../messages/es.json";
import { OrderShipments, type OrderShipmentHandlers } from "./order-shipments";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/admin/actions", () => ({
  createShipmentAction: vi.fn(),
  markShipmentDeliveredAction: vi.fn(),
}));

const ORDER_NUMBER = "AK-2026-000123";
const LINES: readonly UnshippedLine[] = [
  { orderItemId: "11111111-1111-4111-8111-111111111111", quantity: 2 },
  { orderItemId: "22222222-2222-4222-8222-222222222222", quantity: 1 },
];

function shipment(overrides: Partial<AdminOrderShipment> = {}): AdminOrderShipment {
  const base: AdminOrderShipment = {
    id: "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10",
    carrier: "Servientrega",
    trackingNumber: "2087654321",
    trackingUrl: "https://tracking.example/2087654321",
    status: "IN_TRANSIT",
    shippedAt: "2026-09-24T12:00:00.000Z",
    deliveredAt: null,
    createdAt: "2026-09-24T12:00:00.000Z",
  };
  return { ...base, ...overrides };
}

function handlers(overrides: Partial<OrderShipmentHandlers> = {}): OrderShipmentHandlers {
  return {
    create: vi.fn(async () => ({ ok: true as const, data: { shipmentId: shipment().id } })),
    deliver: vi.fn(async () => ({ ok: true as const, data: { status: "DELIVERED" as const } })),
    ...overrides,
  };
}

function renderCard(props: {
  shipments: readonly AdminOrderShipment[];
  toShip?: readonly UnshippedLine[];
  handlers: OrderShipmentHandlers;
}) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ToastProvider closeLabel="Cerrar">
        <OrderShipments
          orderNumber={ORDER_NUMBER}
          locale="es"
          shipments={props.shipments}
          toShip={props.toShip ?? []}
          handlers={props.handlers}
        />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  refresh.mockClear();
});

describe("<OrderShipments />", () => {
  it("shows carrier, status and a tracking link", () => {
    renderCard({ shipments: [shipment()], handlers: handlers() });

    const card = screen.getByTestId("shipment-card");
    expect(within(card).getByText("En tránsito")).toBeInTheDocument();
    expect(within(card).getByText("Servientrega")).toBeInTheDocument();
    expect(
      within(card).getByRole("link", { name: "Seguir el envío 2087654321" }).getAttribute("href"),
    ).toBe("https://tracking.example/2087654321");
  });

  it("says so when nothing has shipped, and offers no form when nothing may ship", () => {
    renderCard({ shipments: [], handlers: handlers() });
    expect(screen.getByText("Todavía no se ha registrado ningún envío.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar como enviado" })).toBeNull();
  });

  it("records a manual shipment: free-text carrier and tracking, every line, then refreshes", async () => {
    const user = userEvent.setup();
    const create = vi.fn<OrderShipmentHandlers["create"]>(async () => ({
      ok: true as const,
      data: { shipmentId: shipment().id },
    }));
    renderCard({ shipments: [], toShip: LINES, handlers: handlers({ create }) });

    await user.type(screen.getByLabelText(/Transportadora/), "  Coordinadora ");
    await user.type(screen.getByLabelText(/Número de guía/), "CO-778899");
    await user.click(screen.getByRole("button", { name: "Marcar como enviado" }));

    expect(create).toHaveBeenCalledWith(ORDER_NUMBER, {
      carrier: "Coordinadora",
      trackingNumber: "CO-778899",
      items: [
        { orderItemId: LINES[0]?.orderItemId, quantity: 2 },
        { orderItemId: LINES[1]?.orderItemId, quantity: 1 },
      ],
    });
    expect(await screen.findByText("Envío registrado.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("sends a blank tracking number as null", async () => {
    const user = userEvent.setup();
    const create = vi.fn<OrderShipmentHandlers["create"]>(async () => ({
      ok: true as const,
      data: { shipmentId: shipment().id },
    }));
    renderCard({ shipments: [], toShip: LINES, handlers: handlers({ create }) });

    await user.type(screen.getByLabelText(/Transportadora/), "Interrapidísimo");
    await user.click(screen.getByRole("button", { name: "Marcar como enviado" }));

    expect(create.mock.calls[0]?.[1].trackingNumber).toBeNull();
  });

  it("refuses an empty carrier without calling the API", async () => {
    const user = userEvent.setup();
    const create = vi.fn<OrderShipmentHandlers["create"]>();
    renderCard({ shipments: [], toShip: LINES, handlers: handlers({ create }) });

    await user.click(screen.getByRole("button", { name: "Marcar como enviado" }));

    expect(create).not.toHaveBeenCalled();
    expect(await screen.findByText("Indica la transportadora.")).toBeInTheDocument();
  });

  it("renders a refused shipment with our copy, never the API's English", async () => {
    const user = userEvent.setup();
    const create = vi.fn<OrderShipmentHandlers["create"]>(async () => ({
      ok: false as const,
      code: "CONFLICT" as const,
      reason: null,
      message: "Order item has only 0 unit(s) left to ship; 2 requested.",
    }));
    renderCard({ shipments: [], toShip: LINES, handlers: handlers({ create }) });

    await user.type(screen.getByLabelText(/Transportadora/), "Servientrega");
    await user.click(screen.getByRole("button", { name: "Marcar como enviado" }));

    expect(await screen.findByText(esMessages.errors.CONFLICT)).toBeInTheDocument();
    expect(screen.queryByText(/left to ship/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("marks a parcel in transit delivered", async () => {
    const user = userEvent.setup();
    const deliver = vi.fn<OrderShipmentHandlers["deliver"]>(async () => ({
      ok: true as const,
      data: { status: "DELIVERED" as const },
    }));
    renderCard({ shipments: [shipment()], handlers: handlers({ deliver }) });

    await user.click(screen.getByRole("button", { name: "Marcar como entregado" }));

    expect(deliver).toHaveBeenCalledWith(shipment().id, ORDER_NUMBER);
    expect(await screen.findByText("Envío marcado como entregado.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("offers no delivery action on a parcel that is already delivered, returned or lost", () => {
    renderCard({
      shipments: [
        shipment({ id: "aaaaaaaa-0000-4000-8000-000000000001", status: "DELIVERED" }),
        shipment({ id: "aaaaaaaa-0000-4000-8000-000000000002", status: "RETURNED" }),
        shipment({ id: "aaaaaaaa-0000-4000-8000-000000000003", status: "LOST" }),
      ],
      handlers: handlers(),
    });
    expect(screen.getAllByTestId("shipment-card")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Marcar como entregado" })).toBeNull();
  });
});
