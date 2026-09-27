import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { toMinor, type CurrencyCode } from "@akai/contracts";

import { ProductPreviewDialog, type PreviewVariant } from "./product-preview-dialog";
import esMessages from "../../../messages/es.json";

const EUR = "EUR" as CurrencyCode;
const form = esMessages.admin.productForm;

function variant(overrides: Partial<PreviewVariant> = {}): PreviewVariant {
  return {
    key: "v1",
    sku: "AK-5",
    label: "S",
    priceGross: toMinor(4999),
    compareAtGross: null,
    imageUrl: null,
    stock: "inStock" as const,
    priceTiers: [],
    ...overrides,
  };
}

function renderPreview(overrides: Partial<Parameters<typeof ProductPreviewDialog>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ProductPreviewDialog
        open
        onClose={() => {}}
        locale="es"
        currency={EUR}
        name="Sudadera 1"
        shortDescription="Resumen"
        description="<p>Descripción</p>"
        images={[]}
        variants={[variant()]}
        addOns={[]}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
}

describe("<ProductPreviewDialog />", () => {
  it("draws the copy the operator has not saved yet", () => {
    renderPreview();

    expect(screen.getByText("Sudadera 1")).toBeInTheDocument();
    expect(screen.getByText("Resumen")).toBeInTheDocument();
    // Through the same sanitiser the shop uses, so what is drawn here is what
    // will be stored — the region, not the raw markup.
    expect(
      screen.getByRole("region", { name: form.previewLabel }).textContent,
    ).not.toContain("<p>");
  });

  it("hides the picker unless the labels can tell the variants apart", () => {
    // THE STOREFRONT'S OWN CONDITION, mirrored. `product-purchase-panel.tsx`
    // gates on `variants.length > 1 && labels.some(l => l !== null)`. A preview
    // that showed a picker the shop will not show would be a lie about the very
    // thing this dialog exists to answer — and unnamed variants are exactly the
    // bug this whole change is fixing.
    const { unmount } = renderPreview({ variants: [variant()] });
    expect(
      screen.queryByRole("group", { name: form.preview.variantHeading }),
    ).not.toBeInTheDocument();
    unmount();

    renderPreview({
      variants: [
        variant({ key: "a", label: null }),
        variant({ key: "b", label: null }),
      ],
    });
    expect(
      screen.queryByRole("group", { name: form.preview.variantHeading }),
    ).not.toBeInTheDocument();
  });

  it("shows the picker once two variants carry a size", () => {
    renderPreview({
      variants: [
        variant({ key: "a", label: "S" }),
        variant({ key: "b", label: "M" }),
      ],
    });

    expect(
      screen.getByRole("group", { name: form.preview.variantHeading }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "M" })).toBeInTheDocument();
  });

  it("says the buttons do nothing rather than looking live", () => {
    renderPreview();

    expect(screen.getByRole("button", { name: form.preview.addToCart })).toBeDisabled();
    expect(screen.getByText(form.preview.disabledHint)).toBeInTheDocument();
  });

  it("draws the shop's own empty hero when there are no images", () => {
    // The storefront renders the wordmark inside the same bordered square, so
    // the preview does too. A dashboard-only sentence here would be the one
    // place the mirror stopped being a mirror.
    renderPreview({ images: [] });

    expect(screen.getByText("AKAI")).toBeInTheDocument();
  });
});

describe("<ProductPreviewDialog /> — volume pricing", () => {
  it("draws the tier table the shop will draw, with the same arithmetic", () => {
    // The storefront computes total = unit x quantity in minor units and states
    // the saving against the BASE unit price. A preview that rounded differently
    // would send an operator to publish a table the shop then contradicts.
    renderPreview({
      variants: [
        variant({ priceTiers: [{ minQuantity: 3, unitPriceGross: toMinor(3999) }] }),
      ],
    });

    expect(screen.getByText(form.preview.tiersHeading)).toBeInTheDocument();
    // 3999 x 3 = 11997 minor units.
    expect(screen.getByText("119,97 €")).toBeInTheDocument();
    // 3999 against a 4999 base is 20 % off.
    expect(screen.getByText(/−20 %/)).toBeInTheDocument();
  });

  it("draws no table for a flat-priced variant", () => {
    // Which is most products. A one-row "volume pricing" table is a promise the
    // product does not make — the storefront returns null for the same reason.
    renderPreview();

    expect(screen.queryByText(form.preview.tiersHeading)).not.toBeInTheDocument();
  });

  it("ignores a tier the operator has not finished typing", () => {
    // `previewVariants` drops an unparseable tier rather than drawing a row the
    // shop could never render; `buildPayload` is what names the mistake.
    renderPreview({ variants: [variant({ priceTiers: [] })] });

    expect(screen.queryByText(form.preview.tiersHeading)).not.toBeInTheDocument();
  });
});

