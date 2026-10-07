"use client";

import { useId, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import {
  COLOMBIAN_DEPARTAMENTOS,
  STORE_COUNTRY_CODE,
  findDepartamento,
  normaliseColombianMobile,
  type Address,
  type AddressType,
} from "@akai/contracts";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Dialog } from "@/components/ui/overlay";
import type { ApiError, ApiResult } from "@/lib/api/errors";
import type { CreateAddressRequest } from "@/lib/account";
import {
  CheckboxField,
  SelectField,
  SubmitButton,
  TextField,
  indexFieldErrors,
} from "./form-field";

/**
 * Create/edit form for one address-book entry, in a modal sheet.
 *
 * The same component serves both operations. They differ only in which callback
 * runs and which title shows: the fields, their validation and their layout are
 * identical, and forking them into `NewAddressForm` and `EditAddressForm` would
 * guarantee the two drift the first time a field is added.
 *
 * WHY A SHEET RATHER THAN A REPLACEMENT. This form used to take over the whole
 * screen, so the moment a customer pressed "Editar" the rest of their address
 * book vanished — which is the worst possible moment to hide the thing they
 * were comparing against ("is this the one I ship to work?"). The drawn screen
 * keeps the list behind a scrim, and `Dialog` gives that plus the focus trap,
 * the Escape and scrim dismissal, and the return of focus to the button that
 * opened it.
 *
 * IT IS MOUNTED, NOT TOGGLED. `open` is hardcoded true and the PARENT decides
 * whether this component exists, so the draft state is discarded on close
 * rather than lingering behind an unmounted sheet and reappearing, half-typed,
 * the next time somebody edits a DIFFERENT address.
 */

export interface AddressFormProps {
  /** Absent when creating. Present values pre-fill the form when editing. */
  readonly address?: Address;
  readonly onSubmit: (input: CreateAddressRequest) => Promise<ApiResult<Address>>;
  readonly onCancel: () => void;
}

interface AddressFormState {
  readonly type: AddressType;
  readonly firstName: string;
  readonly lastName: string;
  readonly company: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  /** A departamento's canonical name, or "" while none is chosen. */
  readonly region: string;
  readonly postalCode: string;
  readonly phone: string;
  readonly isDefault: boolean;
}

function initialState(address: Address | undefined): AddressFormState {
  return {
    type: address?.type ?? "SHIPPING",
    firstName: address?.firstName ?? "",
    lastName: address?.lastName ?? "",
    company: address?.company ?? "",
    line1: address?.line1 ?? "",
    line2: address?.line2 ?? "",
    city: address?.city ?? "",
    region: address === undefined ? "" : (findDepartamento(address.region)?.name ?? ""),
    postalCode: address?.postalCode ?? "",
    phone: address?.phone ?? "",
    isDefault: address?.isDefault ?? false,
  };
}

/** Empty optional text becomes null — the contract's spelling of "not provided". */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A field pair that is two columns on a desktop sheet and two ROWS on a phone.
 *
 * Written as one class string rather than repeated per pair so the breakpoint
 * is decided once: the artboard's 400pt column has no room for a departamento
 * and a city side by side, and a pair that collapses at a different width from its
 * neighbour reads as a layout bug rather than as a responsive grid.
 */
const PAIR = "grid gap-3.5";

