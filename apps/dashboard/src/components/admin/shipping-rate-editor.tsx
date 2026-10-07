"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { AdminShippingRate, ShippingStrategy } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { MoneyField, PopupButton, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Checkbox } from "@/components/ui/toggle";
import type { MoneyInputError } from "@/lib/admin/money-input";
import type { CreateShippingRateInput } from "@/lib/admin/shipping-api";
import {
  SHIPPING_CURRENCY,
  buildRatePayload,
  emptyRateValues,
  rateToValues,
  type RateField,
  type RateFieldErrors,
  type RateFormError,
  type RateFormValues,
} from "@/lib/admin/shipping-form";

/**
 * Create/edit one shipping rate — name, pricing rule, price, free-shipping
 * threshold, active flag and the "2–5 días" transit line. Prices are typed in
 * whole pesos ("15000" or "15.000").
 *
 * ERRORS ARE CODES. `buildRatePayload` returns a closed union per field and
 * this component maps it onto `admin.shipping.fieldErrors.*` through a TOTAL
 * `Record`; the save failure arrives already translated from the parent, which
 * owns the reason-aware mapping.
 */

const FIELD_ERROR_KEYS: Readonly<Record<RateFormError, string>> = {
  EMPTY: "fieldErrors.EMPTY",
  NOT_A_NUMBER: "fieldErrors.NOT_A_NUMBER",
  GROUPING_SEPARATOR: "fieldErrors.GROUPING_SEPARATOR",
  NEGATIVE: "fieldErrors.NEGATIVE",
  TOO_MANY_DECIMALS: "fieldErrors.TOO_MANY_DECIMALS",
  TOO_LARGE: "fieldErrors.TOO_LARGE",
  REQUIRED: "fieldErrors.REQUIRED",
  TOO_LONG: "fieldErrors.TOO_LONG",
  BOUNDS_ORDER: "fieldErrors.BOUNDS_ORDER",
  NOT_POSITIVE: "fieldErrors.NOT_POSITIVE",
  TRANSIT_ORDER: "fieldErrors.TRANSIT_ORDER",
};

const STRATEGIES: readonly ShippingStrategy[] = ["FLAT", "WEIGHT", "PRICE"];

export interface ShippingRateEditorProps {
  /** Absent when creating. */
  readonly rate?: AdminShippingRate;
  /** Resolves with a TRANSLATED failure, or undefined on success. */
  readonly onSave: (payload: CreateShippingRateInput) => Promise<string | undefined>;
  readonly onCancel: () => void;
}