describe("<ProductPreviewDialog /> — add-ons in the buy column", () => {
  const WATER = {
    id: "ao-1",
    name: "Bolsa tote",
    priceGross: 1250,
    currency: "EUR",
  } as const;

  it("draws the add-ons the operator chose, with their prices", () => {
    // The shop's strip shows a name and a price per card, so the preview does
    // too — this is the half of the page that was missing entirely before.
    renderPreview({ addOns: [WATER] });

    expect(screen.getByText("Bolsa tote")).toBeInTheDocument();
    expect(screen.getByText(/12,50/)).toBeInTheDocument();
    expect(screen.getByText(form.preview.addOnsHeading)).toBeInTheDocument();
  });

  it("draws EVERY variant of an add-on, not one price standing in for a choice", () => {
    // THE BUG THIS PINS. The preview showed a single price per add-on, so an
    // add-on that is free in one size and paid in another looked like a flat
    // charge — hiding exactly the offer the storefront was changed to show.
    renderPreview({
      addOns: [
        {
          ...WATER,
          variants: [
            { id: "w3", label: "3 ml", priceGross: 0, currency: "EUR", isActive: true },
            { id: "w10", label: "10 ml", priceGross: 845, currency: "EUR", isActive: true },
          ],
        },
      ],
    });

    expect(screen.getByText("3 ml")).toBeInTheDocument();
    expect(screen.getByText("10 ml")).toBeInTheDocument();
    // A zero price reads as free, never as 0,00 €.
    expect(screen.getByText(form.preview.addOnsFree)).toBeInTheDocument();
    expect(screen.queryByText(/0,00/)).not.toBeInTheDocument();
    // And a way to decline, because a pre-selected add-on must be refusable.
    expect(screen.getByText(form.preview.addOnsNone)).toBeInTheDocument();
  });

  it("keeps a single-variant add-on as a checkbox, not a radio pair", () => {
    // "Yes" and "no thanks" for one option is a checkbox wearing two controls.
    renderPreview({
      addOns: [
        {
          ...WATER,
          variants: [
            { id: "w3", label: "3 ml", priceGross: 0, currency: "EUR", isActive: true },
          ],
        },
      ],
    });

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByText(form.preview.addOnsFree)).toBeInTheDocument();
  });

  it("will not offer an inactive variant", () => {
    // The shop cannot sell it, so previewing it would promise what the shop
    // then refuses.
    renderPreview({
      addOns: [
        {
          ...WATER,
          variants: [
            { id: "w3", label: "3 ml", priceGross: 0, currency: "EUR", isActive: true },
            { id: "w30", label: "30 ml", priceGross: 1900, currency: "EUR", isActive: false },
          ],
        },
      ],
    });

    expect(screen.queryByText("30 ml")).not.toBeInTheDocument();
  });

  it("falls back to the flat price when no variants are known", () => {
    // `variants` is optional, so a caller that has none still renders a row
    // rather than failing to compile — which is what every fixture above does.
    renderPreview({ addOns: [WATER] });

    expect(screen.getByText(/12,50/)).toBeInTheDocument();
  });

  it("shows no strip at all when none are chosen", () => {
    // Nothing to offer is not an empty state: the storefront renders `null`
    // rather than a heading over an empty box, and so does this.
    renderPreview({ addOns: [] });

    expect(screen.queryByText(form.preview.addOnsHeading)).not.toBeInTheDocument();
  });

  it("still names an add-on whose price is unknown", () => {
    // A product with no sellable variant has no price to show. The shop would
    // not offer it at all; here the operator has explicitly chosen it, so it is
    // named rather than silently dropped from their own selection.
    renderPreview({ addOns: [{ ...WATER, priceGross: null, currency: null }] });

    expect(screen.getByText("Bolsa tote")).toBeInTheDocument();
  });
});
