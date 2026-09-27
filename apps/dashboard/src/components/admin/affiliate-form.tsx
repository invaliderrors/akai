"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";

import { Button, buttonClassName } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Link } from "@/i18n/navigation";
import {
  createAffiliateRequestSchema,
  updateAffiliateRequestSchema,
  type AdminAffiliate,
  type CreateAffiliateRequest,
  type UpdateAffiliateRequest,
} from "@/lib/admin/schemas";

/**
 * Create/edit form for an affiliate record.
 *
 * Four plain fields, none of them money and none of them overloaded by a
 * `type` the way a discount's `value` is — so this is `discount-form.tsx`'s
 * shape (pure builder + a total field-error `Record`, validated against the
 * SAME schemas the action and the API use) without that file's currency and
 * basis-point arithmetic. `country` is a bare two-letter `TextField`, not a
 * `<select>` of ~190 options: the dashboard already has this precedent in
 * `account/address-form.tsx`, and building a world country-name picker here
 * would duplicate the storefront's own `lib/countries.ts` (app-local, not
 * importable across the `@/*` boundary) for a field only an operator — who
 * can be trusted with an ISO code — ever types.
 */
export type AffiliateFormError =
  | "REQUIRED"
  | "TOO_LONG"
  | "INVALID_COUNTRY"
  | "INVALID_EMAIL"
  | "INVALID";

export type AffiliateFieldErrors = Readonly<Record<string, AffiliateFormError>>;

/** Form-local state. Every field is a string: that is what an input holds. */
export interface AffiliateFormValues {
  readonly name: string;
  readonly country: string;
  readonly socialHandle: string;
  readonly email: string;
}

export type AffiliateBuildResult =
  | { readonly ok: true; readonly mode: "create"; readonly value: CreateAffiliateRequest }
  | { readonly ok: true; readonly mode: "edit"; readonly value: UpdateAffiliateRequest }
  | { readonly ok: false; readonly errors: AffiliateFieldErrors };

export interface AffiliateFormProps {
  /** Absent when creating. */
  readonly affiliate?: AdminAffiliate;
  /** Receives a payload already parsed by the same schema the API will use. */
  readonly onSubmit: (result: {
    readonly mode: "create";
    readonly value: CreateAffiliateRequest;
  } | {
    readonly mode: "edit";
    readonly value: UpdateAffiliateRequest;
  }) => Promise<void>;
  /** Rendered above the actions — e.g. a translated API failure from the editor. */
  readonly formError?: string | undefined;
  /** The destructive control, at the footer's left edge. See `discount-form.tsx`'s identical slot for why it is a slot and not a prop pair. */
  readonly dangerAction?: ReactNode;
  /** Where Cancel goes. A route only — `Link` adds the locale prefix. */
  readonly cancelHref?: string;
}

/** Field-error code → message key, as a TOTAL Record over the closed union. */
const FIELD_ERROR_KEYS: Readonly<Record<AffiliateFormError, string>> = {
  REQUIRED: "fieldErrors.REQUIRED",
  TOO_LONG: "fieldErrors.TOO_LONG",
  INVALID_COUNTRY: "fieldErrors.INVALID_COUNTRY",
  INVALID_EMAIL: "fieldErrors.INVALID_EMAIL",
  INVALID: "fieldErrors.INVALID",
};

const LEGEND_CLASS =
  "mb-2 p-0 text-[11px] font-semibold tracking-[0.06em] text-[var(--label-secondary)] uppercase";

