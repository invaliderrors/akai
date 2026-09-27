import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Checkbox, RadioGroup, Switch } from "./toggle";

describe("<Checkbox />", () => {
  it("is a real checkbox named by its label", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Checkbox label="Incluir eliminados" checked={false} onChange={onChange} />,
    );

    const box = screen.getByRole("checkbox", { name: "Incluir eliminados" });
    expect(box).not.toBeChecked();

    await user.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports the mixed state as mixed", () => {
    render(
      <Checkbox
        label="Todas las variantes"
        checked={false}
        indeterminate
        onChange={vi.fn()}
      />,
    );

    const box = screen.getByRole("checkbox", { name: "Todas las variantes" });
    // "mixed", not "unchecked": a select-all over a partially selected list is
    // a third state, and announcing it as unchecked tells the operator their
    // selection is gone.
    expect(box).toHaveAttribute("aria-checked", "mixed");
    expect(box).toBePartiallyChecked();
  });

  it("sets the indeterminate DOM property, which has no attribute of its own", () => {
    render(
      <Checkbox label="Todas" checked={false} indeterminate onChange={vi.fn()} />,
    );

    const box = screen.getByRole("checkbox", { name: "Todas" });
    expect(box).toBeInstanceOf(HTMLInputElement);
    if (box instanceof HTMLInputElement) {
      expect(box.indeterminate).toBe(true);
    }
  });

  it("drops the mixed state when it stops being mixed", () => {
    const { rerender } = render(
      <Checkbox label="Todas" checked={false} indeterminate onChange={vi.fn()} />,
    );
    rerender(<Checkbox label="Todas" checked onChange={vi.fn()} />);

    const box = screen.getByRole("checkbox", { name: "Todas" });
    expect(box).not.toHaveAttribute("aria-checked", "mixed");
    expect(box).toBeChecked();
    if (box instanceof HTMLInputElement) {
      expect(box.indeterminate).toBe(false);
    }
  });

  it("does not fire when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Checkbox label="Marketing" checked={false} disabled onChange={onChange} />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Marketing" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a visually hidden label in the accessibility tree", () => {
    render(
      <Checkbox label="Seleccionar todo" checked={false} onChange={vi.fn()} labelHidden />,
    );

    expect(
      screen.getByRole("checkbox", { name: "Seleccionar todo" }),
    ).toBeInTheDocument();
  });
});

