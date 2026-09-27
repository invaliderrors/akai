import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { BadgeTone } from "@/lib/status";

import { Badge, Counter, LotChip, type BadgeDensity } from "./badge";
import { Icon } from "./icon";

/**
 * Totality, checked twice.
 *
 * The `Record` makes a new tone a COMPILE error here, and the length assertion
 * below makes it a test failure if the array beneath it is not updated too — so
 * a seventh tone cannot slip through with five of its six behaviours untested.
 */
const TONE_LABEL: Readonly<Record<BadgeTone, string>> = {
  neutral: "Pendiente",
  progress: "Preparando",
  success: "Pagado",
  warning: "Esperando pago",
  danger: "Fallido",
  attention: "Importe no coincide",
};

const TONES: readonly BadgeTone[] = ["neutral", "progress", "success", "warning", "danger", "attention"];

const DENSITIES: readonly BadgeDensity[] = ["compact", "comfortable"];

/** The dot is the one element with no text, so it is found by its shape class. */
function dots(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("span.rounded-full");
}

function pathData(container: HTMLElement): readonly string[] {
  return Array.from(container.querySelectorAll("path"), (path) => path.getAttribute("d") ?? "");
}

describe("<Badge />", () => {
  it("covers every tone", () => {
    expect(TONES).toHaveLength(Object.keys(TONE_LABEL).length);
  });

  it.each(TONES)("renders the %s label as text, never as colour alone", (tone: BadgeTone) => {
    // WCAG 1.4.1. A badge whose meaning lived in its fill would be a blank
    // capsule in greyscale, to a colour-blind operator, and on a printed
    // picking list — so every tone is checked, not just a representative one.
    render(<Badge tone={tone} label={TONE_LABEL[tone]} />);

    expect(screen.getByText(TONE_LABEL[tone])).toBeInTheDocument();
  });

  it.each(TONES.filter((tone) => tone !== "attention"))("gives %s a dot and no symbol", (tone: BadgeTone) => {
    const { container } = render(<Badge tone={tone} label={TONE_LABEL[tone]} />);

    expect(dots(container)).toHaveLength(1);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("replaces the dot with a triangle-alert on attention", () => {
    const { container } = render(<Badge tone="attention" label={TONE_LABEL.attention} />);

    expect(dots(container)).toHaveLength(0);

    // Compared against the real glyph rather than merely asserting "an svg is
    // present": the symbol is the redundant, non-colour signal that the loudest
    // state in the product depends on, and any other icon would pass a
    // presence-only check.
    const { container: expected } = render(<Icon name="triangle-alert" size={12} />);
    expect(pathData(container)).toEqual(pathData(expected));
  });

  it.each(DENSITIES)("renders at %s density", (density: BadgeDensity) => {
    render(<Badge tone="success" label="Pagado" density={density} />);

    const badge = screen.getByText("Pagado");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain(density === "compact" ? "h-[18px]" : "h-[24px]");
  });

  it("sizes the attention symbol with the density", () => {
    const { container: compact } = render(<Badge tone="attention" label="Importe no coincide" density="compact" />);
    const { container: comfortable } = render(
      <Badge tone="attention" label="Importe no coincide" density="comfortable" />,
    );

    expect(compact.querySelector("svg")).toHaveAttribute("width", "11");
    expect(comfortable.querySelector("svg")).toHaveAttribute("width", "12");
  });

  it("swaps the tone fill for the translucent white treatment on an accent row", () => {
    render(<Badge tone="success" label="Pagado" onAccent />);

    const badge = screen.getByText("Pagado");
    // Every `*-fill` tint is a pale wash for a white surface and disappears on
    // --accent, so the tone's own colours must be gone, not merely overlaid.
    expect(badge.className).not.toContain("var(--success-fill)");
    expect(badge.className).toContain("bg-white/20");
    expect(badge.className).toContain("var(--label-on-accent)");
  });

  it("keeps the attention symbol on an accent row, where the red is gone", () => {
    const { container } = render(<Badge tone="attention" label="Importe no coincide" onAccent />);

    expect(screen.getByText("Importe no coincide").className).not.toContain("var(--attention-fill)");
    // The colour is what the selected row takes away; the label and the symbol
    // are what carry the state across regardless.
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("<Counter />", () => {
  it("announces a sentence instead of a bare number", () => {
    render(<Counter count={2} label="2 pedidos necesitan una decisión" />);

    expect(screen.getByText("2 pedidos necesitan una decisión")).toBeInTheDocument();
    // The digits are visible but hidden from assistive technology: "2" read
    // aloud beside "Pedidos" says nothing about what the 2 is.
    expect(screen.getByText("2")).toHaveAttribute("aria-hidden", "true");
  });

  it("folds its sentence into the accessible name of the link it sits in", () => {
    // This is the whole reason the sentence is sr-only text and not an
    // aria-label on a generic span: in the side nav the counter lives inside
    // the destination link, and its text has to join that link's name.
    render(
      // `href="#"` only because this is a fixture: the real call site is a
      // locale-aware `Link` from `@/i18n/navigation`.
      <a href="#">
        Pedidos
        <Counter count={2} label="2 pedidos necesitan una decisión" tone="danger" />
      </a>,
    );

    expect(screen.getByRole("link", { name: /Pedidos.*2 pedidos necesitan una decisión/ })).toBeInTheDocument();
  });

  it("is neutral by default and reaches for red only as a problem", () => {
    const { container: quiet } = render(<Counter count={184} label="184 productos" />);
    const { container: loud } = render(<Counter count={2} label="2 trabajos han fallado" tone="danger" />);

    expect(quiet.firstElementChild?.className).toContain("var(--fill-tertiary)");
    // --danger-text, the deep red, and deliberately NOT --attention-fill: the
    // attention token has a two-use budget and a sidebar count is not one.
    expect(loud.firstElementChild?.className).toContain("var(--danger-text)");
    expect(loud.firstElementChild?.className).not.toContain("var(--attention-fill)");
  });

  it.each(DENSITIES)("renders at %s density", (density: BadgeDensity) => {
    const { container } = render(<Counter count={12} label="12 pedidos abiertos" density={density} />);

    expect(container.firstElementChild?.className).toContain(density === "compact" ? "h-[18px]" : "h-[24px]");
  });
});

describe("<LotChip />", () => {
  it("renders the code on its own", () => {
    render(<LotChip code="B-4471" />);

    expect(screen.getByText("B-4471")).toBeInTheDocument();
  });

  it("reads as one string when it carries a translated prefix", () => {
    render(<LotChip code="B-4471" prefix="lote" />);

    // A missing separator would announce "loteB-4471", which is the failure a
    // flex container would have introduced invisibly.
    expect(screen.getByText("lote B-4471")).toBeInTheDocument();
  });

  it("fills solid accent when it is the lot a search answered", () => {
    const { container: reference } = render(<LotChip code="B-4402" />);
    const { container: match } = render(<LotChip code="B-4471" variant="match" />);

    expect(reference.firstElementChild?.className).toContain("var(--accent-tint)");
    expect(match.firstElementChild?.className).toContain("var(--accent)");
    expect(match.firstElementChild?.className).toContain("var(--label-on-accent)");
  });

  it("sets a lot code in the mono face, because it is an identifier", () => {
    // Compared character by character against a physical tub; a proportional
    // face makes B/8 and 0/O a coin toss. Money never gets this treatment.
    const { container } = render(<LotChip code="B-4471" />);

    expect(container.firstElementChild?.className).toContain("font-mono");
  });
});
