import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { Link } from "@/i18n/navigation";
import { Button, IconButton, buttonClassName, type ButtonVariant } from "./button";

const VARIANTS: readonly ButtonVariant[] = [
  "prominent",
  "standard",
  "plain",
  "destructive",
  "destructivePlain",
];

describe("<Button />", () => {
  it("is a button, and is type=button unless asked otherwise", () => {
    render(<Button>Guardar Cambios</Button>);

    const button = screen.getByRole("button", { name: "Guardar Cambios" });
    // The HTML default is "submit". A button that opens a dialog and silently
    // submits the form it happens to sit in is the bug this default prevents.
    expect(button).toHaveAttribute("type", "button");
  });

  it("passes a submit type through", () => {
    render(<Button type="submit">Continuar</Button>);

    expect(screen.getByRole("button", { name: "Continuar" })).toHaveAttribute("type", "submit");
  });

  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Aplicar</Button>);

    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("blocks onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Aplicar
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Aplicar" });
    expect(button).toBeDisabled();

    await userEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("attaches no handler at all when the caller passed none", () => {
    // A Button rendered by a SERVER component must not put a function on a host
    // element — React rejects that at render — so the handler is attached only
    // when there is one to attach. `onclick` is the DOM-level shape of that.
    render(<Button>Sólo texto</Button>);

    expect(screen.getByRole("button", { name: "Sólo texto" }).onclick).toBeNull();
  });
});

