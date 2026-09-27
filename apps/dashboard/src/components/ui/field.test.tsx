import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { formatMinorAsInput, type MoneyInputError } from "@/lib/admin/money-input";
import { toMinor } from "@akai/contracts";

import {
  Field,
  MoneyField,
  PopupButton,
  TextArea,
  TextField,
  type MoneyFieldValue,
} from "./field";

/**
 * These tests are about the WIRING, not the pixels. Every assertion here is one
 * a screen-reader user would feel: what the control is called, what it is
 * described by, and whether it admits to being invalid. Seventy-one
 * `getByLabelText` assertions across the dashboard resolve through this
 * component, so a regression in the `htmlFor`/`id` pair is a regression in all
 * of them at once.
 */

describe("<Field />", () => {
  it("pairs its label with the control the render prop builds", async () => {
    const user = userEvent.setup();
    render(
      <Field label="Nombre" id="given-name">
        {(control) => <input {...control} />}
      </Field>,
    );

    const input = screen.getByLabelText("Nombre");
    expect(input).toHaveAttribute("id", "given-name");

    // Clicking the label must move focus into the control — the observable
    // proof that `htmlFor` actually resolves rather than merely being present.
    await user.click(screen.getByText("Nombre"));
    expect(input).toHaveFocus();
  });

  it("generates an id when the caller does not supply one", () => {
    render(
      <Field label="Apellidos">{(control) => <input {...control} />}</Field>,
    );

    expect(screen.getByLabelText("Apellidos")).toHaveAttribute("id");
  });

  it("keeps the required asterisk trailing and out of the accessible name", () => {
    render(
      <Field label="Nombre" required>
        {(control) => <input {...control} />}
      </Field>,
    );

    // Anchored at the start: whatever else the label renders, "Nombre" comes
    // first and the marker is after it.
    expect(screen.getByLabelText(/^Nombre/)).toBeInTheDocument();
    // And the marker is aria-hidden, so the computed NAME is the label alone —
    // nobody hears "Nombre asterisk".
    expect(screen.getByRole("textbox", { name: "Nombre" })).toBeInTheDocument();
  });

  it("describes the control with the hint alone when there is no error", () => {
    render(
      <Field label="Contraseña" id="pw" hint="Al menos 12 caracteres.">
        {(control) => <input {...control} />}
      </Field>,
    );

    expect(screen.getByLabelText("Contraseña")).toHaveAttribute(
      "aria-describedby",
      "pw-hint",
    );
    // The id sits on the paragraph, which is what `aria-describedby` resolves
    // to — the hint text itself is a span inside it, sharing the row with the
    // counter slot.
    expect(document.getElementById("pw-hint")).toHaveTextContent(
      "Al menos 12 caracteres.",
    );
  });

  it("describes the control with hint AND error, in that order, when both render", () => {
    render(
      <Field
        label="Contraseña"
        id="pw"
        hint="Al menos 12 caracteres."
        error="Tiene 8 caracteres; faltan 4."
      >
        {(control) => <input {...control} />}
      </Field>,
    );

    expect(screen.getByLabelText("Contraseña")).toHaveAttribute(
      "aria-describedby",
      "pw-hint pw-error",
    );
  });

  it("names ONLY ids it actually rendered", () => {
    // A dangling aria-describedby is silently ignored by some screen readers
    // and read as an empty string by others, so an absent hint must not leave
    // its id behind.
    render(
      <Field label="Contraseña" id="pw" error="Obligatorio.">
        {(control) => <input {...control} />}
      </Field>,
    );

    expect(screen.getByLabelText("Contraseña")).toHaveAttribute(
      "aria-describedby",
      "pw-error",
    );
    expect(document.getElementById("pw-hint")).toBeNull();
  });

  it("sets no aria-describedby at all when there is nothing to describe", () => {
    render(<Field label="Nombre">{(control) => <input {...control} />}</Field>);

    expect(screen.getByLabelText("Nombre")).not.toHaveAttribute("aria-describedby");
  });

  it("marks the control invalid only while an error is showing", () => {
    const { rerender } = render(
      <Field label="Correo" error="Introduce una dirección completa.">
        {(control) => <input {...control} />}
      </Field>,
    );

    expect(screen.getByLabelText("Correo")).toHaveAttribute("aria-invalid", "true");

    rerender(<Field label="Correo">{(control) => <input {...control} />}</Field>);

    // Absent, not "false": claiming a field the user has not filled in is valid
    // is a claim we cannot make.
    expect(screen.getByLabelText("Correo")).not.toHaveAttribute("aria-invalid");
  });

  it("announces the error as an alert", () => {
    render(
      <Field label="Correo" error="Introduce una dirección completa.">
        {(control) => <input {...control} />}
      </Field>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Introduce una dirección completa.",
    );
  });

  it("renders a counter beside the hint and describes the field with both", () => {
    render(
      <Field
        label="Descripción"
        id="desc"
        hint="Se muestra en la ficha del producto."
        counter="71 / 400"
      >
        {(control) => <textarea {...control} />}
      </Field>,
    );

    expect(screen.getByText("71 / 400")).toBeInTheDocument();
    expect(screen.getByLabelText("Descripción")).toHaveAttribute(
      "aria-describedby",
      "desc-hint",
    );
  });

  it("keeps a visually hidden label in the accessibility tree", () => {
    render(
      <Field label="Buscar" labelHidden>
        {(control) => <input {...control} />}
      </Field>,
    );

    expect(screen.getByRole("textbox", { name: "Buscar" })).toBeInTheDocument();
  });
});