export function AddressForm({ address, onSubmit, onCancel }: AddressFormProps) {
  const t = useTranslations("account.addresses");
  const tCommon = useTranslations("account.common");
  const tErrors = useTranslations("errors");

  const titleId = useId();
  const [form, setForm] = useState<AddressFormState>(() => initialState(address));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  const title = address === undefined ? t("formTitleNew") : t("formTitleEdit");

  const update = <K extends keyof AddressFormState>(
    key: K,
    value: AddressFormState[K],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  function validate(): Readonly<Record<string, string>> {
    const errors: Record<string, string> = {};
    const required: readonly (keyof AddressFormState)[] = [
      "firstName",
      "lastName",
      "line1",
      "city",
      "region",
    ];

    for (const key of required) {
      const value = form[key];
      if (typeof value === "string" && value.trim() === "") {
        errors[key] = t("required");
      }
    }

    // Mirror the contract's Colombian rules so the customer gets an instant
    // answer; the API remains the authority.
    if (form.postalCode.trim() !== "" && !/^[0-9]{6}$/.test(form.postalCode.trim())) {
      errors.postalCode = t("invalidPostalCode");
    }
    if (form.phone.trim() !== "" && normaliseColombianMobile(form.phone) === null) {
      errors.phone = t("invalidPhone");
    }

    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const validationErrors = validate();
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSaving(true);
    setError(null);

    const result = await onSubmit({
      type: form.type,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      company: orNull(form.company),
      line1: form.line1.trim(),
      line2: orNull(form.line2),
      city: form.city.trim(),
      region: form.region,
      postalCode: orNull(form.postalCode),
      // Colombia is the only country served: fixed, never typed.
      countryCode: STORE_COUNTRY_CODE,
      phone: orNull(form.phone),
      isDefault: form.isDefault,
    });

    if (!result.ok) {
      setError(result.error);
      setFieldErrors(indexFieldErrors(result.error.fields));
      setIsSaving(false);
      return;
    }

    // On success the parent unmounts the sheet and refreshes the list, so there
    // is deliberately no local success state to leave stale.
    setIsSaving(false);
  }

  // VALIDATION_FAILED is already spelled out field by field, and a banner
  // repeating "check the details you entered" above five inline messages is one
  // more thing to read before reaching the actual problem.
  const banner = error === null || error.code === "VALIDATION_FAILED" ? null : error;

  return (
    <Dialog
      open
      onClose={onCancel}
      labelledBy={titleId}
      // `!` for the same reason `ConfirmAlert` needs it: the panel already
      // carries `max-w-[420px]`, Tailwind emits both at the same specificity,
      // and which one wins would otherwise be stylesheet order.
      className="max-w-[520px]!"
    >
      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        // The name the whole rebuild's tests scope themselves to. It also gives
        // the form its own region inside a dialog that is named by the heading,
        // which is what lets a screen-reader user jump straight to the fields.
        aria-label={title}
        className="grid gap-3.5 p-5"
      >
        <h2
          id={titleId}
          className="m-0 text-[17px] leading-[22px] font-semibold tracking-[-0.23px] text-[var(--label)]"
        >
          {title}
        </h2>

        {banner === null ? null : (
          <Notice
            tone="danger"
            placement="inline"
            // The CLOSED code against the `errors` catalogue, never
            // `error.message`: that string is an English log line naming
            // internal services, written for whoever is on call.
            {...(banner.requestId === "" ? {} : { requestId: banner.requestId })}
          >
            {tErrors.has(banner.code) ? tErrors(banner.code) : tErrors("generic")}
          </Notice>
        )}

        <SelectField<AddressType>
          label={t("type")}
          name="type"
          value={form.type}
          onChange={(value) => update("type", value)}
          disabled={isSaving}
          options={[
            { value: "SHIPPING", label: t("typeShipping") },
            { value: "BILLING", label: t("typeBilling") },
          ]}
        />

        <div className={`${PAIR} sm:grid-cols-2`}>
          <TextField
            label={t("firstName")}
            name="firstName"
            value={form.firstName}
            onChange={(value) => update("firstName", value)}
            autoComplete="given-name"
            required
            disabled={isSaving}
            maxLength={80}
            error={fieldErrors.firstName}
          />
          <TextField
            label={t("lastName")}
            name="lastName"
            value={form.lastName}
            onChange={(value) => update("lastName", value)}
            autoComplete="family-name"
            required
            disabled={isSaving}
            maxLength={80}
            error={fieldErrors.lastName}
          />
        </div>

        <TextField
          label={t("company")}
          name="company"
          value={form.company}
          onChange={(value) => update("company", value)}
          autoComplete="organization"
          disabled={isSaving}
          maxLength={120}
          error={fieldErrors.company}
        />

        <TextField
          label={t("line1")}
          name="line1"
          value={form.line1}
          onChange={(value) => update("line1", value)}
          autoComplete="address-line1"
          required
          disabled={isSaving}
          maxLength={200}
          error={fieldErrors.line1}
        />

        <TextField
          label={t("line2")}
          name="line2"
          value={form.line2}
          onChange={(value) => update("line2", value)}
          autoComplete="address-line2"
          disabled={isSaving}
          maxLength={200}
          error={fieldErrors.line2}
        />

        {/* Departamento and city (municipio) side by side on a desktop sheet. */}
        <div className={`${PAIR} sm:grid-cols-2`}>
          <div className="grid gap-1">
            <SelectField<string>
              label={t("region")}
              name="region"
              value={form.region}
              onChange={(value) => update("region", value)}
              disabled={isSaving}
              options={[
                { value: "", label: t("regionPlaceholder") },
                ...COLOMBIAN_DEPARTAMENTOS.map((departamento) => ({
                  value: departamento.name,
                  label: departamento.name,
                })),
              ]}
            />
            {fieldErrors.region === undefined ? null : (
              <p role="alert" className="m-0 text-[12px] text-[var(--danger-text)]">
                {fieldErrors.region}
              </p>
            )}
          </div>
          <TextField
            label={t("city")}
            name="city"
            value={form.city}
            onChange={(value) => update("city", value)}
            autoComplete="address-level2"
            required
            disabled={isSaving}
            maxLength={120}
            error={fieldErrors.city}
          />
        </div>

        <div className={`${PAIR} sm:grid-cols-2`}>
          <TextField
            label={t("phone")}
            name="phone"
            type="tel"
            value={form.phone}
            onChange={(value) => update("phone", value)}
            autoComplete="tel-national"
            disabled={isSaving}
            maxLength={32}
            hint={t("phoneHint")}
            error={fieldErrors.phone}
          />
          <TextField
            label={t("postalCode")}
            name="postalCode"
            value={form.postalCode}
            onChange={(value) => update("postalCode", value)}
            autoComplete="postal-code"
            disabled={isSaving}
            maxLength={6}
            hint={t("postalCodeHint")}
            error={fieldErrors.postalCode}
          />
        </div>

        <p className="m-0 text-[12px] text-[var(--label-secondary)]">{t("countryFixed")}</p>

        <CheckboxField
          label={t("isDefault")}
          name="isDefault"
          checked={form.isDefault}
          onChange={(checked) => update("isDefault", checked)}
          disabled={isSaving}
        />

        {/* Cancel first, Save last: the confirming action holds the trailing
            position in a sheet footer, which is the opposite of `ConfirmAlert`
            — there the destructive verb leads and Cancel takes the default. */}
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <Button
            variant="standard"
            size="mobile"
            onClick={onCancel}
            disabled={isSaving}
          >
            {tCommon("cancel")}
          </Button>
          <SubmitButton
            label={tCommon("save")}
            pendingLabel={tCommon("saving")}
            isPending={isSaving}
          />
        </div>
      </form>
    </Dialog>
  );
}
