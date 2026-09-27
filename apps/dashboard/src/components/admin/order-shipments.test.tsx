import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { AdminOrderShipment } from "@akai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import esMessages from "../../../messages/es.json";
import { OrderShipments, type OrderShipmentHandlers } from "./order-shipments";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/admin/actions", () => ({
  generateLabelsAction: vi.fn(),
  cancelLabelAction: vi.fn(),
  retryLabelAction: vi.fn(),
}));

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_NUMBER = "AK-2026-000123";

function shipment(overrides: Partial<AdminOrderShipment> = {}): AdminOrderShipment {
  const base: AdminOrderShipment = {
    id: "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10",
    carrier: "InPost",
    trackingNumber: "INP000123",
    trackingUrl: "https://tracking.example/INP000123",
    status: "LABEL_CREATED",
    shippedAt: null,
    deliveredAt: null,
    provider: "SENDCLOUD",
    hasLabel: true,
    providerStatusCode: "READY_TO_SEND",
    failureReason: null,
    createdAt: "2026-09-24T12:00:00.000Z",
  };
  return { ...base, ...overrides };
}

function handlers(overrides: Partial<OrderShipmentHandlers> = {}): OrderShipmentHandlers {
  return {
    generate: vi.fn(async () => ({
      ok: true as const,
      data: { accepted: [ORDER_NUMBER], skipped: [] },
    })),
    cancel: vi.fn(async () => ({
      ok: true as const,
      data: { shipmentId: shipment().id, status: "CANCELLED" as const, orderStatus: "PAID" as const },
    })),
    retry: vi.fn(async () => ({
      ok: true as const,
      data: { accepted: [ORDER_NUMBER], skipped: [] },
    })),
    ...overrides,
  };
}

function renderCard(props: {
  shipments: readonly AdminOrderShipment[];
  canGenerate?: boolean;
  handlers: OrderShipmentHandlers;
}) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ToastProvider closeLabel="Cerrar">
        <OrderShipments
          orderId={ORDER_ID}
          orderNumber={ORDER_NUMBER}
          locale="es"
          shipments={props.shipments}
          canGenerate={props.canGenerate ?? false}
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
  it("shows carrier, status, a tracking link and a download link that goes through our route", () => {
    renderCard({ shipments: [shipment()], handlers: handlers() });

    const card = screen.getByTestId("shipment-card");
    expect(within(card).getByText("Etiqueta creada")).toBeInTheDocument();
    expect(within(card).getByText("InPost")).toBeInTheDocument();
    expect(
      within(card).getByRole("link", { name: "Seguir el envío INP000123" }).getAttribute("href"),
    ).toBe("https://tracking.example/INP000123");

    const download = within(card).getByRole("link", { name: "Descargar etiqueta" });
    expect(download.getAttribute("href")).toBe(
      `/api/admin/shipments/${shipment().id}/label?order=${ORDER_NUMBER}&locale=es`,
    );
    expect(download.getAttribute("target")).toBe("_blank");
  });

  it("offers Generar etiqueta only when eligible, and sends the order id with a key", async () => {
    const user = userEvent.setup();
    const generate = vi.fn<OrderShipmentHandlers["generate"]>(async () => ({
      ok: true as const,
      data: { accepted: [ORDER_NUMBER], skipped: [] },
    }));
    const { unmount } = renderCard({ shipments: [], handlers: handlers({ generate }) });
    expect(screen.queryByRole("button", { name: "Generar etiqueta" })).toBeNull();
    expect(screen.getByText("Todavía no hay etiqueta ni envío.")).toBeInTheDocument();
    unmount();

    renderCard({ shipments: [], canGenerate: true, handlers: handlers({ generate }) });
    await user.click(screen.getByRole("button", { name: "Generar etiqueta" }));

    expect(generate).toHaveBeenCalledWith([ORDER_ID], expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(await screen.findByText("Etiqueta en preparación")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("cancels through a confirmation naming the parcel; a carrier refusal keeps the dialog open with our copy", async () => {
    const user = userEvent.setup();
    const cancel = vi
      .fn<OrderShipmentHandlers["cancel"]>()
      .mockResolvedValueOnce({
        ok: false,
        code: "CONFLICT",
        reason: "CANCEL_REJECTED",
        message: "The carrier no longer allows this label to be cancelled.",
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { shipmentId: shipment().id, status: "CANCELLED", orderStatus: "PAID" },
      });
    renderCard({ shipments: [shipment()], handlers: handlers({ cancel }) });

    await user.click(screen.getByRole("button", { name: "Cancelar etiqueta…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(`${ORDER_NUMBER} · InPost · INP000123`)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancelar etiqueta" }));
    expect(await within(dialog).findByText("El transportista ya no permite cancelarla.")).toBeInTheDocument();
    expect(screen.queryByText("The carrier no longer allows this label to be cancelled.")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Cancelar etiqueta" }));
    expect(await screen.findByText("Etiqueta cancelada")).toBeInTheDocument();
    // Same key for the retried cancel: one user action, one key.
    expect(cancel.mock.calls[0]?.[2]).toBe(cancel.mock.calls[1]?.[2]);
    expect(cancel).toHaveBeenCalledWith(shipment().id, ORDER_NUMBER, expect.any(String));
  });

  it("shows a FAILED label's Sendcloud detail as staff-only, with Reintentar and no cancel/download", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<OrderShipmentHandlers["retry"]>(async () => ({
      ok: true as const,
      data: { accepted: [ORDER_NUMBER], skipped: [] },
    }));
    const failed = shipment({
      status: "FAILED",
      hasLabel: false,
      trackingNumber: null,
      trackingUrl: null,
      failureReason: "invalid: House number is required (/to_address/house_number)",
    });
    renderCard({ shipments: [failed], handlers: handlers({ retry }) });

    const detail = screen.getByTestId("failure-reason");
    expect(detail).toHaveTextContent("solo operadores");
    expect(detail).toHaveTextContent("House number is required");
    expect(screen.queryByRole("link", { name: "Descargar etiqueta" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar etiqueta…" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(retry).toHaveBeenCalledWith(failed.id, ORDER_NUMBER, expect.any(String));
    expect(await screen.findByText("Reintento en preparación")).toBeInTheDocument();
  });

  it("offers no cancel on a scanned parcel or a manual shipment", () => {
    renderCard({
      shipments: [
        shipment({ id: "aaaaaaaa-0000-4000-8000-000000000001", status: "IN_TRANSIT" }),
        shipment({ id: "aaaaaaaa-0000-4000-8000-000000000002", provider: "MANUAL", hasLabel: false }),
      ],
      handlers: handlers(),
    });
    expect(screen.queryByRole("button", { name: "Cancelar etiqueta…" })).toBeNull();
    expect(screen.getAllByTestId("shipment-card")).toHaveLength(2);
  });
});