describe("<Button /> pending", () => {
  it("announces itself busy and swaps its accessible name", () => {
    render(
      <Button pending pendingLabel="Guardando…">
        Guardar Cambios
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Guardando…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Guardar Cambios" })).not.toBeInTheDocument();
  });

  it("keeps the resting label in the DOM, hidden, so the row does not reflow", () => {
    render(
      <Button pending pendingLabel="Guardando…">
        Guardar Cambios
      </Button>,
    );

    // Present for its WIDTH only: it holds the button's intrinsic size while the
    // shorter pending label is showing. It must never reach the accessibility
    // tree, or the button announces both labels.
    const ghost = screen.getByText("Guardar Cambios");
    expect(ghost).toBeInTheDocument();
    expect(ghost.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("stays focusable rather than disabling", () => {
    // Disabling the element the user just pressed drops focus to <body> and a
    // screen-reader user loses their place mid-form. aria-busy carries the state.
    render(
      <Button pending pendingLabel="Guardando…">
        Guardar Cambios
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Guardando…" })).not.toBeDisabled();
  });

  it("swallows a second press while pending", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} pending pendingLabel="Guardando…">
        Guardar Cambios
      </Button>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Guardando…" }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not submit its form a second time while pending", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" pending pendingLabel="Guardando…">
          Guardar Cambios
        </Button>
      </form>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Guardando…" }));

    // Returning early from the handler would not have been enough — only
    // preventDefault() on the click stops a submit button submitting.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("falls back to the resting label when no pendingLabel is given", () => {
    render(<Button pending>Guardar Cambios</Button>);

    const button = screen.getByRole("button", { name: "Guardar Cambios" });
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});

describe("<Button /> icon", () => {
  it("renders a leading glyph without letting it name the button", () => {
    const { container } = render(<Button icon="plus">Nuevo Producto</Button>);

    expect(screen.getByRole("button", { name: "Nuevo Producto" })).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("<IconButton />", () => {
  it("takes its accessible name from `label`", () => {
    render(<IconButton icon="copy" label="Copiar número de pedido" />);

    expect(screen.getByRole("button", { name: "Copiar número de pedido" })).toBeInTheDocument();
  });

  it("shows the same words as a tooltip that is hidden from assistive tech", () => {
    render(<IconButton icon="x" label="Cerrar" />);

    const tooltip = screen.getByText("Cerrar");
    expect(tooltip).toHaveAttribute("role", "tooltip");
    // The button's aria-label already says it. Exposing the tooltip too would
    // make every row of a fifty-row table announce twice.
    expect(tooltip).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("button", { name: "Cerrar" })).toHaveLength(1);
  });

  it("blocks onClick when disabled", async () => {
    const onClick = vi.fn();
    render(<IconButton icon="trash-2" label="Eliminar" onClick={onClick} disabled />);

    await userEvent.click(screen.getByRole("button", { name: "Eliminar" }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("announces itself busy while pending", () => {
    render(<IconButton icon="mail" label="Reenviar" pending />);

    expect(screen.getByRole("button", { name: "Reenviar" })).toHaveAttribute("aria-busy", "true");
  });
});

describe("buttonClassName()", () => {
  it("styles a locale-aware Link as a button while it stays a link", () => {
    render(
      <NextIntlClientProvider locale="es" messages={{}}>
        <Link
          className={buttonClassName({ variant: "prominent", size: "mobile", block: true })}
          href="/sign-in"
        >
          Iniciar Sesión
        </Link>
      </NextIntlClientProvider>,
    );

    // Right-click, middle-click and the screen reader's link rotor all hang off
    // the element, not the paint — so this must never become a <button>.
    const link = screen.getByRole("link", { name: "Iniciar Sesión" });
    expect(link).toHaveAttribute("href", "/sign-in");
    expect(link.className).toContain("bg-[var(--accent)]");
    expect(link.className).toContain("w-full");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("emits focus-visible:outline-none for every variant before its own ring", () => {
    // KEEP THIS. globals.css declares :focus-visible inside @layer base so that
    // a utility can win — but only a utility that is actually emitted. This is
    // the primitive's half of that contract; globals-layering.test.ts proves the
    // cascade half. Without it, a variant that forgets outline-none ships green
    // and paints two rings on top of each other.
    for (const variant of VARIANTS) {
      const classes = buttonClassName({ variant });
      expect(classes, variant).toContain("focus-visible:outline-none");
      expect(classes, variant).toContain("var(--focus-ring)");
    }
  });

  it("keeps the accent focus ring on both destructive roles", () => {
    // A red ring on a red button is invisible, and a ring that changes colour
    // per control makes a keyboard user re-learn "where am I?" on every screen.
    for (const variant of ["destructive", "destructivePlain"] as const) {
      expect(buttonClassName({ variant }), variant).not.toContain("--danger-ring");
    }
  });

  it("also emits outline-none on a rendered Button and IconButton", () => {
    render(
      <>
        <Button>Aplicar</Button>
        <IconButton icon="ellipsis" label="Más" />
      </>,
    );

    for (const name of ["Aplicar", "Más"]) {
      expect(screen.getByRole("button", { name }).className).toContain(
        "focus-visible:outline-none",
      );
    }
  });

  it("scales height with the size and never writes a fixed width", () => {
    expect(buttonClassName({ size: "compact" })).toContain("h-7");
    expect(buttonClassName({ size: "comfortable" })).toContain("h-9");
    expect(buttonClassName({ size: "mobile" })).toContain("h-11");

    for (const size of ["compact", "comfortable", "mobile"] as const) {
      // `w-full` is fluid and allowed; a literal width is what clips a
      // translated label in exactly one locale.
      expect(buttonClassName({ size }), size).not.toMatch(/\bw-\[/);
    }
  });

  it("takes the corner radius from the shape tokens, not from a literal", () => {
    expect(buttonClassName({ size: "compact" })).toContain("rounded-[var(--r-control)]");
    // A sheet-footer button is drawn at 10 whatever density surrounds it.
    expect(buttonClassName({ size: "mobile" })).toContain("rounded-[var(--r-card)]");
  });

  it("replaces the enabled paint when disabled rather than layering on top of it", () => {
    // Two fills at equal specificity would be resolved by stylesheet order,
    // which is not something a component may bet on.
    const disabled = buttonClassName({ variant: "prominent", disabled: true });

    expect(disabled).toContain("var(--fill-tertiary)");
    expect(disabled).not.toContain("hover:bg-[var(--accent-hover)]");
    expect(disabled).not.toContain("active:bg-[var(--accent-pressed)]");
  });

  it("pulls the padding in for plain, which has no fill to pad", () => {
    expect(buttonClassName({ variant: "plain", size: "compact" })).toContain("px-2");
    expect(buttonClassName({ variant: "standard", size: "compact" })).toContain("px-3");
  });

  it("goes asymmetric when the caller renders a leading glyph", () => {
    const classes = buttonClassName({ size: "compact", leadingIcon: true });

    expect(classes).toContain("pl-2");
    expect(classes).toContain("pr-2.5");
  });

  it("appends the caller's own classes last", () => {
    expect(buttonClassName({ className: "ml-auto" }).endsWith("ml-auto")).toBe(true);
  });
});
