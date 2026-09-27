"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { CurrencyCode, Locale } from "@akai/contracts";
import { formatMoney, toMinor } from "@akai/money";

import { PopupButton, TextField } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/toggle";
import { Notice } from "@/components/ui/notice";

/**
 * Choose the 2–6 products THIS pack is made of, and pin one variant per
 * component.
 *
 * CLOSELY MIRRORS `AddOnPicker` (same candidate-list/checkbox/`PopupButton`
 * shape), with three differences that follow directly from a pack's own rules
 * (see `ProductPackComponent`'s schema comment): the pinned variant is
 * REQUIRED the moment a component is ticked — there is no "no variant yet"
 * state a pack component can be left in, so ticking a candidate immediately
 * pins its first active variant rather than leaving the entry unresolved —
 * the selection COUNT is validated 2–6 inline, which `AddOnPicker` has no
 * reason to do — and each entry carries its own QUANTITY ("5x Reta 20mg" as
 * one slot, not five identical slots), defaulting to 1, which weights the
 * running total hint below and, server-side, the pro-rata price allocation.
 *
 * Pure display, same reasoning as `AddOnPicker`: it fetches nothing, so it
 * stays testable without a network and keeps every admin request on the
 * server side of the boundary.
 */

export interface PackComponentCandidate {
  readonly id: string;
  readonly slug: string;
  /** Already resolved to the operator's locale by the caller. */
  readonly name: string;
  readonly status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  readonly variants?: readonly PackComponentCandidateVariant[];
}

/** One variant of a candidate, as the picker needs it. */
export interface PackComponentCandidateVariant {
  readonly id: string;
  readonly label: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly isActive: boolean;
}

/** One entry of the pack's chosen component list — a component, its pinned variant, and how many. */
export interface PackComponentSelection {
  readonly id: string;
  readonly variantId: string;
  /** How many of this component one pack contains — "5x Reta 20mg" as one slot. */
  readonly quantity: number;
}

/** Mirrors the contract's own `quantity: z.number().int().min(1).max(20)`. */
const MIN_COMPONENT_QUANTITY = 1;
const MAX_COMPONENT_QUANTITY = 20;

export interface PackComponentsPickerProps {
  readonly candidates: readonly PackComponentCandidate[];
  readonly selected: readonly PackComponentSelection[];
  readonly onChange: (next: readonly PackComponentSelection[]) => void;
  /** The locale being edited, so prices read the way the operator expects. */
  readonly locale: Locale;
  /**
   * The pack's OWN flat price, as currently typed — parsed but not yet
   * necessarily valid, so this is `null` while the field is empty or
   * unparseable rather than blocking the running-total hint on a fully valid
   * form.
   */
  readonly packPriceGross: number | null;
  readonly currency: CurrencyCode;
}

const MIN_COMPONENTS = 2;
const MAX_COMPONENTS = 6;