export function ShippingRateEditor({ rate, onSave, onCancel }: ShippingRateEditorProps) {
  const t = useTranslations("admin.shipping");
  const [values, setValues] = useState<RateFormValues>(() =>
    rate === undefined ? emptyRateValues() : rateToValues(rate),
  );
  const [errors, setErrors] = useState<RateFieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function update<K extends keyof RateFormValues>(key: K, value: RateFormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  /** Spread, not `error={…}`: an explicit `undefined` breaks exactOptionalPropertyTypes. */
  function errorProp(field: RateField): { readonly error?: string } {
    const code = errors[field];
    return code === undefined ? {} : { error: t(FIELD_ERROR_KEYS[code]) };
  }

  const moneyErrors: Readonly<Record<MoneyInputError, string>> = {
    EMPTY: t("fieldErrors.EMPTY"),
    NOT_A_NUMBER: t("fieldErrors.NOT_A_NUMBER"),
    GROUPING_SEPARATOR: t("fieldErrors.GROUPING_SEPARATOR"),
    NEGATIVE: t("fieldErrors.NEGATIVE"),
    TOO_MANY_DECIMALS: t("fieldErrors.TOO_MANY_DECIMALS"),
    TOO_LARGE: t("fieldErrors.TOO_LARGE"),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(undefined);
    const built = buildRatePayload(values);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const failure = await onSave(built.value);
      if (failure !== undefined) setFormError(failure);
    } finally {
      setSaving(false);
    }
  }

  const idPrefix = rate === undefined ? "new-rate" : `rate-${rate.id}`;

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      aria-label={rate === undefined ? t("rate.createTitle") : t("rate.editTitle")}
      className="grid gap-4 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)]"
    >
      <fieldset disabled={saving} className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
        <TextField
          id={`${idPrefix}-name-es`}
          label={t("rate.nameEs")}
          name="nameEs"
          value={values.nameEs}
          onChange={(value) => update("nameEs", value)}
          required
          maxLength={120}
          {...errorProp("nameEs")}
        />
        <TextField
          id={`${idPrefix}-name-en`}
          label={t("rate.nameEn")}
          name="nameEn"
          value={values.nameEn}
          onChange={(value) => update("nameEn", value)}
          hint={t("rate.nameEnHint")}
          maxLength={120}
          {...errorProp("nameEn")}
        />

        <PopupButton<ShippingStrategy>
          id={`${idPrefix}-strategy`}
          label={t("rate.strategy")}
          name="strategy"
          value={values.strategy}
          options={STRATEGIES.map((strategy) => ({
            value: strategy,
            label: t(`rate.strategies.${strategy}`),
          }))}
          onChange={(strategy) =>
            // A bound means grams under WEIGHT and pesos under PRICE, so a
            // typed bound never silently changes unit with the strategy.
            setValues((current) => ({ ...current, strategy, minValue: "", maxValue: "" }))
          }
        />
        <MoneyField
          id={`${idPrefix}-price`}
          label={t("rate.price")}
          name="priceGross"
          value={values.priceGross}
          currency={SHIPPING_CURRENCY}
          onChange={(next) => update("priceGross", next.raw)}
          required
          hint={t("rate.priceHint")}
          errorMessages={moneyErrors}
          {...errorProp("priceGross")}
        />

        {values.strategy === "WEIGHT" ? (
          <>
            <TextField
              id={`${idPrefix}-min`}
              label={t("rate.minGrams")}
              name="minValue"
              inputMode="numeric"
              value={values.minValue}
              onChange={(value) => update("minValue", value)}
              hint={t("rate.boundsHint")}
              {...errorProp("minValue")}
            />
            <TextField
              id={`${idPrefix}-max`}
              label={t("rate.maxGrams")}
              name="maxValue"
              inputMode="numeric"
              value={values.maxValue}
              onChange={(value) => update("maxValue", value)}
              {...errorProp("maxValue")}
            />
          </>
        ) : null}
        {values.strategy === "PRICE" ? (
          <>
            <MoneyField
              id={`${idPrefix}-min`}
              label={t("rate.minPrice")}
              name="minValue"
              value={values.minValue}
              currency={SHIPPING_CURRENCY}
              onChange={(next) => update("minValue", next.raw)}
              hint={t("rate.boundsHint")}
              errorMessages={moneyErrors}
              {...errorProp("minValue")}
            />
            <MoneyField
              id={`${idPrefix}-max`}
              label={t("rate.maxPrice")}
              name="maxValue"
              value={values.maxValue}
              currency={SHIPPING_CURRENCY}
              onChange={(next) => update("maxValue", next.raw)}
              errorMessages={moneyErrors}
              {...errorProp("maxValue")}
            />
          </>
        ) : null}

        <MoneyField
          id={`${idPrefix}-free-over`}
          label={t("rate.freeOver")}
          name="freeOverSubtotal"
          value={values.freeOverSubtotal}
          currency={SHIPPING_CURRENCY}
          onChange={(next) => update("freeOverSubtotal", next.raw)}
          hint={t("rate.freeOverHint")}
          errorMessages={moneyErrors}
          {...errorProp("freeOverSubtotal")}
        />
        <div className="flex items-end pb-2">
          <Checkbox
            id={`${idPrefix}-active`}
            label={t("rate.active")}
            checked={values.isActive}
            onChange={(checked) => update("isActive", checked)}
          />
        </div>
      </fieldset>

      <fieldset disabled={saving} className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
        <legend className="mb-2 text-[13px] font-semibold text-[var(--label)]">
          {t("rate.transitLegend")}
        </legend>

        <TextField
          id={`${idPrefix}-transit-min`}
          label={t("rate.transitMin")}
          name="transitDaysMin"
          inputMode="numeric"
          value={values.transitDaysMin}
          onChange={(value) => update("transitDaysMin", value)}
          hint={t("rate.transitHint")}
          {...errorProp("transitDaysMin")}
        />
        <TextField
          id={`${idPrefix}-transit-max`}
          label={t("rate.transitMax")}
          name="transitDaysMax"
          inputMode="numeric"
          value={values.transitDaysMax}
          onChange={(value) => update("transitDaysMax", value)}
          {...errorProp("transitDaysMax")}
        />
      </fieldset>

      {formError === undefined ? null : <Notice tone="danger">{formError}</Notice>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="standard" size="compact" disabled={saving} onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" variant="prominent" size="compact" disabled={saving}>
          {saving
            ? t("saving")
            : rate === undefined
              ? t("rate.create")
              : t("save")}
        </Button>
      </div>
    </form>
  );
}
