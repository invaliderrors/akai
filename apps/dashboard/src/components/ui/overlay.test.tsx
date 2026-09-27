import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";

import { Dialog, Popover } from "./overlay";

/**
 * A hand-rolled focus trap is the classic keyboard regression: it looks right,
 * it demos right, and it silently lets Tab walk out into a page the scrim says
 * is unavailable. Everything the kit floats composes these two components, so
 * the trap, the Escape handling and the focus hand-back are pinned here rather
 * than in each consumer.
 */

interface DialogHarnessProps {
  readonly role?: "dialog" | "alertdialog";
}

function DialogHarness({ role = "dialog" }: DialogHarnessProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Eliminar dirección
      </button>
      <button type="button">Fuera</button>
      <Dialog open={open} onClose={() => setOpen(false)} label="Confirmar" role={role}>
        <button type="button">Cancelar</button>
        <button type="button">Eliminar</button>
      </Dialog>
    </div>
  );
}

function LabelledByHarness() {
  const [open, setOpen] = useState(true);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} labelledBy="confirm-title">
      <h2 id="confirm-title">¿Eliminar esta dirección?</h2>
      <button type="button">Cancelar</button>
    </Dialog>
  );
}

function InitialFocusHarness() {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Reembolsar
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        label="Reembolsar"
        initialFocus={cancelRef}
      >
        <button type="button">Emitir reembolso</button>
        <button type="button" ref={cancelRef}>
          Cancelar
        </button>
      </Dialog>
    </div>
  );
}

async function openDialog(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Eliminar dirección" }));
  return screen.getByRole("dialog");
}

describe("<Dialog />", () => {
  it("renders nothing at all while closed", () => {
    render(<DialogHarness />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
  });

  it("moves focus into the dialog when it opens", async () => {
    render(<DialogHarness />);
    await openDialog();

    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
  });

  it("honours an explicit initial focus over the first tabbable", async () => {
    // A destructive confirmation focuses Cancel, not the verb — the Return key
    // must not be able to complete the dangerous action on its own.
    const user = userEvent.setup();
    render(<InitialFocusHarness />);
    await user.click(screen.getByRole("button", { name: "Reembolsar" }));

    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
  });

  it("returns focus to the invoker when it closes", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await openDialog();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminar dirección" })).toHaveFocus();
  });

  it("cycles Tab inside the trap instead of reaching the page behind it", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await openDialog();

    const cancel = screen.getByRole("button", { name: "Cancelar" });
    const destroy = screen.getByRole("button", { name: "Eliminar" });
    const outside = screen.getByRole("button", { name: "Fuera" });

    await user.tab();
    expect(destroy).toHaveFocus();

    // The wrap: the last control leads back to the first, never to the page.
    await user.tab();
    expect(cancel).toHaveFocus();
    expect(outside).not.toHaveFocus();

    await user.tab({ shift: true });
    expect(destroy).toHaveFocus();
  });

  it("dismisses on a press that starts on the scrim", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const panel = await openDialog();
    const scrim = panel.parentElement;
    if (scrim === null) {
      throw new Error("the dialog panel is expected to sit inside its scrim");
    }

    await user.click(scrim);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does NOT dismiss on a press that starts inside the panel", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const panel = await openDialog();

    await user.click(panel);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("takes its role from the caller and always claims to be modal", async () => {
    render(<DialogHarness role="alertdialog" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Eliminar dirección" }));

    const alert = screen.getByRole("alertdialog", { name: "Confirmar" });
    expect(alert).toHaveAttribute("aria-modal", "true");
  });

  it("takes its name from a heading inside it when given labelledBy", () => {
    render(<LabelledByHarness />);

    expect(screen.getByRole("dialog", { name: "¿Eliminar esta dirección?" })).toBeInTheDocument();
  });

  it("locks the page behind it and gives the scroll position back", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await openDialog();

    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("");
  });
});

function PopoverHarness() {
  return (
    <div>
      <Popover
        label="Cuenta"
        role="menu"
        trigger={(triggerProps) => <button {...triggerProps}>Ana Mestra</button>}
      >
        {(close) => (
          <>
            <button type="button" role="menuitem" onClick={close}>
              Perfil
            </button>
            <button type="button" role="menuitem">
              Cerrar sesión
            </button>
          </>
        )}
      </Popover>
      <button type="button">Fuera</button>
    </div>
  );
}

describe("<Popover />", () => {
  it("tracks the surface on the trigger with aria-expanded", async () => {
    const user = userEvent.setup();
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Ana Mestra" });

    // The only thing that tells a screen-reader user the surface exists.
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a named surface and moves focus into it", async () => {
    const user = userEvent.setup();
    render(<PopoverHarness />);

    await user.click(screen.getByRole("button", { name: "Ana Mestra" }));

    expect(screen.getByRole("menu", { name: "Cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Perfil" })).toHaveFocus();
  });

  it("closes on Escape and hands focus back to the trigger", async () => {
    const user = userEvent.setup();
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Ana Mestra" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when something outside is clicked, and leaves that thing focused", async () => {
    const user = userEvent.setup();
    render(<PopoverHarness />);
    await user.click(screen.getByRole("button", { name: "Ana Mestra" }));

    const outside = screen.getByRole("button", { name: "Fuera" });
    await user.click(outside);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Focus is NOT dragged back to the trigger: the user is already somewhere
    // else, and moving them again is worse than not restoring at all.
    expect(outside).toHaveFocus();
  });

  it("lets an item inside close the surface", async () => {
    const user = userEvent.setup();
    render(<PopoverHarness />);
    await user.click(screen.getByRole("button", { name: "Ana Mestra" }));

    await user.click(screen.getByRole("menuitem", { name: "Perfil" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes again when the trigger is pressed a second time", async () => {
    const user = userEvent.setup();
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Ana Mestra" });

    await user.click(trigger);
    await user.click(trigger);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
