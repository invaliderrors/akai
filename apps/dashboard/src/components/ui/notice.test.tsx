import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { Icon, type IconName } from "./icon";
import { Notice, type NoticeTone } from "./notice";
import esMessages from "../../../messages/es.json";

function renderIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

function glyphPath(root: HTMLElement): string {
  // EVERY path, joined — not the first. lucide draws `circle-check` and
  // `circle-alert` with the same leading circle arc, so a first-path comparison
  // would report the two loudest tones in the kit as the same symbol.
  const paths = Array.from(root.querySelectorAll("svg path"));
  if (paths.length === 0) throw new Error("no glyph rendered");
  return paths.map((path) => path.getAttribute("d") ?? "").join("|");
}

function referenceGlyph(name: IconName): string {
  const { container, unmount } = render(<Icon name={name} />);
  const d = glyphPath(container);
  unmount();
  return d;
}

const POLITE_TONES: readonly NoticeTone[] = ["success", "warning", "progress"];

describe("Notice roles", () => {
  it("interrupts for a failure and only for a failure", () => {
    renderIntl(<Notice tone="danger">No hemos podido iniciar sesión.</Notice>);

    expect(screen.getByRole("alert")).toHaveTextContent("No hemos podido iniciar sesión.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(POLITE_TONES)("announces a %s notice politely, never assertively", (tone) => {
    renderIntl(<Notice tone={tone}>Cambios guardados.</Notice>);

    expect(screen.getByRole("status")).toHaveTextContent("Cambios guardados.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Notice paint", () => {
  const ALL_TONES: readonly NoticeTone[] = ["success", "warning", "danger", "progress"];

  it.each(ALL_TONES)("keeps %s body text in the label colour", (tone) => {
    const { container } = renderIntl(<Notice tone={tone}>Un mensaje.</Notice>);
    const box = container.firstElementChild;

    expect(box?.className).toContain("text-[var(--label)]");
    // The tone must live in the fill and the symbol. A `--*-text` ramp on the
    // body is the red-on-pink failure this component was written to end.
    expect(box?.className).not.toContain("-text)]");
  });

  it.each(ALL_TONES)("fills a %s notice with its own tone", (tone) => {
    const { container } = renderIntl(<Notice tone={tone}>Un mensaje.</Notice>);

    expect(container.firstElementChild?.className).toContain(`bg-[var(--${tone}-fill)]`);
  });

  it("draws a different symbol per tone, so the state survives greyscale", () => {
    const drawn = new Set<string>();
    for (const tone of ALL_TONES) {
      const { container, unmount } = renderIntl(<Notice tone={tone}>Un mensaje.</Notice>);
      drawn.add(glyphPath(container));
      unmount();
    }

    expect(drawn.size).toBe(ALL_TONES.length);
  });

  it("lets a caller swap the symbol without changing the role", () => {
    const { container } = renderIntl(
      <Notice tone="warning" icon="mail-warning">
        Tu correo no está verificado.
      </Notice>,
    );

    expect(glyphPath(container)).toBe(referenceGlyph("mail-warning"));
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shrinks the symbol inside a form but keeps the type", () => {
    const { container: page, unmount } = renderIntl(<Notice tone="danger">Corrige 2 campos.</Notice>);
    expect(page.querySelector("svg")).toHaveAttribute("width", "18");
    unmount();

    const { container: inline } = renderIntl(
      <Notice tone="danger" placement="inline">
        Corrige 2 campos.
      </Notice>,
    );
    expect(inline.querySelector("svg")).toHaveAttribute("width", "16");
  });
});

describe("Notice content", () => {
  it("renders a bold lead sentence ahead of the body", () => {
    renderIntl(
      <Notice tone="success" title="Cambios guardados.">
        La dirección se usará en tu próximo pedido.
      </Notice>,
    );

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(
      "Cambios guardados. La dirección se usará en tu próximo pedido.",
    );
  });

  it("renders the action slot inside the sentence", () => {
    renderIntl(
      <Notice
        tone="warning"
        title="Tu correo no está verificado."
        action={<button type="button">Reenviar el enlace</button>}
      >
        Las facturas se envían a esta dirección.
      </Notice>,
    );

    expect(screen.getByRole("button", { name: "Reenviar el enlace" })).toBeInTheDocument();
  });

  it("quotes a request id through the shared reference sentence", () => {
    renderIntl(
      <Notice tone="danger" requestId="req_8f21c04ab7">
        No hemos podido iniciar sesión.
      </Notice>,
    );

    expect(screen.getByText("Referencia: req_8f21c04ab7")).toBeInTheDocument();
  });

  it("omits the reference block when there is no id to quote", () => {
    renderIntl(
      <Notice tone="danger" requestId="">
        No hemos podido iniciar sesión.
      </Notice>,
    );

    expect(screen.queryByText(/Referencia/)).not.toBeInTheDocument();
  });
});

describe("Notice dismissal", () => {
  it("gives the close control an accessible name and fires it", () => {
    const onDismiss = vi.fn();
    renderIntl(
      <Notice tone="success" dismiss={{ label: "Cerrar", onDismiss }}>
        Cambios guardados.
      </Notice>,
    );

    const close = screen.getByRole("button", { name: "Cerrar" });
    fireEvent.click(close);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("draws no close control when the notice is not dismissible", () => {
    renderIntl(<Notice tone="success">Cambios guardados.</Notice>);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
