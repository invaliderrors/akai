import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataTable } from "@/components/ui/table";
import { ToastProvider } from "@/components/ui/toast";
import esMessages from "../../../messages/es.json";
import { OrderBulkActions, type OrderBulkActionHandlers } from "./order-bulk-actions";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
// The real module is "use server" and reaches the session; the handlers are injected.
vi.mock("@/lib/admin/actions", () => ({
  generateLabelsAction: vi.fn(),
  printLabelsAction: vi.fn(),
}));

const FORM = "orders-label-selection";
const ROWS = [
  { id: "11111111-1111-4111-8111-111111111111", orderNumber: "AK-2026-000001" },
  { id: "22222222-2222-4222-8222-222222222222", orderNumber: "AK-2026-000002" },
  { id: "33333333-3333-4333-8333-333333333333", orderNumber: "AK-2026-000003" },
];
const NUMBERS = Object.fromEntries(ROWS.map((row) => [row.id, row.orderNumber]));

/** The SERVER's English — must never reach the screen. */
const SERVER_ENGLISH = "Shipping labels are not configured on this deployment.";

function renderBar(handlers: OrderBulkActionHandlers) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ToastProvider closeLabel="Cerrar">
        <OrderBulkActions formId={FORM} orderNumbers={NUMBERS} handlers={handlers} />
        <DataTable
          caption="Pedidos"
          columns={[{ key: "n", header: "Pedido", cell: (row) => row.orderNumber }]}
          rows={ROWS}
          rowKey={(row) => row.id}
          selection={{
            form: FORM,
            header: "Seleccionar todos",
            label: (row) => `Seleccionar ${row.orderNumber}`,
          }}
        />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

function handlers(overrides: Partial<OrderBulkActionHandlers> = {}): OrderBulkActionHandlers {
  return {
    generate: vi.fn(async () => ({ ok: true as const, data: { accepted: [], skipped: [] } })),
    print: vi.fn(async () => ({
      ok: true as const,
      data: { pdfBase64: "JVBERi0=", count: 1, skippedOrderIds: [] },
    })),
    ...overrides,
  };
}

beforeEach(() => {
  refresh.mockClear();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<OrderBulkActions />", () => {
  it("is inert with nothing selected", () => {
    renderBar(handlers());
    expect(screen.getByRole("button", { name: "Generar etiquetas" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Imprimir etiquetas" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Ningún pedido seleccionado");
  });

  it("generates for the selected rows in ROW order, with one idempotency key, and reports the split", async () => {
    const user = userEvent.setup();
    const generate = vi.fn<OrderBulkActionHandlers["generate"]>(async () => ({
      ok: true as const,
      data: {
        accepted: ["AK-2026-000001"],
        skipped: [
          {
            orderId: "33333333-3333-4333-8333-333333333333",
            orderNumber: "AK-2026-000003",
            reason: "RATE_NOT_MAPPED" as const,
          },
        ],
      },
    }));
    renderBar(handlers({ generate }));

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000003" }));
    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000001" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 pedidos seleccionados");

    await user.click(screen.getByRole("button", { name: "Generar etiquetas" }));

    expect(generate).toHaveBeenCalledTimes(1);
    const [ids, key] = generate.mock.calls[0] ?? [];
    expect(ids).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    // The tally in a toast, the per-order reason on the page, in OUR words.
    expect(await screen.findByText("1 etiqueta en preparación · 1 omitida")).toBeInTheDocument();
    expect(
      screen.getByText(
        "AK-2026-000003: Su método de envío no está vinculado a Sendcloud; envíalo a mano",
      ),
    ).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
    // The selection is cleared for the next batch.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Generar etiquetas" })).toBeDisabled();
    });
  });

  it("keeps the SAME key when a failed request is retried, and never shows the server's English", async () => {
    const user = userEvent.setup();
    const generate = vi.fn<OrderBulkActionHandlers["generate"]>(async () => ({
      ok: false as const,
      code: "CONFLICT" as const,
      reason: "FULFILMENT_NOT_CONFIGURED",
      message: SERVER_ENGLISH,
    }));
    renderBar(handlers({ generate }));

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar todos" }));
    await user.click(screen.getByRole("button", { name: "Generar etiquetas" }));
    expect(
      await screen.findByText("Sendcloud no está configurado en este entorno."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generar etiquetas" }));

    const keys = generate.mock.calls.map((call) => call[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(screen.queryByText(SERVER_ENGLISH)).toBeNull();
  });

  it("prints: downloads the PDF and names the orders left out", async () => {
    const user = userEvent.setup();
    const print = vi.fn<OrderBulkActionHandlers["print"]>(async () => ({
      ok: true as const,
      data: {
        pdfBase64: "JVBERi0=",
        count: 1,
        skippedOrderIds: ["22222222-2222-4222-8222-222222222222"],
      },
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderBar(handlers({ print }));

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000002" }));
    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000001" }));
    await user.click(screen.getByRole("button", { name: "Imprimir etiquetas" }));

    expect(print).toHaveBeenCalledWith([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(
      await screen.findByText("1 etiqueta en el PDF · 1 pedido sin etiqueta, omitido"),
    ).toBeInTheDocument();
    // Named on the page too: once in its table row, once in the notice.
    expect(screen.getAllByText("AK-2026-000002")).toHaveLength(2);
    click.mockRestore();
  });

  it("says so, in our words, when nothing selected has a label", async () => {
    const user = userEvent.setup();
    const print = vi.fn<OrderBulkActionHandlers["print"]>(async () => ({
      ok: false as const,
      code: "CONFLICT" as const,
      reason: "LABEL_NOT_AVAILABLE",
      message: "This shipment has no stored label.",
    }));
    renderBar(handlers({ print }));

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000001" }));
    await user.click(screen.getByRole("button", { name: "Imprimir etiquetas" }));

    expect(
      await screen.findByText("No hay ninguna etiqueta guardada para imprimir o descargar."),
    ).toBeInTheDocument();
  });
});
