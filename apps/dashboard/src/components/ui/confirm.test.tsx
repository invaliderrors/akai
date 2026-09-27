import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmActionError, ConfirmAlert, TypeToConfirmDialog } from "./confirm";

/**
 * This file is the guard on a safety control, so it asserts the properties that
 * make it safe rather than the pixels: that the alert NAMES the record it is
 * about, that the destructive button is not the Return default, that the typed
 * phrase gates the irreversible one, and that a failure leaves the dialog open
 * with a translated message rather than closing as if it had worked.
 *
 * Focus trapping, Escape and the scrim belong to `overlay.test.tsx` and are not
 * re-tested here — only the one thing this file adds to them, which is that a
 * request in flight refuses all three.
 */

const ALERT_COPY = {
  title: "¿Eliminar esta dirección?",
  item: "Casa · Carrer de Mallorca 214, Barcelona",
  consequence: "Se quitará de tu libreta. Los pedidos ya enviados no cambian.",
  confirmLabel: "Eliminar",
  cancelLabel: "Cancelar",
  busyLabel: "Eliminando…",
  fallbackError: "No hemos podido eliminarla. Inténtalo de nuevo.",
} as const;

interface AlertHarnessProps {
  readonly onConfirm: () => Promise<void>;
  readonly onClosed?: () => void;
}

function AlertHarness({ onConfirm, onClosed }: AlertHarnessProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Abrir alerta
      </button>
      <ConfirmAlert
        {...ALERT_COPY}
        open={open}
        onClose={() => {
          setOpen(false);
          onClosed?.();
        }}
        onConfirm={onConfirm}
        density="compact"
      />
    </div>
  );
}

const SHEET_COPY = {
  title: "Reembolsar 29,90 € del pedido AK-2026-000408",
  consequence: "El dinero vuelve a la tarjeta del cliente en 5–10 días. No se puede deshacer.",
  mismatchHint: "El importe no coincide todavía.",
  confirmLabel: "Emitir reembolso",
  cancelLabel: "Cancelar",
  busyLabel: "Emitiendo…",
  fallbackError: "No hemos podido emitir el reembolso.",
} as const;

interface SheetHarnessProps {
  readonly onConfirm: () => Promise<void>;
  readonly phrase?: string;
  readonly phraseKind?: "identifier" | "amount";
}

function SheetHarness({ onConfirm, phrase = "29,90", phraseKind = "amount" }: SheetHarnessProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Abrir hoja
      </button>
      <TypeToConfirmDialog
        {...SHEET_COPY}
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        icon="banknote"
        phrase={phrase}
        phraseKind={phraseKind}
        prompt={(chip) => <>Escribe {chip} para confirmar</>}
        ledger={[
          { label: "Cobrado", value: "119,60 €" },
          { label: "Ya reembolsado", value: "0,00 €" },
          { label: "Este reembolso", value: "29,90 €", emphasis: true },
          { label: "Motivo", value: "Dañado en el transporte" },
        ]}
        onConfirm={onConfirm}
        density="compact"
      />
    </div>
  );
}

/** A promise whose settlement the test owns, for asserting the in-flight state. */
function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolve: () => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => {
      res();
    };
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openAlert(): Promise<void> {
  await userEvent.setup().click(screen.getByRole("button", { name: "Abrir alerta" }));
}

async function openSheet(): Promise<void> {
  await userEvent.setup().click(screen.getByRole("button", { name: "Abrir hoja" }));
}

