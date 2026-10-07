import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { MINOR_MAX, isMinor, toMinor } from "@akai/contracts";

import { AggregateMoney, Money } from "./money";

/**
 * The rendered span, not the wrapper testing-library puts around it. Money has
 * no role and no accessible name — it is a figure inside somebody else's row —
 * so this is the one primitive whose tests reach for the element rather than a
 * role query.
 */
function renderFigure(ui: ReactElement): HTMLElement {
  const { container } = render(ui);
  const element = container.firstElementChild;
  if (!(element instanceof HTMLElement)) {
    throw new Error("Money rendered no element");
  }
  return element;
}

/**
 * ICU separates the peso symbol with a NO-BREAK SPACE in Spanish. Collapsing it
 * to a plain space keeps the expectations below readable as the strings a
 * customer actually sees, without pretending the rendered character is ASCII.
 */
function figureText(element: HTMLElement): string {
  // \u00a0 in es-CO, \u202f in some ICU builds. Written as escapes because an
  // invisible literal is exactly the character nobody notices going missing.
  return (element.textContent ?? "").replace(/[\u00a0\u202f]/g, " ");
}

describe("<Money />", () => {
  /**
   * es-CO, the only display locale: "." groups thousands and COP is shown in
   * whole pesos (the stored amount is centavos). A grouped figure read with the
   * wrong separator is out by a factor of a thousand.
   */
  const CASES: readonly (readonly [number, string])[] = [
    [8_980_000, "$ 89.800"],
    [482_149_000, "$ 4.821.490"],
  ];

  for (const [minor, expected] of CASES) {
    it(`renders ${minor} as ${expected}`, () => {
      const element = renderFigure(
        <Money amount={toMinor(minor)} currency="COP" />,
      );
      expect(figureText(element)).toBe(expected);
    });
  }

  it("uses tabular figures in the proportional face, never monospace", () => {
    const element = renderFigure(<Money amount={toMinor(8980)} currency="COP" />);

    expect(element.className).toContain("tabular-nums");
    // Mono is reserved for identifiers — SKUs, order numbers, tracking numbers. An
    // amount rendered in it reads as a code rather than a quantity.
    expect(element.className).not.toMatch(/font-mono|--font-mono/);
  });

  it("is always --label, at both weights", () => {
    for (const emphasis of [false, true]) {
      const element = renderFigure(
        <Money amount={toMinor(8980)} currency="COP" emphasis={emphasis} />,
      );
      expect(element.className).toContain("text-[var(--label)]");
    }
  });

  it("emphasis moves the weight and never the size", () => {
    const plain = renderFigure(<Money amount={toMinor(8980)} currency="COP" />);
    const emphasised = renderFigure(
      <Money amount={toMinor(8980)} currency="COP" emphasis />,
    );

    expect(plain.className).not.toContain("font-semibold");
    expect(emphasised.className).toContain("font-semibold");

    // Size is inherited from the row, so neither variant may declare one. A
    // `text-[17px]` sneaking in here would detach every emphasised amount in
    // the product from the label beside it.
    for (const element of [plain, emphasised]) {
      expect(element.className).not.toMatch(/text-\[\d/);
    }
  });

  it("signs a negative amount with a typographic minus, not a hyphen", () => {
    const element = renderFigure(
      <Money amount={toMinor(-2_990_000)} currency="COP" />,
    );

    expect(figureText(element)).toBe("−$ 29.900");
    expect(figureText(element)).not.toContain("-");
  });

  it("appends a caller class without dropping its own", () => {
    const element = renderFigure(
      <Money amount={toMinor(8980)} currency="COP" className="text-right" />,
    );

    expect(element.className).toContain("tabular-nums");
    expect(element.className).toContain("text-right");
  });
});

describe("<AggregateMoney />", () => {
  /** $ 24.000.000 COP of lifetime revenue: past `MINOR_MAX`, and a good problem. */
  const OVER_CAP = 2_400_000_000;

  it("is the only path that can render an aggregate past MINOR_MAX", () => {
    // Both branded routes are genuinely closed for this value — this is the
    // premise the component exists for, so it is asserted rather than assumed.
    expect(OVER_CAP).toBeGreaterThan(MINOR_MAX);
    expect(() => toMinor(OVER_CAP)).toThrow();
    expect(isMinor(OVER_CAP)).toBe(false);

    const element = renderFigure(
      <AggregateMoney amountMinor={OVER_CAP} currency="COP" />,
    );

    expect(figureText(element)).toBe("$ 24.000.000");
    // The `isMinor` fallback's failure mode, pinned: a bare integer where a
    // peso figure belongs.
    expect(figureText(element)).not.toBe(String(OVER_CAP));
  });

  it("renders the same figure as Money for an in-range value", () => {
    const aggregate = renderFigure(<AggregateMoney amountMinor={8980} currency="COP" />);
    const branded = renderFigure(<Money amount={toMinor(8980)} currency="COP" />);

    expect(figureText(aggregate)).toBe(figureText(branded));
    expect(aggregate.className).toBe(branded.className);
  });

  it("carries the same type treatment as a transactional amount", () => {
    const element = renderFigure(
      <AggregateMoney amountMinor={OVER_CAP} currency="COP" emphasis />,
    );

    expect(element.className).toContain("tabular-nums");
    expect(element.className).toContain("font-semibold");
    expect(element.className).not.toMatch(/font-mono|--font-mono/);
  });
});
