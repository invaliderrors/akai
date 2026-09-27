import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ProductAddOnInput } from "@akai/contracts";

import { AddOnPicker, type AddOnCandidate } from "./add-on-picker";
import esMessages from "../../../messages/es.json";

const form = esMessages.admin.productForm;

/** Bacteriostatic water: 3 ml free, 10 ml paid, 30 ml discontinued. */
const WATER_VARIANTS = [
  { id: "a3", label: "3 ml", priceGross: 0, currency: "EUR", isActive: true },
  { id: "a10", label: "10 ml", priceGross: 845, currency: "EUR", isActive: true },
  { id: "a30", label: "30 ml", priceGross: 1900, currency: "EUR", isActive: false },
] as const;

const CANDIDATES: readonly AddOnCandidate[] = [
  {
    id: "a",
    slug: "agua-bacteriostatica",
    name: "Agua bacteriostática",
    variants: WATER_VARIANTS,
  },
  { id: "b", slug: "jeringas", name: "Jeringas" },
  { id: "c", slug: "viales-vacios", name: "Viales vacíos" },
];

/** The selection is a list of ENTRIES now, not ids — each may name a default. */
function entry(id: string, defaultVariantId: string | null = null): ProductAddOnInput {
  return { id, defaultVariantId };
}

function renderPicker(
  selected: readonly ProductAddOnInput[] = [],
  onChange = vi.fn(),
  candidates: readonly AddOnCandidate[] = CANDIDATES,
) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AddOnPicker
        candidates={candidates}
        selected={selected}
        onChange={onChange}
        locale="es"
      />
    </NextIntlClientProvider>,
  );
  return onChange;
}

describe("<AddOnPicker />", () => {
  it("says so when nothing is marked as an add-on, rather than showing an empty box", () => {
    renderPicker([], vi.fn(), []);

    expect(screen.getByText(form.addOnsEmpty)).toBeInTheDocument();
  });

  it("APPENDS a newly ticked add-on, because position is the sort order", async () => {
    // The array's index becomes the edge's `sortOrder` server-side, so this is a
    // list and not a set. Appending is what lets an operator decide what the
    // shop shows first; re-sorting into candidate order would quietly overrule
    // them.
    const user = userEvent.setup();
    const onChange = renderPicker([entry("c")]);

    await user.click(screen.getByRole("checkbox", { name: "Jeringas" }));

    expect(onChange).toHaveBeenCalledWith([entry("c"), entry("b")]);
  });

  it("removes one without disturbing the order of the rest", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker([entry("c"), entry("b"), entry("a")]);

    await user.click(screen.getByRole("checkbox", { name: "Jeringas" }));

    expect(onChange).toHaveBeenCalledWith([entry("c"), entry("a")]);
  });

  it("filters by name and by slug, so either way of thinking about it works", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.type(screen.getByLabelText(form.addOnsSearch), "jering");
    expect(screen.getByRole("checkbox", { name: "Jeringas" })).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Agua bacteriostática" }),
    ).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText(form.addOnsSearch));
    await user.type(screen.getByLabelText(form.addOnsSearch), "viales-vacios");
    expect(screen.getByRole("checkbox", { name: "Viales vacíos" })).toBeInTheDocument();
  });

  it("reflects what is already selected", () => {
    renderPicker([entry("a")]);

    expect(screen.getByRole("checkbox", { name: "Agua bacteriostática" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Jeringas" })).not.toBeChecked();
  });
});

describe("<AddOnPicker /> — the pre-selected variant", () => {
  it("asks nothing until the add-on is actually attached", () => {
    // A default is a property of an ATTACHMENT. Offering one for an add-on this
    // page does not carry would be asking a question with no subject.
    renderPicker([]);

    expect(
      screen.queryByRole("combobox", { name: form.defaultVariantLabel }),
    ).not.toBeInTheDocument();
  });

  it("offers the add-on's variants once it is attached", () => {
    renderPicker([entry("a")]);

    expect(
      screen.getByRole("combobox", { name: form.defaultVariantLabel }),
    ).toBeInTheDocument();
  });

  it("records the chosen variant against that add-on's entry", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker([entry("a")]);

    await user.selectOptions(
      screen.getByRole("combobox", { name: form.defaultVariantLabel }),
      "a10",
    );

    expect(onChange).toHaveBeenCalledWith([entry("a", "a10")]);
  });

  it("clears the default back to nothing", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker([entry("a", "a10")]);

    await user.selectOptions(
      screen.getByRole("combobox", { name: form.defaultVariantLabel }),
      "",
    );

    expect(onChange).toHaveBeenCalledWith([entry("a", null)]);
  });

  it("reads a zero price as FREE, never as 0,00 €", () => {
    // The whole point of the feature: "3 ml comes free with this". Rendering
    // 0,00 € would make a gift look like a charge of nothing.
    renderPicker([entry("a")]);

    expect(
      screen.getByRole("option", { name: `3 ml · ${form.defaultVariantFree}` }),
    ).toBeInTheDocument();
    // A REGEX, NOT A LITERAL, and the reason is invisible: `Intl` separates the
    // amount from the currency symbol with a NON-BREAKING space (U+00A0), so a
    // hand-typed "8,45 €" carries a different character than the DOM does.
    // `getByText` hides this because its default normalizer collapses NBSP;
    // accessible-name computation keeps it, so the exact-string form fails
    // against markup that is entirely correct.
    expect(screen.getByRole("option", { name: /10 ml · 8,45/ })).toBeInTheDocument();
  });

  it("will not offer an INACTIVE variant as a default", () => {
    // Pre-selecting one would promise a shopper something the shop then
    // refuses to sell them.
    renderPicker([entry("a")]);

    expect(screen.queryByRole("option", { name: /30 ml/ })).not.toBeInTheDocument();
  });

  it("offers no control for an add-on whose variants are unknown", () => {
    // `variants` is optional on the candidate, so the picker stays usable
    // before the loader carries them rather than crashing on undefined.
    renderPicker([entry("b")]);

    expect(
      screen.queryByRole("combobox", { name: form.defaultVariantLabel }),
    ).not.toBeInTheDocument();
  });
});

describe("<AddOnPicker /> — draft add-ons", () => {
  const DRAFT: readonly AddOnCandidate[] = [
    { id: "a", slug: "agua-bacteriostatica", name: "Agua bacteriostática", status: "DRAFT" },
    { id: "b", slug: "jeringas", name: "Jeringas", status: "ACTIVE" },
  ];

  it("warns that a DRAFT add-on will not appear in the shop", () => {
    // THE FAILURE THIS EXISTS TO PREVENT. The storefront serves only ACTIVE
    // products, so attaching a draft produced a product page with no add-on
    // strip and nothing anywhere saying why.
    renderPicker([], vi.fn(), DRAFT);

    expect(screen.getByText(form.addOnsDraft)).toBeInTheDocument();
  });

  it("still lets a draft be attached — the order of work is legitimate", () => {
    // Attach the add-on, publish it afterwards. Disabling the row would break
    // that; labelling it explains it.
    const onChange = renderPicker([], vi.fn(), DRAFT);

    expect(
      screen.getByRole("checkbox", { name: "Agua bacteriostática" }),
    ).not.toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says nothing about a published one", () => {
    renderPicker([], vi.fn(), [DRAFT[1] as AddOnCandidate]);

    expect(screen.queryByText(form.addOnsDraft)).not.toBeInTheDocument();
  });
});
