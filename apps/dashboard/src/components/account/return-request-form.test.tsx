import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { OrderSummary } from "@akai/contracts";

import type { RequestReturnResult } from "@/app/[locale]/(customer)/returns/actions";
import { buildOrderSummary } from "@/lib/account/fixtures";

import { ReturnRequestForm, type EligibleOrder } from "./return-request-form";
import esMessages from "../../../messages/es.json";

/**
 * The returns form, which shipped with no coverage at all.
 *
 * Two invariants are worth more than the rest and are asserted directly:
 *
 *   1. NO SERVER PROSE REACHES THE CUSTOMER. The action hands back a bare
 *      `string` key; anything the component does not recognise must become the
 *      generic translated line, not a key path and not the server's own words.
 *   2. THE PICKER IS THE ONLY WAY TO NAME AN ORDER, so an empty eligible set is
 *      an explanation and never a select with nothing in it.
 *
 * Queried by role, accessible name and label text throughout — the wiring these
 * assertions exercise (`htmlFor`/`id`, `role="alert"` on failures and
 * `role="status"` on confirmations) is exactly what a screen-reader user gets.
 */

/** The four fields the picker needs, minted through the real contract schema. */
function eligible(overrides: Record<string, unknown> = {}): EligibleOrder {
  const order: OrderSummary = buildOrderSummary({ status: "DELIVERED", ...overrides });
  return {
    orderNumber: order.orderNumber,
    placedAt: order.placedAt,
    grandTotal: order.grandTotal,
    currency: order.currency,
  };
}

const ACCEPTED: RequestReturnResult = { ok: true };

function renderForm(options: {
  orders?: readonly EligibleOrder[];
  onSubmit?: (formData: FormData) => Promise<RequestReturnResult>;
}) {
  const orders = options.orders ?? [eligible()];
  // Wrapped rather than passed straight through: a caller-supplied handler is a
  // plain function, and the assertions below read `.mock`, so the spy has to be
  // minted here in every branch.
  const onSubmit: Mock<(formData: FormData) => Promise<RequestReturnResult>> =
    options.onSubmit === undefined
      ? vi.fn(async (): Promise<RequestReturnResult> => ACCEPTED)
      : vi.fn(options.onSubmit);

  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ReturnRequestForm orders={orders} onSubmit={onSubmit} />
    </NextIntlClientProvider>,
  );

  return { onSubmit, orders };
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.type(screen.getByLabelText(/^Motivo/), "El precinto llegó roto");
  const submit = screen.getByRole("button", { name: "Enviar solicitud" });
  await user.click(submit);
  return submit;
}

describe("ReturnRequestForm", () => {
  it("labels the order picker and the reason field", () => {
    renderForm({});

    expect(screen.getByLabelText(/^Pedido/)).toBe(screen.getByRole("combobox"));
    expect(screen.getByLabelText(/^Motivo/)).toBeInTheDocument();
  });

  it("lists exactly the eligible orders, with the date and the total", () => {
    const orders = [
      eligible({ orderNumber: "AK-2026-000123" }),
      eligible({ orderNumber: "AK-2026-000124" }),
    ];
    renderForm({ orders });

    const options = within(screen.getByRole("combobox")).getAllByRole("option");

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("AK-2026-000123"),
      expect.stringContaining("AK-2026-000124"),
    ]);
    // Minor units formatted through `@akai/money`, never a raw 12098.
    expect(options[0]?.textContent).toContain("120.980");
    expect(options[0]?.textContent).not.toContain("12098");
  });

  it("explains the window instead of offering an empty picker", () => {
    // A disabled select with nothing in it reads as a broken account; the empty
    // state says what has to be true before a return can be raised.
    renderForm({ orders: [] });

    expect(
      screen.getByText("Ningún pedido se puede devolver ahora"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enviar solicitud" }),
    ).not.toBeInTheDocument();
  });

  it("submits the picked order number and the trimmed reason", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({
      orders: [
        eligible({ orderNumber: "AK-2026-000123" }),
        eligible({ orderNumber: "AK-2026-000124" }),
      ],
    });

    await user.selectOptions(screen.getByRole("combobox"), "AK-2026-000124");
    await user.type(screen.getByLabelText(/^Motivo/), "  Producto equivocado  ");
    await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const sent = onSubmit.mock.calls[0]?.[0];
    expect(sent?.get("orderNumber")).toBe("AK-2026-000124");
    expect(sent?.get("reason")).toBe("Producto equivocado");
    // The strict request schema accepts these two fields and rejects the body
    // outright if a third arrives.
    expect([...(sent?.keys() ?? [])]).toEqual(["orderNumber", "reason"]);
  });

  it("confirms an accepted request without interrupting", async () => {
    const user = userEvent.setup();
    renderForm({});

    await fillAndSubmit(user);

    const confirmation = await screen.findByRole("status");
    expect(confirmation).toHaveTextContent("Hemos recibido tu solicitud.");
  });

  it("refuses to submit an empty reason and says which field is wrong", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({});

    await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

    expect(await screen.findByText("Cuéntanos el motivo.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Motivo/)).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders the translated message for a refused request", async () => {
    const user = userEvent.setup();
    renderForm({
      onSubmit: vi.fn(
        async (): Promise<RequestReturnResult> => ({ ok: false, errorKey: "alreadyOpen" }),
      ),
    });

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Ya hay una devolución abierta para ese pedido.");
  });

  it("never renders a server-authored key or message", async () => {
    // `RequestReturnResult.errorKey` is a bare `string`. An unrecognised one is
    // collapsed to the generic line — interpolating it into `t()` would print
    // `account.returns.errors.Order not found` in front of a customer.
    const user = userEvent.setup();
    renderForm({
      onSubmit: vi.fn(
        async (): Promise<RequestReturnResult> => ({
          ok: false,
          errorKey: "Order not found",
        }),
      ),
    });

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "No hemos podido enviar la solicitud. Inténtalo de nuevo.",
    );
    expect(screen.queryByText(/Order not found/)).not.toBeInTheDocument();
  });

  it("still shows feedback when the action rejects outright", async () => {
    // A network fault or a redeploy mid-submit. Without the catch this is an
    // unhandled rejection in the console and a form that simply does nothing.
    const user = userEvent.setup();
    renderForm({
      onSubmit: vi.fn(async (): Promise<RequestReturnResult> => {
        throw new Error("socket hang up");
      }),
    });

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "No hemos podido enviar la solicitud. Inténtalo de nuevo.",
    );
    expect(screen.queryByText(/socket hang up/)).not.toBeInTheDocument();
  });

  it("blocks a second submission while the first is in flight", async () => {
    const user = userEvent.setup();
    let settle: ((result: RequestReturnResult) => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<RequestReturnResult>((resolve) => {
          settle = resolve;
        }),
    );

    renderForm({ onSubmit });

    const submit = await fillAndSubmit(user);

    // Announced as busy rather than disabled: disabling the pressed control
    // drops focus to <body> and loses a keyboard user their place.
    await waitFor(() => {
      expect(submit).toHaveAttribute("aria-busy", "true");
    });

    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    settle?.(ACCEPTED);
    await waitFor(() => {
      expect(submit).not.toHaveAttribute("aria-busy");
    });
  });
});
