import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  CheckboxField,
  FormActions,
  SelectField,
  SubmitButton,
  TextField,
  indexFieldErrors,
} from "./form-field";

/**
 * These adapters exist to hold a prop surface still while the paint underneath
 * changes, so the tests are about the surface: what each control is called,
 * what it is described by, what it hands back, and — for the error paragraph —
 * what it deliberately does NOT announce.
 */

describe("<TextField />", () => {
  it("pairs its label with the input and submits under its name", () => {
    render(
      <TextField label="Ciudad" name="city" value="Bilbao" onChange={vi.fn()} />,
    );

    const input = screen.getByLabelText("Ciudad");
    expect(input).toHaveValue("Bilbao");
    expect(input).toHaveAttribute("name", "city");
  });

  it("keeps the required asterisk out of the way of the name", () => {
    render(
      <TextField label="Nombre" name="firstName" value="" onChange={vi.fn()} required />,
    );

    // Anchored at the start: the asterisk is a visual shorthand appended to the
    // label, and every consumer test queries these fields by a prefix.
    expect(screen.getByLabelText(/^Nombre/)).toBeRequired();
  });

  it("marks an invalid field and points at the message describing it", () => {
    render(
      <TextField
        label="Ciudad"
        name="city"
        value=""
        onChange={vi.fn()}
        error="Este campo es obligatorio."
      />,
    );

    const input = screen.getByLabelText("Ciudad");
    expect(input).toHaveAttribute("aria-invalid", "true");

    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    if (describedBy === null) {
      throw new Error("an invalid field must name the message that explains it");
    }
    expect(document.getElementById(describedBy)).toHaveTextContent(
      "Este campo es obligatorio.",
    );
  });

  it("does not interrupt with an assertive announcement", () => {
    // These forms validate on SUBMIT and report every failing field at once.
    // Five simultaneous assertive regions is not five times as useful — the
    // message is reached through `aria-describedby` when focus lands on the
    // field it belongs to. A banner is the only thing on these screens that
    // gets to interrupt, and `profile-form.test.tsx` pins that distinction.
    render(
      <TextField
        label="Ciudad"
        name="city"
        value=""
        onChange={vi.fn()}
        error="Este campo es obligatorio."
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("describes the field with the error before the hint", () => {
    render(
      <TextField
        label="Teléfono"
        name="phone"
        value=""
        onChange={vi.fn()}
        hint="Para avisarte de la entrega."
        error="Ese teléfono no es válido."
      />,
    );

    const input = screen.getByLabelText("Teléfono");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(2);

    const [first, second] = ids;
    if (first === undefined || second === undefined) {
      throw new Error("expected both the error and the hint to be named");
    }
    expect(document.getElementById(first)).toHaveTextContent("Ese teléfono no es válido.");
    expect(document.getElementById(second)).toHaveTextContent("Para avisarte de la entrega.");
  });

  it("claims nothing about a field nobody has filled in yet", () => {
    render(<TextField label="Empresa" name="company" value="" onChange={vi.fn()} />);

    // `aria-invalid="false"` would tell a screen reader the field is VALID.
    expect(screen.getByLabelText("Empresa")).not.toHaveAttribute("aria-invalid");
  });

  it("hands the caller the value, not the event", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextField label="Ciudad" name="city" value="" onChange={onChange} />);

    await user.type(screen.getByLabelText("Ciudad"), "B");

    expect(onChange).toHaveBeenCalledWith("B");
  });

  it("passes the attributes the account forms rely on", () => {
    render(
      <TextField
        label="Contraseña actual"
        name="currentPassword"
        type="password"
        value=""
        onChange={vi.fn()}
        autoComplete="current-password"
        maxLength={80}
        disabled
      />,
    );

    const input = screen.getByLabelText("Contraseña actual");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).toHaveAttribute("maxlength", "80");
    expect(input).toBeDisabled();
  });
});

describe("<SelectField />", () => {
  it("is a real select named by its label", () => {
    render(
      <SelectField
        label="Idioma"
        name="preferredLocale"
        value="es"
        onChange={vi.fn()}
        options={[
          { value: "es", label: "Español" },
          { value: "en", label: "Inglés" },
        ]}
      />,
    );

    expect(screen.getByLabelText("Idioma")).toHaveValue("es");
  });

  it("hands back the option's literal type, not a bare string", async () => {
    const user = userEvent.setup();
    // Typed as the union so the assertion below would stop compiling if the
    // callback ever widened to `string` — which is what lets a caller feed the
    // value straight into a `.strict()` request schema.
    const onChange = vi.fn<(value: "SHIPPING" | "BILLING") => void>();
    render(
      <SelectField<"SHIPPING" | "BILLING">
        label="Tipo de dirección"
        name="type"
        value="SHIPPING"
        onChange={onChange}
        options={[
          { value: "SHIPPING", label: "Envío" },
          { value: "BILLING", label: "Facturación" },
        ]}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Tipo de dirección"), "BILLING");

    expect(onChange).toHaveBeenCalledWith("BILLING");
  });
});

describe("<CheckboxField />", () => {
  it("is a real checkbox named by its label", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CheckboxField
        label="Usar como dirección predeterminada"
        name="isDefault"
        checked={false}
        onChange={onChange}
      />,
    );

    const box = screen.getByRole("checkbox", {
      name: "Usar como dirección predeterminada",
    });
    expect(box).not.toBeChecked();

    await user.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("<SubmitButton />", () => {
  it("submits the form it sits in", () => {
    render(<SubmitButton label="Guardar" pendingLabel="Guardando…" isPending={false} />);

    expect(screen.getByRole("button", { name: "Guardar" })).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("swaps its name and locks out a second submission while saving", () => {
    // Re-enabling the button mid-save invites a duplicate write. The kit's
    // buttons stay focusable while pending; these three forms are pinned to the
    // older behaviour until the account screens are rebuilt.
    render(<SubmitButton label="Guardar" pendingLabel="Guardando…" isPending />);

    const button = screen.getByRole("button", { name: "Guardando…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Guardar" })).not.toBeInTheDocument();
  });
});

describe("<FormActions />", () => {
  it("renders the actions it is given", () => {
    render(
      <FormActions>
        <button type="button">Cancelar</button>
      </FormActions>,
    );

    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });
});

describe("indexFieldErrors", () => {
  it("indexes by path", () => {
    expect(
      indexFieldErrors([
        { path: "city", message: "Obligatorio" },
        { path: "postalCode", message: "Demasiado corto" },
      ]),
    ).toEqual({ city: "Obligatorio", postalCode: "Demasiado corto" });
  });

  it("keeps the first message per path", () => {
    // A nested schema often reports the same constraint twice; the first is the
    // one closest to what the customer typed.
    expect(
      indexFieldErrors([
        { path: "city", message: "Obligatorio" },
        { path: "city", message: "Invalid input" },
      ]),
    ).toEqual({ city: "Obligatorio" });
  });

  it("treats a failure with no field detail as no field errors", () => {
    expect(indexFieldErrors(null)).toEqual({});
  });
});
