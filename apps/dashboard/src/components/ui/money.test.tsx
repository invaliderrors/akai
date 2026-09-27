import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { MINOR_MAX, isMinor, toMinor, type Locale } from "@akai/contracts";

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
 * ICU separates the euro symbol with a NO-BREAK SPACE in Spanish. Collapsing it
 * to a plain space keeps the expectations below readable as the strings a
 * customer actually sees, without pretending the rendered character is ASCII.
 */
function figureText(element: HTMLElement): string {
  // \u00a0 in es-ES, \u202f in some ICU builds. Written as escapes because an
  // invisible literal is exactly the character nobody notices going missing.
  return (element.textContent ?? "").replace(/[\u00a0\u202f]/g, " ");
}

describe("<Money />", () => {
  /**
   * The four forms drawn in 01 Tokens §"Locale formatting · integer minor units
   * in". Two locales x two magnitudes is the minimum that pins BOTH differences
   * that matter — symbol placement, and the fact that es swaps the roles of "."
   * and "," so a grouped figure read with the wrong locale is out by a factor
   * of a thousand.
   */
  const CASES: readonly (readonly [Locale, number, string])[] = [
    ["es", 8980, "89,80 €"],
    ["en", 8980, "€89.80"],
    ["es", 4821490, "48.214,90 €"],
    ["en", 4821490, "€48,214.90"],
  ];

  for (const [locale, minor, expected] of CASES) {
    it(`renders ${minor} in ${locale} as ${expected}`, () => {
      const element = renderFigure(
        <Money amount={toMinor(minor)} currency="EUR" locale={locale} />,
      );
      expect(figureText(element)).toBe(expected);
    });
  }

  it("uses tabular figures in the proportional face, never monospace", () => {
    const element = renderFigure(<Money amount={toMinor(8980)} currency="EUR" locale="es" />);

    expect(element.className).toContain("tabular-nums");
    // Mono is reserved for identifiers — SKUs, order numbers, tracking numbers. An
    // amount rendered in it reads as a code rather than a quantity.
    expect(element.className).not.toMatch(/font-mono|--font-mono/);
  });

  it("is always --label, at both weights", () => {
    for (const emphasis of [false, true]) {
      const element = renderFigure(
        <Money amount={toMinor(8980)} currency="EUR" locale="es" emphasis={emphasis} />,
      );
      expect(element.className).toContain("text-[var(--label)]");
    }
  });

  it("emphasis moves the weight and never the size", () => {
    const plain = renderFigure(<Money amount={toMinor(8980)} currency="EUR" locale="es" />);
    const emphasised = renderFigure(
      <Money amount={toMinor(8980)} currency="EUR" locale="es" emphasis />,
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
      <Money amount={toMinor(-2990)} currency="EUR" locale="es" />,
    );

    expect(figureText(element)).toBe("−29,90 €");
    expect(figureText(element)).not.toContain("-");
  });

  it("lets the locale place the sign rather than prefixing it", () => {
    // en-IE puts the minus OUTSIDE the symbol. A hand-rolled `"-" + formatted`
    // happens to agree here and would not in a locale that brackets negatives —
    // which is the reason the amount, not the string, carries the sign.
    const element = renderFigure(
      <Money amount={toMinor(-2990)} currency="EUR" locale="en" />,
    );
    expect(figureText(element)).toBe("−€29.90");
  });

  it("appends a caller class without dropping its own", () => {
    const element = renderFigure(
      <Money amount={toMinor(8980)} currency="EUR" locale="es" className="text-right" />,
    );

    expect(element.className).toContain("tabular-nums");
    expect(element.className).toContain("text-right");
  });
});

describe("<AggregateMoney />", () => {
  /** €24,000,000 of lifetime revenue: past `MINOR_MAX`, and a good problem. */
  const OVER_CAP = 2_400_000_000;

  it("is the only path that can render an aggregate past MINOR_MAX", () => {
    // Both branded routes are genuinely closed for this value — this is the
    // premise the component exists for, so it is asserted rather than assumed.
    expect(OVER_CAP).toBeGreaterThan(MINOR_MAX);
    expect(() => toMinor(OVER_CAP)).toThrow();
    expect(isMinor(OVER_CAP)).toBe(false);

    const element = renderFigure(
      <AggregateMoney amountMinor={OVER_CAP} currency="EUR" locale="es" />,
    );

    expect(figureText(element)).toBe("24.000.000,00 €");
    // The `isMinor` fallback's failure mode, pinned: a bare integer where a
    // euro figure belongs.
    expect(figureText(element)).not.toBe(String(OVER_CAP));
  });

  it("renders the same figure as Money for an in-range value", () => {
    for (const locale of ["es", "en"] as const) {
      const aggregate = renderFigure(
        <AggregateMoney amountMinor={8980} currency="EUR" locale={locale} />,
      );
      const branded = renderFigure(<Money amount={toMinor(8980)} currency="EUR" locale={locale} />);

      expect(figureText(aggregate)).toBe(figureText(branded));
      expect(aggregate.className).toBe(branded.className);
    }
  });

  it("carries the same type treatment as a transactional amount", () => {
    const element = renderFigure(
      <AggregateMoney amountMinor={OVER_CAP} currency="EUR" locale="en" emphasis />,
    );

    expect(element.className).toContain("tabular-nums");
    expect(element.className).toContain("font-semibold");
    expect(element.className).not.toMatch(/font-mono|--font-mono/);
  });
});
