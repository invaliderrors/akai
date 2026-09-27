"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { CurrencyCode, Locale, Minor } from "@akai/contracts";
import { formatMoney, multiply } from "@akai/money";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";

import { RichTextPreview } from "./rich-text-preview";

/**
 * The base row plus one row per tier, ascending — the storefront's
 * `buildRows` mirrored, savings measured against the BASE unit price.
 */
function previewTierRows(
  basePriceGross: Minor,
  tiers: readonly { minQuantity: number; unitPriceGross: Minor }[],
): readonly { quantity: number; unit: Minor; total: Minor; savingPercent: number }[] {
  const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
  return [
    { quantity: 1, unit: basePriceGross, total: basePriceGross, savingPercent: 0 },
    ...sorted.map((tier) => ({
      quantity: tier.minQuantity,
      unit: tier.unitPriceGross,
      total: multiply(tier.unitPriceGross, tier.minQuantity),
      savingPercent:
        basePriceGross === 0
          ? 0
          : Math.round((1 - tier.unitPriceGross / basePriceGross) * 100),
    })),
  ];
}

/**
 * The product as the shop will draw it, from copy that has not been saved.
 *
 * IT MIRRORS `apps/storefront/.../products/[slug]/page.tsx` MARKUP FOR MARKUP —
 * the two-column grid, the type scale, the option pills, the REF line, the usage
 * note, the description block and the add-on strip — because the question it
 * answers is "what will this look like?", and an approximation answers a
 * different question.
 *
 * THAT IS POSSIBLE WITHOUT IMPORTING ANYTHING FROM THE STOREFRONT, which
 * `@nx/enforce-module-boundaries` forbids: the dashboard's `globals.css` already
 * carries the storefront's colour tokens verbatim (a deliberate copy, with a
 * comment requiring the two to be mirrored) and already loads Schibsted Grotesk
 * and JetBrains Mono under the same CSS variable names. So `text-ink`,
 * `border-line`, `bg-paper` and `font-mono` mean the same thing in both apps.
 * The product page uses no serif, which is the one face the dashboard omits.
 *
 * WHEN THE STOREFRONT'S PAGE CHANGES, THIS MUST CHANGE WITH IT. There is no
 * mechanism that can enforce that across the boundary — which is exactly why it
 * is said here rather than left to be noticed.
 */

export interface PreviewImage {
  readonly url: string;
  readonly alt: string;
}

/** Mirrors the storefront's four stock states and its threshold of 5. */
export type PreviewStock = "soldOut" | "backorder" | "lowStock" | "inStock";

export interface PreviewVariant {
  readonly key: string;
  readonly sku: string;
  /** Null when the variant has no size and no name — the shop shows no picker. */
  readonly label: string | null;
  readonly priceGross: Minor | null;
  readonly compareAtGross: Minor | null;
  readonly imageUrl: string | null;
  readonly stock: PreviewStock;
  /** Volume tiers as typed, already parsed to minor units. Empty is a flat price. */
  readonly priceTiers: readonly { minQuantity: number; unitPriceGross: Minor }[];
}

export interface PreviewAddOn {
  readonly id: string;
  readonly name: string;
  readonly priceGross: number | null;
  readonly currency: string | null;
  /**
   * EVERY variant of the add-on, because the shop shows every one of them.
   *
   * An add-on that is free in one size and paid in another is making an offer,
   * and a preview that showed a single price would hide half of it — which is
   * the exact thing the storefront was changed to stop doing.
   *
   * OPTIONAL, so a caller that has no variants to hand still renders the flat
   * row rather than failing to compile.
   */
  readonly variants?: readonly PreviewAddOnVariant[];
}

export interface PreviewAddOnVariant {
  readonly id: string;
  readonly label: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly isActive: boolean;
}

export interface ProductPreviewDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly locale: Locale;
  readonly currency: CurrencyCode;
  readonly name: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly images: readonly PreviewImage[];
  readonly variants: readonly PreviewVariant[];
  readonly addOns: readonly PreviewAddOn[];
}

