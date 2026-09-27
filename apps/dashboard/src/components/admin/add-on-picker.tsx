"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { CurrencyCode, Locale, ProductAddOnInput } from "@akai/contracts";
import { formatMoney, toMinor } from "@akai/money";

import { PopupButton, TextField } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/toggle";

/**
 * Choose which products THIS product's page offers as add-ons.
 *
 * ONLY UNLISTED PRODUCTS ARE CANDIDATES, and the caller filters them: an add-on
 * is a product marked "Solo como complemento", and offering a catalogue product
 * here would put it on two surfaces with no way to tell them apart.
 *
 * SELECTION ORDER IS THE VALUE. The array's position becomes the edge's
 * `sortOrder`, which is the operator's merchandising decision — so ticking a
 * box APPENDS rather than re-sorting into candidate order, and unticking
 * removes without disturbing the rest.
 *
 * Pure display: it takes the candidates and the selection and hands back a new
 * selection. It fetches nothing, which is what keeps it testable without a
 * network and keeps every admin request on the server side of the boundary.
 */

export interface AddOnCandidate {
  readonly id: string;
  readonly slug: string;
  /** Already resolved to the operator's locale by the caller. */
  readonly name: string;
  /**
   * DRAFT ADD-ONS ARE OFFERED BUT LABELLED.
   *
   * The storefront serves only ACTIVE products, so attaching a draft produces a
   * product page with no strip at all — and nothing anywhere says why. That is
   * how this was found. Hiding drafts would break a legitimate order of work
   * (attach the add-on, publish it after), so the honest fix is to let the
   * operator attach one and tell them what will happen.
   */
  readonly status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  /**
   * The first sellable variant's price, carried only so the PREVIEW's add-on
   * card can show one — the shop's card does, and a preview without it would
   * not be the mirror it claims to be. The picker itself never renders it.
   */
  readonly priceGross?: number | null;
  readonly currency?: string | null;
  /**
   * Every variant, so a default can be chosen. Absent is treated as "none
   * known", which simply hides the default control for that row rather than
   * failing — the picker is usable before the loader carries them.
   */
  readonly variants?: readonly AddOnCandidateVariant[];
}

/** One variant of a candidate, as the picker needs it. */
export interface AddOnCandidateVariant {
  readonly id: string;
  readonly label: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly isActive: boolean;
}

export interface AddOnPickerProps {
  readonly candidates: readonly AddOnCandidate[];
  /**
   * THE SELECTION IS NOW A LIST OF OBJECTS, not ids. Each entry carries which
   * variant the shop should pre-select for this host — "3 ml, free, already
   * ticked" — which is a fact about the PAIR and so travels with the edge.
   */
  readonly selected: readonly ProductAddOnInput[];
  readonly onChange: (next: readonly ProductAddOnInput[]) => void;
  /** The locale being edited, so prices read the way the operator expects. */
  readonly locale: Locale;
}

export function AddOnPicker({ candidates, selected, onChange, locale }: AddOnPickerProps) {
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

  if (candidates.length === 0) {
    return (
      <p className="text-[12px] text-[var(--label-secondary)]">{t("addOnsEmpty")}</p>
    );
  }

  function toggle(id: string, checked: boolean): void {
    onChange(
      checked
        ? [...selected, { id, defaultVariantId: null }]
        : selected.filter((entry) => entry.id !== id),
    );
  }

  /** Set (or clear, with "") which variant this add-on pre-selects. */
  function setDefaultVariant(id: string, variantId: string): void {
    onChange(
      selected.map((entry) =>
        entry.id === id
          ? { ...entry, defaultVariantId: variantId === "" ? null : variantId }
          : entry,
      ),
    );
  }

  /** A price, or the word for nothing — `formatMoney(0)` would read "0,00 €". */
  function variantLabel(variant: AddOnCandidateVariant): string {
    const price =
      variant.priceGross === 0
        ? t("defaultVariantFree")
        : formatMoney(toMinor(variant.priceGross), variant.currency as CurrencyCode, locale);
    return `${variant.label} · ${price}`;
  }

  return (
    <div className="grid gap-2">
      <TextField
        label={t("addOnsSearch")}
        name="add-on-filter"
        value={filter}
        onChange={setFilter}
      />
      <p className="text-[11px] text-[var(--label-secondary)]">
        {t("addOnsSelected", { count: selected.length })}
      </p>
      <ul className="grid max-h-[220px] gap-1 overflow-y-auto">
        {shown.map((candidate) => {
          const entry = selected.find((row) => row.id === candidate.id);
          const variants = candidate.variants ?? [];

          return (
            <li key={candidate.id}>
              <Checkbox
                label={candidate.name}
                name={`add-on-${candidate.id}`}
                checked={entry !== undefined}
                onChange={(checked) => toggle(candidate.id, checked)}
              />
              {candidate.status === "DRAFT" && (
                // Said beside the row rather than as a disabled state: the
                // choice is legitimate, the consequence is just not obvious.
                <p className="ms-6 text-[11px] text-[var(--label-tertiary)]">
                  {t("addOnsDraft")}
                </p>
              )}
              {/* ONLY ONCE TICKED. A default is a property of an attachment, so
                  offering one for an add-on this page does not carry would be
                  asking a question with no subject. */}
              {entry !== undefined && variants.length > 0 && (
                <div className="ms-6 mt-1">
                  <PopupButton<string>
                    label={t("defaultVariantLabel")}
                    name={`add-on-default-${candidate.id}`}
                    size="small"
                    value={entry.defaultVariantId ?? ""}
                    options={[
                      { value: "", label: t("defaultVariantNone") },
                      ...variants
                        // An inactive variant cannot be sold, so pre-selecting
                        // one would promise something the shop then refuses.
                        .filter((variant) => variant.isActive)
                        .map((variant) => ({
                          value: variant.id,
                          label: variantLabel(variant),
                        })),
                    ]}
                    onChange={(variantId) => setDefaultVariant(candidate.id, variantId)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