export function AffiliateForm({
  affiliate,
  onSubmit,
  formError,
  dangerAction,
  cancelHref,
}: AffiliateFormProps) {
  const t = useTranslations("admin.affiliates");
  const formId = useId();
  const mode = affiliate === undefined ? "create" : "edit";

  const [values, setValues] = useState<AffiliateFormValues>(() =>
    toAffiliateFormValues(affiliate),
  );
  const [errors, setErrors] = useState<AffiliateFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  /** Fallback for a rejecting `onSubmit` the parent did not surface itself. */
  const [submitError, setSubmitError] = useState<string | null>(null);

  function patch(next: Partial<AffiliateFormValues>): void {
    setValues((current) => ({ ...current, ...next }));
  }

  function messageFor(field: string): string | undefined {
    const code = errors[field];
    return code === undefined ? undefined : t(FIELD_ERROR_KEYS[code]);
  }

  function errorProp(field: string): { readonly error?: string } {
    const message = messageFor(field);
    return message === undefined ? {} : { error: message };
  }

  const formMessage = formError ?? submitError ?? undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const built = buildAffiliatePayload(values, mode);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }

    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    try {
      await (built.mode === "create"
        ? onSubmit({ mode: "create", value: built.value })
        : onSubmit({ mode: "edit", value: built.value }));
    } catch {
      // CAUGHT, not re-thrown — same reasoning `discount-form.tsx`'s identical
      // catch gives: an escaping rejection here is an unhandled promise
      // rejection nobody sees, and the cause is the API's own English.
      setSubmitError(t("errors.UNKNOWN"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-describedby={`${formId}-error`}
      className="grid gap-[var(--card-p)]"
    >
      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={submitting}>
        <legend className={LEGEND_CLASS}>{t("form.sectionDetails")}</legend>

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("form.nameLabel")}
            name="name"
            id={`${formId}-name`}
            value={values.name}
            onChange={(next) => patch({ name: next })}
            maxLength={200}
            required
            {...errorProp("name")}
          />

          <TextField
            label={t("form.countryLabel")}
            name="country"
            id={`${formId}-country`}
            value={values.country}
            onChange={(next) => patch({ country: next })}
            autoComplete="country"
            maxLength={2}
            required
            hint={t("form.countryHint")}
            {...errorProp("country")}
          />

          <TextField
            label={t("form.socialHandleLabel")}
            name="socialHandle"
            id={`${formId}-social`}
            value={values.socialHandle}
            onChange={(next) => patch({ socialHandle: next })}
            maxLength={200}
            required
            hint={t("form.socialHandleHint")}
            {...errorProp("socialHandle")}
          />

          <TextField
            label={t("form.emailLabel")}
            name="email"
            id={`${formId}-email`}
            type="email"
            value={values.email}
            onChange={(next) => patch({ email: next })}
            autoComplete="email"
            required
            hint={t("form.emailHint")}
            {...errorProp("email")}
          />
        </div>
      </fieldset>

      <div id={`${formId}-error`}>
        {formMessage === undefined ? null : (
          <Notice tone="danger" placement="inline">
            {formMessage}
          </Notice>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--separator-weak)] pt-[var(--card-p)]">
        {dangerAction}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {cancelHref === undefined ? null : (
            <Link href={cancelHref} className={buttonClassName({ variant: "standard" })}>
              {t("form.cancel")}
            </Link>
          )}
          <Button
            type="submit"
            variant="prominent"
            pending={submitting}
            pendingLabel={t("form.submitting")}
          >
            {mode === "create" ? t("form.submitCreate") : t("form.submitSave")}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct testing.
// ---------------------------------------------------------------------------

/**
 * Turn form strings into a validated request body.
 *
 * Every field is trimmed and checked FIRST, so a blank required field reports
 * against its own box rather than surfacing as a zod issue on a field the
 * operator cannot map back to the screen. `country` is upper-cased on read,
 * matching `address-form.tsx`'s own identical normalisation.
 */
export function buildAffiliatePayload(
  values: AffiliateFormValues,
  mode: "create" | "edit",
): AffiliateBuildResult {
  const errors: Record<string, AffiliateFormError> = {};

  const name = values.name.trim();
  if (name.length === 0) {
    errors["name"] = "REQUIRED";
  } else if (name.length > 200) {
    errors["name"] = "TOO_LONG";
  }

  const country = values.country.trim().toUpperCase();
  if (country.length === 0) {
    errors["country"] = "REQUIRED";
  } else if (!/^[A-Z]{2}$/.test(country)) {
    errors["country"] = "INVALID_COUNTRY";
  }

  const socialHandle = values.socialHandle.trim();
  if (socialHandle.length === 0) {
    errors["socialHandle"] = "REQUIRED";
  } else if (socialHandle.length > 200) {
    errors["socialHandle"] = "TOO_LONG";
  }

  const email = values.email.trim();
  if (email.length === 0) {
    errors["email"] = "REQUIRED";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const shared = { name, country, socialHandle, email };

  // Two explicit branches rather than one ternary: the two schemas have
  // different output types, and a single `parsed` binding would widen `data`
  // to their union — which neither result shape accepts.
  if (mode === "create") {
    const parsed = createAffiliateRequestSchema.safeParse(shared);
    if (!parsed.success) {
      return { ok: false, errors: collectIssues(parsed.error.issues, errors) };
    }
    return { ok: true, mode: "create", value: parsed.data };
  }

  const parsed = updateAffiliateRequestSchema.safeParse(shared);
  if (!parsed.success) {
    return { ok: false, errors: collectIssues(parsed.error.issues, errors) };
  }
  return { ok: true, mode: "edit", value: parsed.data };
}

/**
 * Fold zod issues onto field codes. Everything the operator can get wrong is
 * already checked above, so reaching here means the schema caught something
 * the field checks did not — today only a malformed email.
 */
function collectIssues(
  issues: readonly z.ZodIssue[],
  errors: Record<string, AffiliateFormError>,
): AffiliateFieldErrors {
  for (const issue of issues) {
    const field = issue.path[0];
    const key = typeof field === "string" ? field : "name";
    errors[key] ??= key === "email" ? "INVALID_EMAIL" : "INVALID";
  }
  return errors;
}

/** Seed the form from an existing affiliate, or from blank defaults. */
export function toAffiliateFormValues(
  affiliate: AdminAffiliate | undefined,
): AffiliateFormValues {
  if (affiliate === undefined) {
    return { name: "", country: "", socialHandle: "", email: "" };
  }

  return {
    name: affiliate.name,
    country: affiliate.country,
    socialHandle: affiliate.socialHandle,
    email: affiliate.email,
  };
}