export function ProductPreviewDialog({
  open,
  onClose,
  locale,
  currency,
  name,
  shortDescription,
  description,
  images,
  variants,
  addOns,
}: ProductPreviewDialogProps) {
  const t = useTranslations("admin.productForm");
  const tUi = useTranslations("ui");
  const titleId = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const selected =
    variants.find((variant) => variant.key === selectedKey) ?? variants[0] ?? null;
  const [hero] = images;

  // The storefront's own condition, mirrored: more than one variant AND labels
  // that can tell them apart.
  const showPicker =
    variants.length > 1 && variants.some((variant) => variant.label !== null);

  return (
    <Dialog open={open} onClose={onClose} width="wide" labelledBy={titleId}>
      <div className="border-b border-[var(--separator-weak)] p-[var(--card-p)]">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2
              id={titleId}
              className="text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]"
            >
              {t("preview.title")}
            </h2>
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--label-secondary)]">
              {t("preview.hint")}
            </p>
          </div>
          <Button variant="standard" size="compact" onClick={onClose}>
            {tUi("close")}
          </Button>
        </div>
      </div>

      {/* Everything below is the storefront's own markup. `bg-paper` rather than
          the dialog's grouped background, because the shop's page is white. */}
      <div className="bg-paper px-6 py-10 font-sans">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="relative aspect-square overflow-hidden rounded-lg border border-line bg-surface">
            {hero === undefined ? (
              <div className="flex h-full items-center justify-center font-mono text-sm text-muted2">
                AKAI
              </div>
            ) : (
              // A staged file is a blob: URL with no intrinsic size known ahead
              // of time, which next/image cannot optimise — and the preview has
              // to work on a draft that has never been uploaded.
              // eslint-disable-next-line @next/next/no-img-element -- see above
              <img src={hero.url} alt={hero.alt} className="h-full w-full object-cover" />
            )}
          </div>

          <div>
            <h1 className="text-3xl font-semibold text-ink">{name}</h1>
            {shortDescription.trim() !== "" && (
              <div className="mt-4 whitespace-pre-line text-muted">{shortDescription}</div>
            )}

            {/* STOCK FIRST, as a dot plus a word — the shop's own opener. */}
            {selected !== null && (
              <p className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className={`inline-block h-2 w-2 rounded-full ${
                    selected.stock === "soldOut"
                      ? "bg-muted2"
                      : selected.stock === "backorder"
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                  }`}
                />
                <span className={selected.stock === "soldOut" ? "text-muted2" : "text-ink"}>
                  {t(`preview.${selected.stock}`)}
                </span>
              </p>
            )}

            {selected?.priceGross != null && (
              <p className="mt-3 font-mono text-3xl text-ink">
                {formatMoney(selected.priceGross, currency, locale)}
              </p>
            )}
            {selected?.compareAtGross != null &&
              selected.priceGross != null &&
              selected.compareAtGross > selected.priceGross && (
                <p className="mt-1 font-mono text-sm text-muted2 line-through">
                  {formatMoney(selected.compareAtGross, currency, locale)}
                </p>
              )}

            {showPicker && (
              <fieldset className="mt-6">
                <legend className="text-xs font-medium uppercase tracking-widest text-muted2">
                  {t("preview.variantHeading")}
                </legend>
                <div className="mt-3 flex flex-wrap gap-2">
                  {variants.map((variant) => {
                    const active = variant.key === selected?.key;
                    return (
                      <button
                        key={variant.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelectedKey(variant.key)}
                        className={`flex items-center gap-2 rounded-full border py-1.5 pe-4 ps-1.5 text-sm transition ${
                          active
                            ? "border-accent bg-accent/10 text-accent"
                            : "border-line text-muted"
                        }`}
                      >
                        {variant.imageUrl !== null && (
                          // eslint-disable-next-line @next/next/no-img-element -- see above
                          <img
                            src={variant.imageUrl}
                            alt=""
                            className="h-7 w-7 shrink-0 rounded-full object-cover"
                          />
                        )}
                        <span>{variant.label ?? variant.sku}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}

            {selected?.priceGross != null && selected.priceTiers.length > 0 && (
              <div className="mt-6 border-t border-line pt-5">
                <p className="text-xs font-medium uppercase tracking-widest text-muted2">
                  {t("preview.tiersHeading")}
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-muted2">
                        <th scope="col" className="pb-2 pe-3 font-medium">{t("preview.tierQuantity")}</th>
                        <th scope="col" className="pb-2 pe-3 text-end font-medium">{t("preview.tierTotal")}</th>
                        <th scope="col" className="pb-2 pe-3 text-end font-medium">{t("preview.tierPerUnit")}</th>
                        <th scope="col" className="pb-2 text-end font-medium">{t("preview.tierSaving")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewTierRows(selected.priceGross, selected.priceTiers).map((row, index, rows) => (
                        <tr key={row.quantity} className="border-t border-line text-muted">
                          <th scope="row" className="py-2 pe-3 text-start font-normal">
                            {t("preview.tierUnits", { count: row.quantity })}
                            {index === rows.length - 1 && index > 0 && (
                              <span className="ms-2 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
                                {t("preview.tierBest")}
                              </span>
                            )}
                          </th>
                          <td className="py-2 pe-3 text-end font-mono tabular-nums">
                            {formatMoney(row.total, currency, locale)}
                          </td>
                          <td className="py-2 pe-3 text-end font-mono tabular-nums">
                            {formatMoney(row.unit, currency, locale)}
                          </td>
                          <td className="py-2 text-end font-mono tabular-nums">
                            {row.savingPercent > 0 ? `−${row.savingPercent} %` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ADD-ONS IN THE COLUMN, as the shop now offers them: ticked here
                and bought by the same button. UNGROUPED, unlike the shop —
                `AddOnCandidate` carries no category, so grouping here would mean
                inventing a taxonomy the preview cannot actually know. That is a
                stated difference rather than a silent one. */}
            {addOns.length > 0 && (
              <fieldset className="mt-6 border-t border-line pt-5">
                <legend className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-widest text-muted2">
                  <span>{t("preview.addOnsHeading")}</span>
                  <span className="font-normal normal-case tracking-normal">
                    {t("preview.addOnsOptional")}
                  </span>
                </legend>
                <ul className="mt-3 grid gap-2">
                  {addOns.map((addOn) => {
                    const sellable = (addOn.variants ?? []).filter((v) => v.isActive);

                    // SEVERAL SIZES ARE A RADIO GROUP, every one on screen plus a
                    // way to decline — the shop's own shape. One size stays a
                    // checkbox, because a radio pair of "yes" and "no thanks" is
                    // a checkbox wearing two controls.
                    if (sellable.length > 1) {
                      return (
                        <li
                          key={addOn.id}
                          className="rounded-[12px] border border-line bg-paper p-3"
                        >
                          <fieldset disabled>
                            <legend className="text-sm text-ink">{addOn.name}</legend>
                            <div className="mt-2 grid gap-1">
                              {sellable.map((variant) => (
                                <label
                                  key={variant.id}
                                  className="flex items-baseline justify-between gap-3 text-sm"
                                >
                                  <span className="flex items-baseline gap-2">
                                    <input
                                      type="radio"
                                      name={`preview-add-on-${addOn.id}`}
                                      disabled
                                      className="h-3.5 w-3.5"
                                    />
                                    <span className="text-ink">{variant.label}</span>
                                  </span>
                                  <span
                                    className={`font-mono ${
                                      variant.priceGross === 0 ? "text-accent" : "text-muted"
                                    }`}
                                  >
                                    {variant.priceGross === 0
                                      ? t("preview.addOnsFree")
                                      : formatMoney(
                                          variant.priceGross as Minor,
                                          variant.currency as CurrencyCode,
                                          locale,
                                        )}
                                  </span>
                                </label>
                              ))}
                              <label className="flex items-baseline gap-2 text-sm">
                                <input
                                  type="radio"
                                  name={`preview-add-on-${addOn.id}`}
                                  disabled
                                  className="h-3.5 w-3.5"
                                />
                                <span className="text-muted2">{t("preview.addOnsNone")}</span>
                              </label>
                            </div>
                          </fieldset>
                        </li>
                      );
                    }

                    const only = sellable.at(0);
                    const price = only?.priceGross ?? addOn.priceGross;
                    const currency = only?.currency ?? addOn.currency;

                    return (
                      <li key={addOn.id} className="rounded-[12px] border border-line bg-paper p-3">
                        <span className="flex items-start gap-3">
                          <input type="checkbox" disabled className="mt-0.5 h-4 w-4 shrink-0" />
                          <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <span className="text-sm text-ink">{addOn.name}</span>
                            {price !== null && currency !== null && (
                              <span
                                className={`font-mono text-sm ${
                                  price === 0 ? "text-accent" : "text-ink"
                                }`}
                              >
                                {price === 0
                                  ? t("preview.addOnsFree")
                                  : formatMoney(price as Minor, currency as CurrencyCode, locale)}
                              </span>
                            )}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            )}

            {selected !== null && (
              <p className="mt-6 font-mono text-xs uppercase tracking-widest text-muted2">
                {t("preview.refLabel")} {selected.sku}
              </p>
            )}

            <div className="mt-6">
              {/* INERT, and said out loud below it. The shop's own markup, so the
                  weight and rhythm of the buy row are what the shopper will see. */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center rounded border border-line">
                  <span aria-hidden="true" className="px-3 py-3 text-muted2">−</span>
                  <input
                    type="number"
                    value={1}
                    readOnly
                    aria-label={t("preview.quantity")}
                    tabIndex={-1}
                    className="w-14 border-x border-line bg-paper py-3 text-center text-ink"
                  />
                  <span aria-hidden="true" className="px-3 py-3 text-muted2">+</span>
                </div>
                <button
                  type="button"
                  disabled
                  className="rounded bg-accent px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t("preview.addToCart")}
                </button>
              </div>
              <p className="mt-2 text-xs text-muted2">{t("preview.disabledHint")}</p>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6 text-xs text-muted">
              <li>{t("preview.batchTested")}</li>
            </ul>

            <p className="mt-6 text-xs text-muted2">{t("preview.usageNote")}</p>
          </div>
        </div>

        {description.trim() !== "" && (
          <div className="mt-16 max-w-3xl border-t border-line pt-10">
            <h2 className="text-sm font-medium uppercase tracking-widest text-muted2">
              {t("preview.descriptionHeading")}
            </h2>
            {/* Through the same sanitiser the shop applies, so what is drawn here
                is what will be stored and rendered. */}
            <RichTextPreview
              html={description}
              label={t("previewLabel")}
              emptyLabel={t("previewEmpty")}
            />
          </div>
        )}

      </div>
    </Dialog>
  );
}
