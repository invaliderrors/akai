import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorCodeSchema, type ErrorCode } from "@akai/contracts";

import { Icon, type IconName } from "./icon";
import { EmptyState, ErrorState, Skeleton } from "./states";
import esMessages from "../../../messages/es.json";

function renderIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

/**
 * The glyph itself, not merely "an svg is present".
 *
 * These components differ by which symbol they draw, so a presence check would
 * pass on any icon at all — including the wrong one, which is the entire defect
 * the "nothing yet" / "nothing matches" split exists to prevent.
 */
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

describe("EmptyState", () => {
  it("draws a different glyph for 'nothing yet' than for 'nothing matches'", () => {
    const { container: nothingYet, unmount } = renderIntl(
      <EmptyState title="Aún no tienes pedidos" body="Tu primer pedido aparecerá aquí." />,
    );
    const yetGlyph = glyphPath(nothingYet);
    unmount();

    const { container: noMatches } = renderIntl(
      <EmptyState
        reason="no-matches"
        title="Ningún pedido coincide"
        body="Prueba a quitar el filtro."
      />,
    );

    expect(yetGlyph).not.toBe(glyphPath(noMatches));
    expect(yetGlyph).toBe(referenceGlyph("inbox"));
    expect(glyphPath(noMatches)).toBe(referenceGlyph("search-x"));
  });

  it("lets a domain surface override the reason's glyph", () => {
    const { container } = renderIntl(
      <EmptyState icon="package" title="Aún no tienes pedidos" body="Nada por aquí." />,
    );

    expect(glyphPath(container)).toBe(referenceGlyph("package"));
  });

  it("renders title, body and the action slot", () => {
    renderIntl(
      <EmptyState
        title="Aún no tienes pedidos"
        body="Tu primer pedido aparecerá aquí."
        action={<button type="button">Ir a la tienda</button>}
      />,
    );

    expect(screen.getByText("Aún no tienes pedidos")).toBeInTheDocument();
    expect(screen.getByText("Tu primer pedido aparecerá aquí.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ir a la tienda" })).toBeInTheDocument();
  });

  it("does not put a heading in the document outline", () => {
    renderIntl(<EmptyState title="Aún no tienes pedidos" body="Nada por aquí." />);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("is a single alert carrying the title and the translated cause", () => {
    renderIntl(
      <ErrorState
        title="No hemos podido cargar tus pedidos"
        code="INTERNAL_ERROR"
        requestId="req_8f21c04ab7"
      />,
    );

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("No hemos podido cargar tus pedidos");
    expect(alerts[0]).toHaveTextContent(esMessages.errors.INTERNAL_ERROR);
  });

  it("surfaces the request id as a button named by the reference sentence", () => {
    renderIntl(
      <ErrorState title="No se pudo cargar" code="INTERNAL_ERROR" requestId="req_8f21c04ab7" />,
    );

    expect(
      screen.getByRole("button", { name: "Referencia: req_8f21c04ab7" }),
    ).toHaveTextContent("req_8f21c04ab7");
  });

  it("shows no reference control when the failure never reached the API", () => {
    renderIntl(
      <ErrorState
        title="No se pudo cargar"
        code="INTERNAL_ERROR"
        requestId={null}
        action={<button type="button">Reintentar</button>}
      />,
    );

    expect(screen.queryByRole("button", { name: /Referencia/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("hides a technical string from a customer and shows it to an operator", () => {
    const detail = "502 upstream timeout · orders-projection";

    const { unmount } = renderIntl(
      <ErrorState
        title="No se pudo cargar"
        code="INTERNAL_ERROR"
        requestId="req_1"
        detail={detail}
      />,
    );
    expect(screen.queryByText(detail)).not.toBeInTheDocument();
    expect(screen.getByText(esMessages.errors.INTERNAL_ERROR)).toBeInTheDocument();
    unmount();

    renderIntl(
      <ErrorState
        audience="admin"
        title="No se pudieron cargar los pedidos"
        code="INTERNAL_ERROR"
        requestId="req_1"
        detail={detail}
      />,
    );
    expect(screen.getByText(detail)).toBeInTheDocument();
    // The operator gets the upstream string INSTEAD OF the translated cause,
    // not stacked on top of it.
    expect(screen.queryByText(esMessages.errors.INTERNAL_ERROR)).not.toBeInTheDocument();
  });

  it("falls back to the translated cause for an operator when there is no upstream string", () => {
    renderIntl(
      <ErrorState
        audience="admin"
        title="No se pudieron cargar los pedidos"
        code="RATE_LIMITED"
        requestId="req_1"
      />,
    );

    expect(screen.getByText(esMessages.errors.RATE_LIMITED)).toBeInTheDocument();
  });

  it("has a catalogue leaf for every ErrorCode", () => {
    // `ErrorState` resolves the cause with `t.has(code) ? t(code) : t("generic")`.
    // That fallback is a safety net for the window between a contract change and
    // a catalogue change; this is what keeps the window loud instead of letting
    // every failure quietly degrade to "Algo ha ido mal".
    const spanish: Readonly<Record<string, string>> = esMessages.errors;

    for (const code of errorCodeSchema.options) {
      expect(Object.keys(spanish)).toContain(code);
    }
  });

});

describe("ErrorState request id copy control", () => {
  // `fireEvent`, not `userEvent`: `userEvent.setup()` installs a clipboard stub
  // of its own over `navigator.clipboard`, which would quietly swallow both the
  // spy below AND the missing-clipboard case this component guards against.
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the id and swaps its glyph to a tick", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    renderIntl(
      <ErrorState title="No se pudo cargar" code="INTERNAL_ERROR" requestId="req_8f21c04ab7" />,
    );
    const button = screen.getByRole("button", { name: "Referencia: req_8f21c04ab7" });
    expect(glyphPath(button)).toBe(referenceGlyph("copy"));

    fireEvent.click(button);

    expect(writeText).toHaveBeenCalledWith("req_8f21c04ab7");
    await waitFor(() => {
      expect(glyphPath(button)).toBe(referenceGlyph("check"));
    });
  });

  it("does not throw where the platform has no clipboard at all", () => {
    expect(navigator.clipboard).toBeUndefined();
    renderIntl(<ErrorState title="No se pudo cargar" code="INTERNAL_ERROR" requestId="req_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Referencia: req_1" }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("Skeleton", () => {
  it("announces itself exactly once, however many bars it draws", () => {
    renderIntl(<Skeleton rows={6} />);

    const announcements = screen.getAllByRole("status");
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(esMessages.common.loading);
  });

  it("takes a more specific label when the caller has one", () => {
    renderIntl(<Skeleton label="Cargando pedidos…" />);

    expect(screen.getByRole("status")).toHaveTextContent("Cargando pedidos…");
  });

  it("marks the container busy and hides every bar from assistive technology", () => {
    const { container } = renderIntl(<Skeleton rows={4} />);

    const region = container.firstElementChild;
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll("span[aria-hidden='true']")).toHaveLength(4);
  });

  it("animates the first bar and only the first", () => {
    const { container } = renderIntl(<Skeleton rows={4} />);

    const bars = Array.from(container.querySelectorAll("span[aria-hidden='true']"));
    const animated = bars.filter((bar) => bar.className.includes("animate-pulse"));
    expect(animated).toHaveLength(1);
    expect(animated[0]).toBe(bars[0]);
  });

  it("never renders an announcement with nothing under it", () => {
    const { container } = renderIntl(<Skeleton rows={0} />);

    expect(container.querySelectorAll("span[aria-hidden='true']")).toHaveLength(1);
  });

  it("sizes list rows off the density token so the page does not jump", () => {
    const { container } = renderIntl(<Skeleton variant="rows" rows={2} />);

    const bars = Array.from(container.querySelectorAll("span[aria-hidden='true']"));
    for (const bar of bars) {
      expect(bar.className).toContain("h-[var(--row-h)]");
      expect(bar.className).toContain("w-full");
    }
  });
});

/** Named so the `ErrorCode` import is load-bearing rather than decorative. */
const SAMPLE_CODE: ErrorCode = "OUT_OF_STOCK";

describe("ErrorState codes", () => {
  it("renders any member of the closed enum", () => {
    renderIntl(<ErrorState title="No se pudo" code={SAMPLE_CODE} requestId={null} />);

    expect(screen.getByRole("alert")).toHaveTextContent(esMessages.errors.OUT_OF_STOCK);
  });
});
