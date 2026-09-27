import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { toMinor, type CurrencyCode, type Minor, type OrderStatus } from "@akai/contracts";

import type { OrderMutationOutcome } from "./order-actions";
import { OrderStatusControl } from "./order-status-control";
import { RefundForm } from "./refund-form";
import esMessages from "../../../messages/es.json";

/**
 * The two mutating controls on an order.
 *
 * WHAT THESE TESTS ARE FOR, in one line each:
 *
 *  - PAID is never offered, from any status, because an order becomes PAID only
 *    through a signature-verified provider webhook. A clickable PAID makes "did
 *    the money arrive" forgeable by anyone with a staff session. Two tests walk
 *    `getAllByRole("option")` for it, which is why the control has to stay a
 *    real `<select>`.
 *  - The failure paragraph renders the CATALOGUE's copy for the error code and
 *    never the API's English. `lib/admin/actions.ts` says `message` is "written
 *    for a log"; only `code` crosses the boundary now, so the server's sentence
 *    cannot be rendered even by accident.
 *  - The idempotency key is minted once, HELD across a failure and rotated only
 *    after a success. That is the difference between one refund and three.
 */

const EUR = "EUR" as CurrencyCode;

/** 100,00 € — the balance most of the refund tests work against. */
const REFUNDABLE: Minor = toMinor(10_000);
const NOTHING_REFUNDED: Minor = toMinor(0);

/** What the API would have written to a log, and what must never be rendered. */
const SERVER_ENGLISH = "Illegal order status transition PAID -> DELIVERED";