export function PackComponentsPicker({
  candidates,
  selected,
  onChange,
  locale,
  packPriceGross,
  currency,
}: PackComponentsPickerProps) {
  const t = useTranslations("admin.productForm");
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return candidates;
    return candidates.filter(
      (candidate) =>
        candidate.name.toLowerCase().includes(needle) ||
        candidate.slug.toLowerCase().includes(needle),
    );
  }, [candidates, filter]);

  const byId = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate])),
    [candidates],
  );

  // The running total: each selected component priced at its OWN pinned
  // variant TIMES its own quantity, so the hint reflects exactly what the
  // picker has chosen rather than a candidate's first-active-variant guess
  // or an implicit "1 of each" that no longer holds once quantity > 1.
  const componentsTotal = useMemo(() => {
    let total = 0;
    let resolvable = true;
    for (const entry of selected) {
      const candidate = byId.get(entry.id);
      const variant = candidate?.variants?.find((row) => row.id === entry.variantId);
      if (variant === undefined) {
        resolvable = false;
        continue;
      }
      total += variant.priceGross * entry.quantity;
    }
    return resolvable ? total : null;
  }, [selected, byId]);

  if (candidates.length === 0) {
    return (
      <p className="text-[12px] text-[var(--label-secondary)]">{t("packComponentsEmpty")}</p>
    );
  }

  function firstActiveVariant(
    candidate: PackComponentCandidate,
  ): PackComponentCandidateVariant | undefined {
    return (candidate.variants ?? []).find((variant) => variant.isActive);
  }

  function toggle(id: string, checked: boolean): void {
    if (!checked) {
      onChange(selected.filter((entry) => entry.id !== id));
      return;
    }
    // REQUIRED THE MOMENT IT IS TICKED: pin the first active variant so the
    // entry is never left unresolved. The operator can change it immediately
    // below.
    const candidate = byId.get(id);
    const variant = candidate === undefined ? undefined : firstActiveVariant(candidate);
    if (variant === undefined) {
      // No active variant to pin — nothing to add. The row still renders
      // unchecked, which is the honest state: this product cannot be a
      // component until it has a sellable variant.
      return;
    }
    onChange([...selected, { id, variantId: variant.id, quantity: 1 }]);
  }

  /** Change which variant this component pins. */
  function setVariant(id: string, variantId: string): void {
    onChange(
      selected.map((entry) => (entry.id === id ? { ...entry, variantId } : entry)),
    );
  }

  /** Change how many of this component one pack contains — raw text, clamped and parsed on change. */
  function setQuantity(id: string, raw: string): void {
    const parsed = Math.trunc(Number(raw));
    const quantity = Number.isFinite(parsed)
      ? Math.min(MAX_COMPONENT_QUANTITY, Math.max(MIN_COMPONENT_QUANTITY, parsed))
      : MIN_COMPONENT_QUANTITY;
    onChange(selected.map((entry) => (entry.id === id ? { ...entry, quantity } : entry)));
  }

  function variantLabel(variant: PackComponentCandidateVariant): string {
    const price =
      variant.priceGross === 0
        ? t("defaultVariantFree")
        : formatMoney(toMinor(variant.priceGross), variant.currency as CurrencyCode, locale);
    return `${variant.label} · ${price}`;
  }

  const count = selected.length;
  const countInvalid = count > 0 && (count < MIN_COMPONENTS || count > MAX_COMPONENTS);

  return (
    <div className="grid gap-2">
      <TextField
        label={t("packComponentsSearch")}
        name="pack-component-filter"
        value={filter}
        onChange={setFilter}
      />
      <p className="text-[11px] text-[var(--label-secondary)]">
        {t("packComponentsSelected", { count, min: MIN_COMPONENTS, max: MAX_COMPONENTS })}
      </p>
      {countInvalid && (
        <Notice tone="danger" placement="inline">
          {t("packComponentsCountInvalid", { min: MIN_COMPONENTS, max: MAX_COMPONENTS })}
        </Notice>
      )}
      <ul className="grid max-h-[260px] gap-1 overflow-y-auto">
        {shown.map((candidate) => {
          const entry = selected.find((row) => row.id === candidate.id);
          const variants = candidate.variants ?? [];
          const activeVariants = variants.filter((variant) => variant.isActive);

          return (
            <li key={candidate.id}>
              <Checkbox
                label={candidate.name}
                name={`pack-component-${candidate.id}`}
                checked={entry !== undefined}
                disabled={entry === undefined && activeVariants.length === 0}
                onChange={(checked) => toggle(candidate.id, checked)}
              />
              {entry === undefined && activeVariants.length === 0 && (
                <p className="ms-6 text-[11px] text-[var(--label-tertiary)]">
                  {t("packComponentsNoVariant")}
                </p>
              )}
              {candidate.status === "DRAFT" && (
                <p className="ms-6 text-[11px] text-[var(--label-tertiary)]">
                  {t("addOnsDraft")}
                </p>
              )}
              {/* ALWAYS SHOWN ONCE TICKED — a pinned variant is never optional
                  for a pack component, unlike an add-on's default. Quantity
                  sits beside it, same reasoning: "how many" is never optional
                  either, it just defaults to the ordinary case (1). */}
              {entry !== undefined && (
                <div className="ms-6 mt-1 flex flex-wrap items-end gap-2">
                  <PopupButton<string>
                    label={t("packComponentVariantLabel")}
                    name={`pack-component-variant-${candidate.id}`}
                    size="small"
                    value={entry.variantId}
                    options={activeVariants.map((variant) => ({
                      value: variant.id,
                      label: variantLabel(variant),
                    }))}
                    onChange={(variantId) => setVariant(candidate.id, variantId)}
                  />
                  <TextField
                    label={t("packComponentQuantityLabel")}
                    name={`pack-component-quantity-${candidate.id}`}
                    value={String(entry.quantity)}
                    onChange={(next) => setQuantity(candidate.id, next)}
                    // `inputMode` rather than `type="number"` — same reasoning
                    // discount-form.tsx gives for its own numeric field: the
                    // native spinner and locale coercion fight the string
                    // parsing `setQuantity` does instead.
                    inputMode="numeric"
                    className="w-20"
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* THE IMPLIED DISCOUNT. Only shown once both sides resolve — a
          component missing its variant price, or a pack price not yet typed,
          would otherwise render a misleading total. */}
      {componentsTotal !== null && packPriceGross !== null && selected.length > 0 && (
        <p className="text-[11px] text-[var(--label-secondary)]">
          {t("packComponentsTotalHint", {
            componentsTotal: formatMoney(toMinor(componentsTotal), currency, locale),
            packPrice: formatMoney(toMinor(packPriceGross), currency, locale),
          })}
        </p>
      )}
    </div>
  );
}