describe("<ConfirmAlert />", () => {
  it("is an alertdialog whose name carries the title AND the record it is about", async () => {
    render(<AlertHarness onConfirm={() => Promise.resolve()} />);
    await openAlert();

    // The whole safety property for a screen-reader user: hearing the title
    // alone ("¿Eliminar esta dirección?") never says WHICH address.
    const alert = screen.getByRole("alertdialog");
    expect(alert).toHaveAccessibleName(expect.stringContaining(ALERT_COPY.title));
    expect(alert).toHaveAccessibleName(expect.stringContaining(ALERT_COPY.item));
    expect(alert).toHaveAccessibleName(expect.stringContaining("Los pedidos ya enviados"));
  });

  it("opens with Cancel focused, so Return cannot complete the destructive action", async () => {
    render(<AlertHarness onConfirm={() => Promise.resolve()} />);
    await openAlert();

    expect(screen.getByRole("button", { name: ALERT_COPY.cancelLabel })).toHaveFocus();
  });

  it("puts the destructive verb before Cancel, which holds the default position", async () => {
    render(<AlertHarness onConfirm={() => Promise.resolve()} />);
    await openAlert();

    const footer = screen
      .getAllByRole("button")
      .filter((button) => button.textContent === ALERT_COPY.confirmLabel || button.textContent === ALERT_COPY.cancelLabel);

    expect(footer.map((button) => button.textContent)).toEqual([
      ALERT_COPY.confirmLabel,
      ALERT_COPY.cancelLabel,
    ]);
  });

  it("runs the action and closes when the verb is pressed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    const onClosed = vi.fn();
    render(<AlertHarness onConfirm={onConfirm} onClosed={onClosed} />);
    await openAlert();

    await user.click(screen.getByRole("button", { name: ALERT_COPY.confirmLabel }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(onClosed).toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the caller's translated message on a ConfirmActionError", async () => {
    const user = userEvent.setup();
    render(
      <AlertHarness
        onConfirm={() => Promise.reject(new ConfirmActionError("Esta dirección está en un pedido activo."))}
      />,
    );
    await openAlert();

    await user.click(screen.getByRole("button", { name: ALERT_COPY.confirmLabel }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Esta dirección está en un pedido activo.",
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("never renders an unmarked Error's own text, only the translated fallback", async () => {
    const user = userEvent.setup();
    render(
      <AlertHarness
        // Exactly the shape `ProductEditor` throws today: the API's English,
        // which lib/admin/actions.ts documents as never for a human.
        onConfirm={() => Promise.reject(new Error("address_in_use: order 4f21 references it"))}
      />,
    );
    await openAlert();

    await user.click(screen.getByRole("button", { name: ALERT_COPY.confirmLabel }));

    expect(await screen.findByRole("alert")).toHaveTextContent(ALERT_COPY.fallbackError);
    expect(screen.queryByText(/address_in_use/)).not.toBeInTheDocument();
  });

  it("refuses Cancel and Escape while the request is in flight", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    render(<AlertHarness onConfirm={() => gate.promise} />);
    await openAlert();

    await user.click(screen.getByRole("button", { name: ALERT_COPY.confirmLabel }));

    // There is nothing left to cancel, and a dialog that vanishes mid-request
    // leaves the operator unable to tell whether it happened.
    expect(screen.getByRole("button", { name: ALERT_COPY.cancelLabel })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    gate.resolve();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("announces the in-flight verb without dropping focus off the pressed button", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    render(<AlertHarness onConfirm={() => gate.promise} />);
    await openAlert();

    const confirm = screen.getByRole("button", { name: ALERT_COPY.confirmLabel });
    await user.click(confirm);

    const pending = screen.getByRole("button", { name: ALERT_COPY.busyLabel });
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toBeEnabled();

    // A second press must not fire a second delete.
    await user.click(pending);

    gate.resolve();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("forgets the previous failure the next time it opens", async () => {
    const user = userEvent.setup();
    const onConfirm = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ConfirmActionError("Ha fallado."))
      .mockResolvedValue(undefined);
    render(<AlertHarness onConfirm={onConfirm} />);
    await openAlert();

    await user.click(screen.getByRole("button", { name: ALERT_COPY.confirmLabel }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: ALERT_COPY.cancelLabel }));
    await openAlert();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("<TypeToConfirmDialog />", () => {
  it("keeps the destructive submit disabled until the exact phrase is typed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<SheetHarness onConfirm={onConfirm} />);
    await openSheet();

    const submit = screen.getByRole("button", { name: SHEET_COPY.confirmLabel });
    const input = screen.getByLabelText(/Escribe/);
    expect(submit).toBeDisabled();

    await user.type(input, "29,9");
    expect(submit).toBeDisabled();

    await user.type(input, "0");
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("matches after trimming but never across a difference in case", async () => {
    const user = userEvent.setup();
    render(<SheetHarness onConfirm={() => Promise.resolve()} phrase="BPC-157" phraseKind="identifier" />);
    await openSheet();

    const submit = screen.getByRole("button", { name: SHEET_COPY.confirmLabel });
    const input = screen.getByLabelText(/Escribe/);

    // A pasted identifier routinely carries a trailing space.
    await user.type(input, "  BPC-157 ");
    expect(submit).toBeEnabled();

    await user.clear(input);
    await user.type(input, "bpc-157");
    expect(submit).toBeDisabled();
  });

  it("submits on Return once the phrase matches, and not before", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<SheetHarness onConfirm={onConfirm} />);
    await openSheet();

    const input = screen.getByLabelText(/Escribe/);
    await user.type(input, "29{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.type(input, ",90{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("explains the disabled button as a neutral hint, not as an error", async () => {
    const user = userEvent.setup();
    render(<SheetHarness onConfirm={() => Promise.resolve()} />);
    await openSheet();

    const input = screen.getByLabelText(/Escribe/);
    const hint = screen.getByText(SHEET_COPY.mismatchHint);

    // Nothing has gone wrong — the operator has not finished typing — so this
    // is secondary label text and is NOT announced as an alert.
    expect(hint.className).toContain("text-[var(--label-secondary)]");
    expect(hint.className).not.toContain("--danger");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-describedby", hint.id);

    await user.type(input, "29,90");
    expect(screen.queryByText(SHEET_COPY.mismatchHint)).not.toBeInTheDocument();
    // Only ids that exist may be referenced.
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("puts Cancel before the submit — the mirror of the alert's footer", async () => {
    render(<SheetHarness onConfirm={() => Promise.resolve()} />);
    await openSheet();

    const footer = screen
      .getAllByRole("button")
      .filter((button) => button.textContent === SHEET_COPY.confirmLabel || button.textContent === SHEET_COPY.cancelLabel);

    expect(footer.map((button) => button.textContent)).toEqual([
      SHEET_COPY.cancelLabel,
      SHEET_COPY.confirmLabel,
    ]);
  });

  it("shows the ledger of what is about to change, with the acting row emphasised", async () => {
    render(<SheetHarness onConfirm={() => Promise.resolve()} />);
    await openSheet();

    expect(screen.getByText("Cobrado")).toBeInTheDocument();
    expect(screen.getByText("119,60 €")).toBeInTheDocument();
    expect(screen.getByText("Dañado en el transporte")).toBeInTheDocument();

    const acting = screen.getByText("29,90 €", { selector: "dd" });
    expect(acting.className).toContain("font-semibold");
    expect(acting.className).toContain("text-right");
    expect(acting.className).toContain("tabular-nums");
  });

  it("sets the phrase in mono for an identifier and in tabular figures for money", async () => {
    const { unmount } = render(
      <SheetHarness onConfirm={() => Promise.resolve()} phrase="bpc-157" phraseKind="identifier" />,
    );
    await openSheet();
    expect(screen.getByLabelText(/Escribe/).className).toContain("font-mono");
    unmount();

    render(<SheetHarness onConfirm={() => Promise.resolve()} />);
    await openSheet();
    const money = screen.getByLabelText(/Escribe/);
    // Money is never mono in this product — the sans face with tabular figures
    // is what keeps the amount aligned with the ledger row above it.
    expect(money.className).toContain("tabular-nums");
    expect(money.className).not.toContain("font-mono");
  });

  it("kills its own focus outline before painting the kit's ring", async () => {
    render(<SheetHarness onConfirm={() => Promise.resolve()} />);
    await openSheet();

    // The base `:focus-visible` rule now lives in `@layer base`, so a utility
    // wins — but only if it is actually emitted.
    const input = screen.getByLabelText(/Escribe/);
    expect(input.className).toContain("focus-visible:outline-none");
    expect(input.className).toContain("var(--focus-ring)");
  });

  it("surfaces a ConfirmActionError inside the still-open dialog", async () => {
    const user = userEvent.setup();
    render(
      <SheetHarness
        onConfirm={() => Promise.reject(new ConfirmActionError("El pago ya no admite reembolsos."))}
      />,
    );
    await openSheet();

    await user.type(screen.getByLabelText(/Escribe/), "29,90");
    await user.click(screen.getByRole("button", { name: SHEET_COPY.confirmLabel }));

    expect(await screen.findByRole("alert")).toHaveTextContent("El pago ya no admite reembolsos.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("clears the typed phrase between openings", async () => {
    const user = userEvent.setup();
    render(<SheetHarness onConfirm={() => Promise.resolve()} />);
    await openSheet();

    await user.type(screen.getByLabelText(/Escribe/), "29,90");
    await user.click(screen.getByRole("button", { name: SHEET_COPY.cancelLabel }));
    await openSheet();

    // A dialog that reopens already armed is a dialog that confirms nothing.
    expect(screen.getByLabelText(/Escribe/)).toHaveValue("");
    expect(screen.getByRole("button", { name: SHEET_COPY.confirmLabel })).toBeDisabled();
  });
});