describe("<TextField />", () => {
  function Harness(props: {
    readonly validate?: (value: string) => string | undefined;
    readonly error?: string;
  }) {
    const [value, setValue] = useState("");
    return (
      <TextField
        label="Correo electrónico"
        name="email"
        type="email"
        value={value}
        onChange={setValue}
        required
        {...(props.validate === undefined ? {} : { validate: props.validate })}
        {...(props.error === undefined ? {} : { error: props.error })}
      />
    );
  }

  it("reports every keystroke to its caller", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextField label="Nombre" name="firstName" value="" onChange={onChange} />,
    );

    await user.type(screen.getByLabelText("Nombre"), "A");

    expect(onChange).toHaveBeenCalledWith("A");
  });

  it("stays silent until the field is blurred, then validates", async () => {
    const user = userEvent.setup();
    const validate = (value: string) =>
      value.includes("@") ? undefined : "Introduce una dirección completa.";

    render(<Harness validate={validate} />);
    const input = screen.getByLabelText(/^Correo electrónico/);

    await user.type(input, "ana");
    // Still typing. Telling someone their address is incomplete while they are
    // three characters into it is the behaviour everyone hates.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");

    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Introduce una dirección completa.",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("clears the error the moment the rule passes, without another blur", async () => {
    const user = userEvent.setup();
    const validate = (value: string) =>
      value.includes("@") ? undefined : "Introduce una dirección completa.";

    render(<Harness validate={validate} />);
    const input = screen.getByLabelText(/^Correo electrónico/);

    await user.type(input, "ana");
    await user.tab();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.type(input, "@example.com");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("lets a caller-supplied error outrank a passing client rule", async () => {
    const user = userEvent.setup();
    render(<Harness validate={() => undefined} error="Ese correo ya está en uso." />);

    await user.tab();

    // The server has seen something the client cannot. A local rule that
    // happens to pass must not erase its verdict.
    expect(screen.getByRole("alert")).toHaveTextContent("Ese correo ya está en uso.");
  });

  it("renders a trailing control inside the same field", () => {
    render(
      <TextField
        label="Número de pedido"
        name="orderNumber"
        value="AK-2026-000412"
        onChange={vi.fn()}
        readOnly
        mono
        trailing={
          <button type="button" aria-label="Copiar">
            copiar
          </button>
        }
      />,
    );

    expect(screen.getByLabelText("Número de pedido")).toHaveValue("AK-2026-000412");
    expect(screen.getByRole("button", { name: "Copiar" })).toBeInTheDocument();
  });
});

describe("<TextArea />", () => {
  it("counts what it has against what it allows", () => {
    render(
      <TextArea
        label="Descripción (es)"
        name="description"
        value="Monohidrato de creatina micronizado."
        onChange={vi.fn()}
        maxLength={400}
      />,
    );

    expect(screen.getByText("36 / 400")).toBeInTheDocument();
  });

  it("shows no counter when there is no ceiling to count against", () => {
    render(
      <TextArea label="Notas" name="notes" value="algo" onChange={vi.fn()} />,
    );

    expect(screen.getByLabelText("Notas")).not.toHaveAttribute("aria-describedby");
  });
});