describe("<RadioGroup />", () => {
  const REASONS = [
    { value: "DAMAGED", label: "Dañado en el transporte" },
    { value: "WRONG_ITEM", label: "Pedido equivocado" },
    { value: "NOT_NEEDED", label: "Ya no lo necesito" },
  ] as const;

  it("takes its accessible name from the legend", () => {
    render(
      <RadioGroup
        legend="Motivo"
        name="reason"
        value={null}
        options={REASONS}
        onChange={vi.fn()}
      />,
    );

    // Without the legend, a screen-reader user arriving at the third option
    // hears "Ya no lo necesito, radio, 3 of 3" and never learns the question.
    expect(screen.getByRole("group", { name: "Motivo" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("selects nothing until a value is given", () => {
    render(
      <RadioGroup
        legend="Motivo"
        name="reason"
        value={null}
        options={REASONS}
        onChange={vi.fn()}
      />,
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
  });

  it("hands back the option's own literal type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: "DAMAGED" | "WRONG_ITEM" | "NOT_NEEDED") => void>();
    render(
      <RadioGroup
        legend="Motivo"
        name="reason"
        value="DAMAGED"
        options={REASONS}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("radio", { name: "Dañado en el transporte" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Pedido equivocado" }));
    expect(onChange).toHaveBeenCalledWith("WRONG_ITEM");
  });

  it("describes the group with hint and error, and alerts on the error", () => {
    render(
      <RadioGroup
        legend="Motivo"
        name="reason"
        value={null}
        options={REASONS}
        onChange={vi.fn()}
        hint="Elige el motivo más cercano."
        error="Selecciona un motivo."
      />,
    );

    const group = screen.getByRole("group", { name: "Motivo" });
    const describedBy = group.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(describedBy?.split(" ")).toHaveLength(2);
    for (const id of describedBy?.split(" ") ?? []) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(screen.getByRole("alert")).toHaveTextContent("Selecciona un motivo.");
  });

  it("names only ids it rendered", () => {
    render(
      <RadioGroup
        legend="Motivo"
        name="reason"
        value={null}
        options={REASONS}
        onChange={vi.fn()}
        error="Selecciona un motivo."
      />,
    );

    const describedBy = screen
      .getByRole("group", { name: "Motivo" })
      .getAttribute("aria-describedby");
    expect(describedBy?.split(" ")).toHaveLength(1);
  });

  it("disables every option when the group is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RadioGroup
        legend="Motivo"
        name="reason"
        value={null}
        options={REASONS}
        onChange={onChange}
        disabled
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Pedido equivocado" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("<Switch />", () => {
  /** A caller that owns `checked`, which is the contract a switch assumes. */
  function SwitchHarness({
    onCommit,
    initial = false,
  }: {
    readonly onCommit: (next: boolean) => Promise<void>;
    readonly initial?: boolean;
  }) {
    const [checked, setChecked] = useState(initial);
    return (
      <Switch
        label="Activo en la tienda"
        checked={checked}
        errorMessage="No se pudo guardar. Inténtalo de nuevo."
        onChange={async (next) => {
          await onCommit(next);
          setChecked(next);
        }}
      />
    );
  }

  it("is a switch, not a checkbox", () => {
    render(<SwitchHarness onCommit={vi.fn(async () => {})} />);

    expect(
      screen.getByRole("switch", { name: "Activo en la tienda" }),
    ).toBeInTheDocument();
  });

  it("shows the new position immediately and commits it", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn(async () => {});
    render(<SwitchHarness onCommit={onCommit} />);

    const control = screen.getByRole("switch", { name: "Activo en la tienda" });
    await user.click(control);

    expect(onCommit).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(control).toBeChecked();
    });
  });

  it("locks itself while the commit is in flight, and refuses a second flip", async () => {
    const user = userEvent.setup();
    // Declared with a no-op rather than `null`: control-flow analysis cannot
    // see the assignment inside the promise executor, so a nullable binding
    // narrows to `never` at the call below.
    let release: () => void = () => {};
    const onCommit = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    render(<SwitchHarness onCommit={onCommit} />);
    const control = screen.getByRole("switch", { name: "Activo en la tienda" });

    await user.click(control);

    // `aria-disabled` rather than `disabled`: a real disabled attribute makes
    // the browser blur the control, dumping a keyboard user back to the top of
    // the document for the length of the request.
    await waitFor(() => {
      expect(control).toHaveAttribute("aria-disabled", "true");
    });
    expect(control).toHaveAttribute("aria-busy", "true");

    // A fast double tap must not race two writes whose ordering is decided by
    // the network.
    await user.click(control);
    expect(onCommit).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => {
      expect(control).toHaveAttribute("aria-disabled", "false");
    });
  });

  it("reverts and says so when the commit fails", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn(async () => {
      throw new Error("network");
    });

    render(<SwitchHarness onCommit={onCommit} />);
    const control = screen.getByRole("switch", { name: "Activo en la tienda" });

    await user.click(control);

    // A switch reading "on" over a server that says "off" is a data-loss bug
    // the operator cannot see. Both halves matter: the visual reverts AND the
    // failure is announced.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "No se pudo guardar. Inténtalo de nuevo.",
      );
    });
    expect(control).not.toBeChecked();
  });

  it("clears a previous failure when the next attempt starts", async () => {
    const user = userEvent.setup();
    const onCommit = vi
      .fn<(next: boolean) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);

    render(<SwitchHarness onCommit={onCommit} />);
    const control = screen.getByRole("switch", { name: "Activo en la tienda" });

    await user.click(control);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    await user.click(control);
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(control).toBeChecked();
  });

  it("never commits while disabled", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn(async () => {});
    render(
      <Switch
        label="Sincronización"
        checked={false}
        disabled
        errorMessage="No se pudo guardar."
        onChange={onCommit}
      />,
    );

    await user.click(screen.getByRole("switch", { name: "Sincronización" }));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("describes itself with its hint", () => {
    render(
      <Switch
        label="Avisos por correo"
        checked
        id="email-alerts"
        hint="Se aplica de inmediato."
        errorMessage="No se pudo guardar."
        onChange={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByRole("switch", { name: "Avisos por correo" })).toHaveAttribute(
      "aria-describedby",
      "email-alerts-hint",
    );
  });
});
