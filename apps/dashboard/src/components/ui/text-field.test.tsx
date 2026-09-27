import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TextField } from "./text-field";

/**
 * This file is an ADAPTER, so its tests are about the seam, not the pixels.
 *
 * Everything asserted here is something one of the five auth screens passes and
 * would lose silently if the adapter dropped it: the caller's own `id` (the
 * hint and error ids are derived from it), the submitted `name` (autofill), the
 * `inputClassName` escape hatch (the TOTP box), and the describedby wiring that
 * is the only way a screen-reader user learns why sign-in was refused. None of
 * it is covered by `auth.spec.ts`, which asserts headings, link names, cookie
 * flags and a CSRF 403.
 */

describe("<TextField /> (auth adapter)", () => {
  it("pairs the label with the input under the caller's own id", async () => {
    const user = userEvent.setup();
    render(
      <TextField
        id="email"
        name="email"
        label="Correo electrónico"
        value=""
        onChange={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Correo electrónico");
    // The id is the caller's, not a generated one: the auth screens hand it in
    // and the hint and error ids are spelled off it.
    expect(input).toHaveAttribute("id", "email");

    await user.click(screen.getByText("Correo electrónico"));
    expect(input).toHaveFocus();
  });

  it("submits under the name it was given", () => {
    // Not decoration: `name` is what a password manager keys off to offer the
    // saved credential, on all five auth screens at once. Losing it fails no
    // test and breaks autofill everywhere.
    render(
      <TextField id="password" name="password" label="Contraseña" value="" onChange={vi.fn()} />,
    );

    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("name", "password");
  });

  it("describes the field with the hint and the error, in that order", () => {
    render(
      <TextField
        id="password"
        name="password"
        label="Contraseña"
        value=""
        onChange={vi.fn()}
        hint="Mínimo 12 caracteres."
        error="Esa contraseña es demasiado corta."
      />,
    );

    const input = screen.getByLabelText("Contraseña");
    // The exact spelling `-hint` / `-error` is load-bearing: it is what the
    // implementation this file replaced shipped, and nothing that references an
    // id string had to move.
    expect(input).toHaveAttribute("aria-describedby", "password-hint password-error");
    expect(document.getElementById("password-hint")).toHaveTextContent("Mínimo 12 caracteres.");
    expect(document.getElementById("password-error")).toHaveTextContent(
      "Esa contraseña es demasiado corta.",
    );
  });

  it("names only the ids it actually rendered", () => {
    render(
      <TextField id="email" name="email" label="Correo" value="" onChange={vi.fn()} hint="Lo usamos para entrar." />,
    );

    // A dangling aria-describedby is ignored by some screen readers and read as
    // an empty string by others, so the error id must not be named until there
    // is an error.
    expect(screen.getByLabelText("Correo")).toHaveAttribute("aria-describedby", "email-hint");
  });

  it("admits to being invalid only when it is", () => {
    const { rerender } = render(
      <TextField id="totpCode" name="totpCode" label="Código" value="" onChange={vi.fn()} />,
    );

    // Absent, never "false": `aria-invalid="false"` asserts the field is VALID,
    // which is not a claim we can make about one nobody has filled in yet.
    expect(screen.getByLabelText("Código")).not.toHaveAttribute("aria-invalid");

    rerender(
      <TextField
        id="totpCode"
        name="totpCode"
        label="Código"
        value=""
        onChange={vi.fn()}
        error="Código incorrecto."
      />,
    );
    expect(screen.getByLabelText("Código")).toHaveAttribute("aria-invalid", "true");
  });

  it("puts inputClassName on the input rather than on the wrapper", () => {
    // Sign-in's second factor passes `input--code`, which is 20px monospaced,
    // centred and widely tracked. On the wrapper that tracking would reach the
    // label too.
    render(
      <TextField
        id="totpCode"
        name="totpCode"
        label="Código"
        value=""
        onChange={vi.fn()}
        inputClassName="input--code"
      />,
    );

    expect(screen.getByLabelText("Código")).toHaveClass("input--code");
  });

  it("hands the caller the value, not the event", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextField id="email" name="email" label="Correo" value="" onChange={onChange} />);

    await user.type(screen.getByLabelText("Correo"), "a");

    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("passes the input attributes the auth screens rely on", () => {
    render(
      <TextField
        id="totpCode"
        name="totpCode"
        label="Código"
        value=""
        onChange={vi.fn()}
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
      />,
    );

    const input = screen.getByLabelText("Código");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("maxlength", "6");
  });

  it("keeps a password field a password field", () => {
    render(
      <TextField
        id="password"
        name="password"
        type="password"
        label="Contraseña"
        value="hunter2hunter2"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "password");
  });

  it("falls back to a text box for a type the kit does not paint", () => {
    // The prop type stays as wide as `HTMLInputTypeAttribute` so the five call
    // sites compile untouched; a `checkbox` is a different control with a
    // different affordance, and rendering one inside a text box would be worse
    // than the honest fallback. No caller does this today.
    render(
      <TextField id="odd" name="odd" type="color" label="Raro" value="" onChange={vi.fn()} />,
    );

    expect(screen.getByLabelText("Raro")).toHaveAttribute("type", "text");
  });

  it("disables the control while a submission is in flight", () => {
    render(
      <TextField id="email" name="email" label="Correo" value="" onChange={vi.fn()} disabled />,
    );

    expect(screen.getByLabelText("Correo")).toBeDisabled();
  });

  it("focuses the first field of a single-purpose form when asked", () => {
    render(
      <TextField id="email" name="email" label="Correo" value="" onChange={vi.fn()} autoFocus />,
    );

    expect(screen.getByLabelText("Correo")).toHaveFocus();
  });
});