describe("<MoneyField />", () => {
  function MoneyHarness({
    initial = "",
    onValue,
  }: {
    readonly initial?: string;
    readonly onValue?: (next: MoneyFieldValue) => void;
  }) {
    const [raw, setRaw] = useState(initial);
    return (
      <MoneyField
        label="Precio (IVA incl.)"
        name="price"
        currency="EUR"
        value={raw}
        onChange={(next) => {
          setRaw(next.raw);
          onValue?.(next);
        }}
        required
      />
    );
  }

  it("turns a Spanish-typed amount into integer minor units", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<MoneyHarness onValue={onValue} />);

    await user.type(screen.getByLabelText(/^Precio/), "29,90");

    // A comma is the decimal mark a Spanish-default store's operators type, and
    // 29,90 € is 2990 cents — never 29.9 of anything floating.
    expect(onValue).toHaveBeenLastCalledWith({ raw: "29,90", minor: toMinor(2990) });
  });

  it("round-trips minor units back into the text the field holds", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(
      <MoneyHarness initial={formatMinorAsInput(toMinor(2990), "EUR")} onValue={onValue} />,
    );

    const input = screen.getByLabelText(/^Precio/);
    expect(input).toHaveValue("29.90");

    // And the string it renders parses straight back to the integer it came
    // from — the property that keeps a price from drifting a cent per edit.
    await user.type(input, "0");
    expect(onValue).toHaveBeenLastCalledWith({ raw: "29.900", minor: null });
  });

  it("reports null rather than guessing when the text is not an amount", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<MoneyHarness initial="29.90" onValue={onValue} />);

    const input = screen.getByLabelText(/^Precio/);
    await user.clear(input);

    // An emptied price is NOT zero. `Number("")` is 0, and that is how a
    // fat-fingered field ships a free product.
    expect(onValue).toHaveBeenLastCalledWith({ raw: "", minor: null });

    await user.type(input, "1,234.56");

    // "1,234" is €1.234 to a Spanish operator and €1,234 to an English one.
    // There is no way to tell from the string, and guessing wrong is a 1000x
    // pricing error in either direction — so nothing is guessed.
    expect(onValue).toHaveBeenLastCalledWith({ raw: "1,234.56", minor: null });
  });

  it("renders the translated parser message on blur", async () => {
    const user = userEvent.setup();
    const messages: Readonly<Record<MoneyInputError, string>> = {
      EMPTY: "Introduce un precio.",
      NOT_A_NUMBER: "Introduce un número, por ejemplo 49,99.",
      GROUPING_SEPARATOR: "Quita el separador de miles.",
      NEGATIVE: "Un precio no puede ser negativo.",
      TOO_MANY_DECIMALS: "Demasiados decimales para esta moneda.",
      TOO_LARGE: "Ese precio supera el máximo del sistema.",
    };

    function Harness() {
      const [raw, setRaw] = useState("1,234.56");
      return (
        <MoneyField
          label="Precio"
          name="price"
          currency="EUR"
          value={raw}
          onChange={(next) => {
            setRaw(next.raw);
          }}
          errorMessages={messages}
        />
      );
    }

    render(<Harness />);
    await user.click(screen.getByLabelText("Precio"));
    await user.tab();

    expect(screen.getByRole("alert")).toHaveTextContent("Quita el separador de miles.");
  });

  it("shows the currency beside the amount", () => {
    render(<MoneyHarness initial="29.90" />);

    expect(screen.getByText("EUR")).toBeInTheDocument();
  });
});

describe("<PopupButton />", () => {
  const STATUSES = [
    { value: "DRAFT", label: "Borrador" },
    { value: "ACTIVE", label: "Activo" },
    { value: "ARCHIVED", label: "Archivado" },
  ] as const;

  it("is a real combobox with real options", () => {
    render(
      <PopupButton
        label="Estado"
        name="status"
        value="ACTIVE"
        options={STATUSES}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Estado" })).toHaveValue("ACTIVE");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("hands back the option's own literal type, not the DOM's string", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: "DRAFT" | "ACTIVE" | "ARCHIVED") => void>();
    render(
      <PopupButton
        label="Estado"
        name="status"
        value="ACTIVE"
        options={STATUSES}
        onChange={onChange}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Estado" }), "ARCHIVED");

    expect(onChange).toHaveBeenCalledWith("ARCHIVED");
  });

  it("wires its hint and error through the same contract as every other field", () => {
    render(
      <PopupButton
        label="Estado"
        name="status"
        id="status"
        value="DRAFT"
        options={STATUSES}
        onChange={vi.fn()}
        error="Elige un estado."
      />,
    );

    const select = screen.getByRole("combobox", { name: "Estado" });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAttribute("aria-describedby", "status-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Elige un estado.");
  });
});
