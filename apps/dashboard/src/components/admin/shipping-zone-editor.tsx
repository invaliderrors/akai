"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { DESTINATION_COUNTRY_CODES, type AdminShippingZoneDetail } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Checkbox } from "@/components/ui/toggle";
import {
  buildZonePayload,
  findCountryConflicts,
  type ZoneFormError,
  type ZoneFormValues,
} from "@/lib/admin/shipping-form";
import type { CreateShippingZoneInput } from "@/lib/admin/shipping-api";

/**
 * Create/edit a shipping zone: name, countries, sort order (spec §7a).
 *
 * THE COUNTRY PICKER OFFERS EXACTLY `DESTINATION_COUNTRY_CODES` — the list the
 * checkout's country selector offers and the API validates against — so a zone
 * can never claim a country the storefront cannot sell to.
 *
 * A COUNTRY ALREADY IN ANOTHER ZONE IS SHOWN, NOT HIDDEN. Its checkbox names
 * the zone that holds it, and ticking it surfaces the conflict under the picker
 * before any round trip: "FR ya pertenece a «Unión Europea»". The API enforces
 * the rule for real (transactionally); this is the operator being told first.
 */

const FIELD_ERROR_KEYS: Readonly<Record<ZoneFormError, string>> = {
  REQUIRED: "fieldErrors.REQUIRED",
  TOO_LONG: "fieldErrors.TOO_LONG",
  NOT_A_WHOLE_NUMBER: "fieldErrors.NOT_A_WHOLE_NUMBER",
  COUNTRY_TAKEN: "fieldErrors.COUNTRY_TAKEN",
};

export interface ShippingZoneEditorProps {
  /** Absent when creating. */
  readonly zone?: AdminShippingZoneDetail;
  /** Every live zone — what the conflict check reads. */
  readonly zones: readonly AdminShippingZoneDetail[];
  /** ISO code → name in the operator's locale, computed on the server. */
  readonly countryNames: Readonly<Record<string, string>>;
  /** Resolves with a TRANSLATED failure, or undefined on success. */
  readonly onSave: (payload: CreateShippingZoneInput & { sortOrder: number }) => Promise<string | undefined>;
  readonly onCancel: () => void;
}

export function ShippingZoneEditor({
  zone,
  zones,
  countryNames,
  onSave,
  onCancel,
}: ShippingZoneEditorProps) {
  const t = useTranslations("admin.shipping");
  const [values, setValues] = useState<ZoneFormValues>(() => ({
    name: zone?.name ?? "",
    countryCodes: zone?.countryCodes ?? [],
    sortOrder: String(zone?.sortOrder ?? nextSortOrder(zones)),
  }));
  const [errors, setErrors] = useState<Partial<Record<"name" | "countryCodes" | "sortOrder", ZoneFormError>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const editingId = zone?.id ?? null;
  const conflicts = useMemo(
    () => findCountryConflicts(zones, editingId, values.countryCodes),
    [zones, editingId, values.countryCodes],
  );

  /** Who holds each country today, other than this zone. */
  const holders = useMemo(() => {
    const map = new Map<string, string>();
    for (const other of zones) {
      if (other.id === editingId) continue;
      for (const code of other.countryCodes) map.set(code, other.name);
    }
    return map;
  }, [zones, editingId]);

  function errorProp(field: "name" | "sortOrder"): { readonly error?: string } {
    const code = errors[field];
    return code === undefined ? {} : { error: t(FIELD_ERROR_KEYS[code]) };
  }

  function toggleCountry(code: string, checked: boolean): void {
    setValues((current) => ({
      ...current,
      countryCodes: checked
        ? [...current.countryCodes, code]
        : current.countryCodes.filter((entry) => entry !== code),
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(undefined);
    const built = buildZonePayload(values, conflicts);
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

  const idPrefix = zone === undefined ? "new-zone" : `zone-${zone.id}`;
  const countriesErrorId = `${idPrefix}-countries-error`;

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      aria-label={zone === undefined ? t("zone.createTitle") : t("zone.editTitle")}
      className="grid gap-4 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)]"
    >
      <fieldset disabled={saving} className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-[2fr_1fr]">
        <TextField
          id={`${idPrefix}-name`}
          label={t("zone.name")}
          name="name"
          value={values.name}
          onChange={(name) => setValues((current) => ({ ...current, name }))}
          required
          maxLength={120}
          {...errorProp("name")}
        />
        <TextField
          id={`${idPrefix}-sort`}
          label={t("zone.sortOrder")}
          name="sortOrder"
          inputMode="numeric"
          value={values.sortOrder}
          onChange={(sortOrder) => setValues((current) => ({ ...current, sortOrder }))}
          hint={t("zone.sortOrderHint")}
          {...errorProp("sortOrder")}
        />
      </fieldset>

      <fieldset
        disabled={saving}
        className="m-0 grid gap-2 border-0 p-0"
        {...(conflicts.length > 0 ? { "aria-describedby": countriesErrorId } : {})}
      >
        <legend className="mb-1 text-[13px] font-semibold text-[var(--label)]">
          {t("zone.countries")}
        </legend>
        <p className="m-0 text-[12px] text-[var(--label-secondary)]">{t("zone.countriesHint")}</p>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {DESTINATION_COUNTRY_CODES.map((code) => {
            const name = countryNames[code] ?? code;
            const holder = holders.get(code);
            return (
              <Checkbox
                key={code}
                id={`${idPrefix}-country-${code}`}
                name="countryCodes"
                label={
                  holder === undefined
                    ? t("zone.countryOption", { country: name, code })
                    : t("zone.countryOptionTaken", { country: name, code, zone: holder })
                }
                checked={values.countryCodes.includes(code)}
                onChange={(checked) => toggleCountry(code, checked)}
              />
            );
          })}
        </div>
        {conflicts.length === 0 ? null : (
          <div id={countriesErrorId}>
            <Notice tone="danger" placement="inline">
              {conflicts
                .map((conflict) =>
                  t("zone.conflict", {
                    country: countryNames[conflict.countryCode] ?? conflict.countryCode,
                    zone: conflict.zoneName,
                  }),
                )
                .join(" ")}
            </Notice>
          </div>
        )}
        {values.countryCodes.length === 0 ? (
          <p className="m-0 text-[12px] text-[var(--warning-text)]">{t("zone.noCountries")}</p>
        ) : null}
      </fieldset>

      {formError === undefined ? null : <Notice tone="danger">{formError}</Notice>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="standard" size="compact" disabled={saving} onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" variant="prominent" size="compact" disabled={saving}>
          {saving ? t("saving") : zone === undefined ? t("zone.create") : t("save")}
        </Button>
      </div>
    </form>
  );
}

/** A new zone goes to the end of the list unless the operator says otherwise. */
function nextSortOrder(zones: readonly AdminShippingZoneDetail[]): number {
  return zones.reduce((max, zone) => Math.max(max, zone.sortOrder + 1), 0);
}