function renderWithMessages(ui: ReactNode): void {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const OK: OrderMutationOutcome = { ok: true };

describe("<OrderStatusControl />", () => {
  it("offers only operator-assignable, legal transitions", () => {
    renderWithMessages(
      <OrderStatusControl
        orderNumber="AK-2026-000411"
        current="PAID"
        onTransition={async () => OK}
      />,
    );

    const options = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value !== "");

    // From PAID the state machine also permits REFUNDED and PARTIALLY_REFUNDED,
    // but those are derived from the refund ledger — an operator must not be
    // able to mark an order refunded without any money moving.
    expect(options).toEqual(["FULFILLING", "CANCELLED"]);
  });

  it("never offers PAID from any status", () => {
    // PAID is set only by a signature-verified provider webhook. A clickable PAID
    // would make "did the money arrive" forgeable by anyone with a staff session.
    for (const status of [
      "PENDING",
      "AWAITING_PAYMENT",
      "PAID",
      "PAYMENT_MISMATCH",
      "FULFILLING",
      "SHIPPED",
      "DELIVERED",
    ] as OrderStatus[]) {
      const { unmount } = render(
        <NextIntlClientProvider locale="es" messages={esMessages}>
          <OrderStatusControl
            orderNumber="AK-2026-000411"
            current={status}
            onTransition={async () => OK}
          />
        </NextIntlClientProvider>,
      );

      const values = screen
        .queryAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value);
      expect(values).not.toContain("PAID");
      unmount();
    }
  });

  it("keeps the panel live in PAYMENT_MISMATCH, offering CANCELLED", () => {
    // The artboard captions this panel "con un importe no coincidente, ninguna".
    // It is wrong: `adminTransitionOptions("PAYMENT_MISMATCH")` is ["CANCELLED"],
    // and cancelling is one of the two resolutions the code actually offers.
    renderWithMessages(
      <OrderStatusControl
        orderNumber="AK-2026-000411"
        current="PAYMENT_MISMATCH"
        onTransition={async () => OK}
      />,
    );

    const options = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value !== "");

    expect(options).toEqual(["CANCELLED"]);
    expect(screen.queryByTestId("no-transitions")).toBeNull();
  });

  it("renders no control at all from a terminal status", () => {
    renderWithMessages(
      <OrderStatusControl
        orderNumber="AK-2026-000411"
        current="REFUNDED"
        onTransition={async () => OK}
      />,
    );

    // Hidden, not disabled: a greyed-out dropdown invites the operator to hunt
    // for a permission that does not exist.
    expect(screen.getByTestId("no-transitions")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("submits the chosen status with a trimmed internal note", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn<
      (status: OrderStatus, note: string | undefined) => Promise<OrderMutationOutcome>
    >(async () => OK);

    renderWithMessages(
      <OrderStatusControl
        orderNumber="AK-2026-000411"
        current="PAID"
        onTransition={onTransition}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Nuevo estado"), "FULFILLING");
    await user.type(screen.getByLabelText("Nota interna (opcional)"), "  picking  ");
    await user.click(screen.getByRole("button", { name: "Aplicar cambio…" }));

    await waitFor(() => expect(onTransition).toHaveBeenCalledWith("FULFILLING", "picking"));
  });

  it("sends undefined rather than an empty note", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn<
      (status: OrderStatus, note: string | undefined) => Promise<OrderMutationOutcome>
    >(async () => OK);

    renderWithMessages(
      <OrderStatusControl
        orderNumber="AK-2026-000411"
        current="PAID"
        onTransition={onTransition}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Nuevo estado"), "FULFILLING");
    await user.click(screen.getByRole("button", { name: "Aplicar cambio…" }));

    await waitFor(() => expect(onTransition).toHaveBeenCalledWith("FULFILLING", undefined));
  });

  it("renders the catalogue's copy for the refusal, never the server's English", async () => {
    const user = userEvent.setup();

    renderWithMessages(
      <OrderStatusControl
        orderNumber="AK-2026-000411"
        current="PAID"
        onTransition={async () => ({ ok: false, code: "ILLEGAL_STATE_TRANSITION" })}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Nuevo estado"), "FULFILLING");
    await user.click(screen.getByRole("button", { name: "Aplicar cambio…" }));

    // The server is still the enforcement point and can refuse — a concurrent
    // edit may have moved the order since this page rendered. What the operator
    // reads is the CODE looked up in the catalogue, with the refused transition
    // named from the client-side machine.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Ese cambio de estado no está permitido");
    expect(alert).toHaveTextContent("de Pagado a Preparando");
    // The negative half, mirroring discount-editor.test.tsx: `result.message` is
    // the API's own English and this surface must never reach for it. It no
    // longer even crosses the boundary — only `code` does.
    expect(alert).not.toHaveTextContent(SERVER_ENGLISH);
  });

  it("confirms a dispatch before mutating", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn<
      (status: OrderStatus, note: string | undefined) => Promise<OrderMutationOutcome>
    >(async () => OK);

    renderWithMessages(
      <OrderStatusControl
        orderNumber="AK-2026-000411"
        current="FULFILLING"
        onTransition={onTransition}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Nuevo estado"), "SHIPPED");
    await user.click(screen.getByRole("button", { name: "Aplicar cambio…" }));

    // SHIPPED emails the customer to say the parcel is on its way. That is not
    // reversible by picking another option afterwards, so it is gated.
    expect(onTransition).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("AK-2026-000411");

    await user.click(screen.getByRole("button", { name: "Cambiar estado" }));
    await waitFor(() => expect(onTransition).toHaveBeenCalledWith("SHIPPED", undefined));
  });
});

describe("<RefundForm />", () => {
  function renderForm(options: {
    readonly remainingRefundable?: Minor;
    readonly onSubmit: (body: unknown, key: string) => Promise<OrderMutationOutcome>;
    readonly generateKey?: () => string;
  }): void {
    renderWithMessages(
      <RefundForm
        currency={EUR}
        locale="es"
        remainingRefundable={options.remainingRefundable ?? REFUNDABLE}
        refundedTotal={NOTHING_REFUNDED}
        onSubmit={options.onSubmit}
        {...(options.generateKey === undefined ? {} : { generateKey: options.generateKey })}
      />,
    );
  }

  /** Open the type-to-confirm sheet, type the amount it asks for, confirm. */
  async function confirmRefund(
    user: ReturnType<typeof userEvent.setup>,
    phrase: string,
  ): Promise<void> {
    await user.click(screen.getByRole("button", { name: "Reembolsar…" }));
    await user.type(screen.getByLabelText(/Escribe/), phrase);
    await user.click(screen.getByRole("button", { name: "Reembolsar" }));
  }

  it("offers the EU right of withdrawal and no reason without an enum member", () => {
    const onSubmit = vi.fn<(body: unknown, key: string) => Promise<OrderMutationOutcome>>(
      async () => OK,
    );
    renderForm({ onSubmit });

    const reasons = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    // WITHDRAWAL_RIGHT is the 14-day right an EU shop refunds under most often
    // and the artboard omits it; the artboard's own first option ("Cobro
    // incorrecto del proveedor") has no member in `refundReasonSchema` at all,
    // so it maps to OTHER plus the free-text note.
    expect(reasons).toContain("WITHDRAWAL_RIGHT");
    expect(reasons).toEqual([
      "REQUESTED_BY_CUSTOMER",
      "WITHDRAWAL_RIGHT",
      "DAMAGED",
      "DUPLICATE",
      "FRAUDULENT",
      "OTHER",
    ]);
  });

  it("omits the amount for a full refund", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(body: unknown, key: string) => Promise<OrderMutationOutcome>>(
      async () => OK,
    );

    renderForm({ onSubmit, generateKey: () => "key-1" });
    await confirmRefund(user, "100.00");

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Absent means "the full remaining balance, resolved server-side". Sending
    // an explicit 0 or null would mean something else entirely, and
    // `createRefundSchema` is `.strict()`.
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("amount");
  });

  it("converts a partial refund amount to integer minor units", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(body: unknown, key: string) => Promise<OrderMutationOutcome>>(
      async () => OK,
    );

    renderForm({ onSubmit, generateKey: () => "key-1" });

    await user.type(screen.getByLabelText("Importe (EUR)"), "25.50");
    await confirmRefund(user, "25.50");

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ amount: 2550 });
  });

  it("refuses an amount above the refundable balance", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(body: unknown, key: string) => Promise<OrderMutationOutcome>>(
      async () => OK,
    );

    renderForm({ remainingRefundable: toMinor(5_000), onSubmit, generateKey: () => "key-1" });

    await user.type(screen.getByLabelText("Importe (EUR)"), "75.00");
    await user.click(screen.getByRole("button", { name: "Reembolsar…" }));

    // The confirmation never opens: its phrase IS the amount, and there is no
    // amount to confirm.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent(/quedan por reembolsar/i);
  });

  it("reuses the idempotency key across a retry of the same attempt", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const onSubmit = vi.fn<(body: unknown, key: string) => Promise<OrderMutationOutcome>>(
      async () => {
        attempt += 1;
        return attempt === 1 ? { ok: false, code: "INTERNAL_ERROR" } : OK;
      },
    );

    let counter = 0;
    renderForm({ onSubmit, generateKey: () => `key-${(counter += 1)}` });

    await confirmRefund(user, "100.00");
    await screen.findByRole("alert");

    // The dialog stays OPEN on failure — closing it looks exactly like success —
    // so the retry is a second press of the same confirm button.
    await user.click(screen.getByRole("button", { name: "Reembolsar" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    // THE point of the key: if the first request actually reached the API and
    // only the response was lost, the retry must replay it rather than issue a
    // second refund. A fresh key per click would make each retry a new
    // money-creating request.
    expect(onSubmit.mock.calls[0]?.[1]).toBe(onSubmit.mock.calls[1]?.[1]);
  });

  it("rotates the idempotency key after a success", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(body: unknown, key: string) => Promise<OrderMutationOutcome>>(
      async () => OK,
    );

    let counter = 0;
    renderForm({ onSubmit, generateKey: () => `key-${(counter += 1)}` });

    await user.type(screen.getByLabelText("Importe (EUR)"), "10.00");
    await confirmRefund(user, "10.00");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText("Importe (EUR)"), "15.00");
    await confirmRefund(user, "15.00");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    // A second partial refund is a genuinely DIFFERENT operation. Holding the
    // key across a success would make it replay the first response and move no
    // money at all.
    expect(onSubmit.mock.calls[0]?.[1]).not.toBe(onSubmit.mock.calls[1]?.[1]);
  });

  it("disables the control when nothing is refundable", () => {
    renderForm({ remainingRefundable: toMinor(0), onSubmit: async () => OK });

    expect(screen.getByRole("button", { name: "Reembolsar…" })).toBeDisabled();
  });
});
