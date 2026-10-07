import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import {
  PackComponentsPicker,
  type PackComponentCandidate,
  type PackComponentSelection,
} from "./pack-components-picker";
import esMessages from "../../../messages/es.json";

const form = esMessages.admin.productForm;

const TEE_VARIANTS = [
  { id: "v-cre-300", label: "300 g", priceGross: 1999, currency: "EUR", isActive: true },
  { id: "v-tee-m", label: "M", priceGross: 2999, currency: "EUR", isActive: true },
] as const;

const CANDIDATES: readonly PackComponentCandidate[] = [
  { id: "camiseta", slug: "camiseta", name: "Camiseta Oversize", variants: TEE_VARIANTS },
  {
    id: "gorra",
    slug: "gorra",
    name: "Sudadera Kumo",
    variants: [{ id: "v-mag", label: "120 caps", priceGross: 2495, currency: "EUR", isActive: true }],
  },
  { id: "sin-variantes", slug: "sin-variantes", name: "Sin variantes activas", variants: [] },
];

function renderPicker(
  selected: readonly PackComponentSelection[] = [],
  onChange = vi.fn(),
  candidates: readonly PackComponentCandidate[] = CANDIDATES,
  packPriceGross: number | null = null,
) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <PackComponentsPicker
        candidates={candidates}
        selected={selected}
        onChange={onChange}
        packPriceGross={packPriceGross}
        currency="EUR"
      />
    </NextIntlClientProvider>,
  );
  return onChange;
}

describe("<PackComponentsPicker />", () => {
  it("says so when no product is available to be a component, rather than showing an empty box", () => {
    renderPicker([], vi.fn(), []);

    expect(screen.getByText(form.packComponentsEmpty)).toBeInTheDocument();
  });

  it("pins the first ACTIVE variant, at quantity 1, the moment a candidate is ticked", async () => {
    const onChange = renderPicker();

    await userEvent.click(screen.getByLabelText("Camiseta Oversize"));

    expect(onChange).toHaveBeenCalledWith([
      { id: "camiseta", variantId: "v-cre-300", quantity: 1 },
    ]);
  });

  it("APPENDS a newly ticked component, because array position is the sort order", async () => {
    const onChange = renderPicker([{ id: "camiseta", variantId: "v-cre-300", quantity: 1 }]);

    await userEvent.click(screen.getByLabelText("Sudadera Kumo"));

    expect(onChange).toHaveBeenCalledWith([
      { id: "camiseta", variantId: "v-cre-300", quantity: 1 },
      { id: "gorra", variantId: "v-mag", quantity: 1 },
    ]);
  });

  it("unticking removes the entry entirely", async () => {
    const onChange = renderPicker([{ id: "camiseta", variantId: "v-cre-300", quantity: 1 }]);

    await userEvent.click(screen.getByLabelText("Camiseta Oversize"));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("disables a candidate with no active variant — it cannot be a component until it has one", () => {
    renderPicker();

    expect(screen.getByLabelText("Sin variantes activas")).toBeDisabled();
    expect(screen.getByText(form.packComponentsNoVariant)).toBeInTheDocument();
  });

  it("shows the quantity control only once a component is ticked", () => {
    renderPicker([{ id: "camiseta", variantId: "v-cre-300", quantity: 1 }]);

    expect(screen.getAllByLabelText(form.packComponentQuantityLabel)).toHaveLength(1);
  });

  it("changing the quantity field updates that entry only", () => {
    const onChange = renderPicker([
      { id: "camiseta", variantId: "v-cre-300", quantity: 1 },
      { id: "gorra", variantId: "v-mag", quantity: 1 },
    ]);

    // ONE change event with the final value, not keystroke-by-keystroke: the
    // input's `value` is controlled by `selected`, which this test double
    // never feeds back after a change, so simulating real typing against a
    // value that never visually updates produces interleaved garbage.
    const [quantityInput] = screen.getAllByLabelText(form.packComponentQuantityLabel);
    if (quantityInput === undefined) throw new Error("fixture");
    fireEvent.change(quantityInput, { target: { value: "5" } });

    expect(onChange).toHaveBeenLastCalledWith([
      { id: "camiseta", variantId: "v-cre-300", quantity: 5 },
      { id: "gorra", variantId: "v-mag", quantity: 1 },
    ]);
  });

  it("clamps quantity to the 1-20 range rather than accepting anything typed", () => {
    const onChange = renderPicker([{ id: "camiseta", variantId: "v-cre-300", quantity: 1 }]);

    const [quantityInput] = screen.getAllByLabelText(form.packComponentQuantityLabel);
    if (quantityInput === undefined) throw new Error("fixture");
    fireEvent.change(quantityInput, { target: { value: "999" } });

    expect(onChange).toHaveBeenLastCalledWith([
      { id: "camiseta", variantId: "v-cre-300", quantity: 20 },
    ]);
  });

  it("flags an invalid selection count (below the minimum) inline", () => {
    renderPicker([{ id: "camiseta", variantId: "v-cre-300", quantity: 1 }]);

    expect(screen.getByText(form.packComponentsCountInvalid.replace("{min}", "2").replace("{max}", "6"))).toBeInTheDocument();
  });

  it("shows no invalid-count notice for an empty selection — that is the starting state, not an error", () => {
    renderPicker([]);

    expect(
      screen.queryByText(form.packComponentsCountInvalid.replace("{min}", "2").replace("{max}", "6")),
    ).not.toBeInTheDocument();
  });

  it("the running total weights each component's price by its OWN quantity, not just 1 of each", () => {
    renderPicker(
      [
        { id: "camiseta", variantId: "v-cre-300", quantity: 3 }, // 3 × 19.99 = 59.97
        { id: "gorra", variantId: "v-mag", quantity: 1 }, // 1 × 24.95 = 24.95
      ],
      vi.fn(),
      CANDIDATES,
      7999,
    );

    // Components total: 59.97 + 24.95 = 84.92 €.
    expect(screen.getByText(/84,92/)).toBeInTheDocument();
    expect(screen.getByText(/79,99/)).toBeInTheDocument();
  });

  it("shows no total hint while the pack price has not been typed yet", () => {
    renderPicker([{ id: "camiseta", variantId: "v-cre-300", quantity: 1 }], vi.fn(), CANDIDATES, null);

    expect(screen.queryByText(/€.*€/)).not.toBeInTheDocument();
  });
});
