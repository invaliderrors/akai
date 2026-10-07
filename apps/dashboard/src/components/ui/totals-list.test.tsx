import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { toMinor } from "@akai/contracts";

import { TotalsList, type TotalsListProps } from "./totals-list";

/**
 * The customer order in 04 Customer Screens: 79,80 subtotal, 4,95 shipping,
 * 15,58 VAT already inside it, 89,80 to pay. Neither optional line is drawn
 * there, which is the default this component has to get right.
 */
const BASE: TotalsListProps = {
  currency: "COP",
  locale: "es",
  subtotal: { label: "Subtotal", amount: toMinor(7_980_000) },
  shipping: { label: "Envío", amount: toMinor(1_500_000) },
  taxIncluded: { label: "IVA incluido", amount: toMinor(1_514_622) },
  total: { label: "Total", amount: toMinor(9_480_000) },
};

function renderTotals(props: Partial<TotalsListProps> = {}): HTMLElement {
  const { container } = render(<TotalsList {...BASE} {...props} />);
  const list = container.querySelector("dl");
  if (!(list instanceof HTMLElement)) {
    throw new Error("TotalsList rendered no <dl>");
  }
  return list;
}

/** The `<dd>` paired with a term, i.e. the figure the label is making a claim about. */
function valueFor(term: HTMLElement): HTMLElement {
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== "DD") {
    throw new Error(`No <dd> follows the term "${term.textContent ?? ""}"`);
  }
  return value;
}

/** The Money span inside a value cell — the element that carries the figure's own type. */
function figureIn(value: HTMLElement): HTMLElement {
  const figure = value.firstElementChild;
  if (!(figure instanceof HTMLElement)) {
    throw new Error("A totals value rendered no figure");
  }
  return figure;
}

function text(element: HTMLElement): string {
  // Escaped, not literal: es-ES separates the euro symbol with a no-break space
  // and an invisible literal is what nobody notices going missing.
  return (element.textContent ?? "").replace(/[\u00a0\u202f]/g, " ");
}

describe("<TotalsList />", () => {
  it("is a real description list, one dd per dt", () => {
    const list = renderTotals();
    const terms = list.querySelectorAll("dt");
    const values = list.querySelectorAll("dd");

    // Three secondary lines plus the total, with neither optional line given.
    // Semantics matter more here than markup tidiness: a screen reader
    // announces the pairing, which is the only thing telling a listener that
    // "89,80 €" is the TOTAL and not the VAT.
    expect(terms).toHaveLength(4);
    expect(values).toHaveLength(4);

    for (const term of terms) {
      expect(valueFor(term).tagName).toBe("DD");
    }
  });

  it("renders each figure against its own label", () => {
    renderTotals();

    expect(text(valueFor(screen.getByText("Subtotal")))).toBe("$ 79.800");
    expect(text(valueFor(screen.getByText("Envío")))).toBe("$ 15.000");
    expect(text(valueFor(screen.getByText("IVA incluido")))).toBe("$ 15.146");
    expect(text(valueFor(screen.getByText("Total")))).toBe("$ 94.800");
  });

  it("omits a zero discount and a zero refund entirely", () => {
    const list = renderTotals({
      discount: { label: "Descuento", amount: toMinor(0) },
      refunded: { label: "Reembolsado", amount: toMinor(0) },
    });

    // Not "renders 0,00 €" and not "renders an empty row" — the line is absent.
    // "−0,00 €" beside "Descuento" makes a customer hunt for money they never
    // lost, and it is the reason this component owns the suppression rather
    // than leaving it to two consumers to remember.
    expect(screen.queryByText("Descuento")).toBeNull();
    expect(screen.queryByText("Reembolsado")).toBeNull();
    expect(list.querySelectorAll("dt")).toHaveLength(4);
  });

  it("keeps a zero SHIPPING line, which is not the same thing", () => {
    renderTotals({ shipping: { label: "Envío", amount: toMinor(0) } });

    // Free delivery is information the customer wants; its absence would read
    // as a missing line rather than a waived charge.
    expect(text(valueFor(screen.getByText("Envío")))).toBe("$ 0");
  });

  it("renders a discount and a refund as deductions when they are non-zero", () => {
    renderTotals({
      discount: { label: "Descuento", amount: toMinor(1_200_000) },
      refunded: { label: "Reembolsado", amount: toMinor(2_990_000) },
    });

    expect(text(valueFor(screen.getByText("Descuento")))).toBe("−$ 12.000");
    expect(text(valueFor(screen.getByText("Reembolsado")))).toBe("−$ 29.900");
  });

  it("normalises a deduction that arrives already negated", () => {
    // The API returns non-negative magnitudes, but a consumer that had negated
    // one itself must not end up with a discount that ADDS to the bill.
    renderTotals({ discount: { label: "Descuento", amount: toMinor(-1_200_000) } });

    expect(text(valueFor(screen.getByText("Descuento")))).toBe("−$ 12.000");
  });

  it("puts the refund after the total, where it reads as 'of which'", () => {
    const list = renderTotals({ refunded: { label: "Reembolsado", amount: toMinor(2_990_000) } });
    const terms = Array.from(list.querySelectorAll("dt"), (term) => term.textContent);

    expect(terms).toEqual(["Subtotal", "Envío", "IVA incluido", "Total", "Reembolsado"]);
  });

  it("emphasises both halves of the total row and neither half of the others", () => {
    renderTotals();

    const totalTerm = screen.getByText("Total");
    const totalValue = valueFor(totalTerm);

    expect(totalTerm.className).toContain("font-semibold");
    expect(totalTerm.className).toContain("text-[17px]");
    expect(totalValue.className).toContain("text-[17px]");
    // The value's WEIGHT comes from Money's `emphasis`, because weight is
    // Money's business and size is the row's — so this half is checked on the
    // figure itself rather than on the cell around it.
    expect(figureIn(totalValue).className).toContain("font-semibold");

    const subtotalTerm = screen.getByText("Subtotal");
    expect(subtotalTerm.className).not.toContain("font-semibold");
    expect(figureIn(valueFor(subtotalTerm)).className).not.toContain("font-semibold");
  });

  it("secondary labels are muted and their figures are not", () => {
    renderTotals();

    const subtotalTerm = screen.getByText("Subtotal");
    expect(subtotalTerm.className).toContain("text-[var(--label-secondary)]");
    // Only the label steps back. The figure stays --label at every line, which
    // is what keeps a column of amounts one column.
    expect(figureIn(valueFor(subtotalTerm)).className).toContain("text-[var(--label)]");
  });

  it("drops to the admin type scale at compact density", () => {
    const list = renderTotals({ density: "compact" });

    expect(list.className).toContain("text-[12px]");
    expect(screen.getByText("Total").className).toContain("text-[13px]");
  });

  it("renders the figures in the same locale it is given", () => {
    renderTotals({
      locale: "en",
      subtotal: { label: "Subtotal", amount: toMinor(482_149_000) },
    });

    expect(text(valueFor(screen.getByText("Subtotal")))).toBe("$4,821,490");
  });
});
