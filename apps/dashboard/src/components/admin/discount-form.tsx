"use client";

import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import type { CurrencyCode, DiscountType } from "@akai/contracts";
import { minorUnitExponent } from "@akai/money";

import { Button, buttonClassName } from "@/components/ui/button";
import {
  Field,
  MoneyField,
  PopupButton,
  TextField,
  type PopupButtonOption,
} from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Checkbox } from "@/components/ui/toggle";
import { SUPPORTED_CURRENCIES, currencyLabel } from "@/lib/currency";
import Link from "next/link";
import {
  formatMinorAsInput,
  formatPercentageAsInput,
  formatScaledDecimal,
  parseMajorUnitInput,
  parsePercentageInput,
  type ScaledDecimalError,
} from "@/lib/admin/money-input";
import {
  DEFAULT_CURRENCY,
  createDiscountRequestSchema,
  currencyCodeSchema,
  updateDiscountRequestSchema,
  type AdminAffiliate,
  type AdminDiscount,
  type CreateDiscountRequest,
  type UpdateDiscountRequest,
} from "@/lib/admin/schemas";

/**
 * Create/edit form for a discount code.
 *
 * THE ONE FACT THAT GOVERNS THIS FILE: `value` is overloaded by `type`.
 * PERCENTAGE stores BASIS POINTS, FIXED_AMOUNT stores MINOR UNITS, FREE_SHIPPING
 * ignores it. The operator types "12.5" or "5.00" in both cases and cannot see
 * the difference, so the conversion is chosen by `type` and runs through
 * `@/lib/admin/money-input` — the same string-arithmetic parser the product form
 * uses for prices, at a different exponent. There is no `* 100` in this file and
 * there must never be one: a float step here misprices a coupon by a factor of
 * ten on values as ordinary as 1.005.
 *
 * IT VALIDATES AGAINST THE SAME SCHEMAS THE ACTION AND THE API USE
 * (`createDiscountRequestSchema` / `updateDiscountRequestSchema`), not a
 * hand-written mirror of them, so a rule cannot drift between the form and the
 * request. Client-side validation is a COURTESY: the server action re-parses and
 * the API parses again with `.strict()`.
 *
 * ERRORS ARE CODES, NOT MESSAGES. `buildDiscountPayload` is pure and returns a
 * member of a CLOSED union per field; the component maps that union onto
 * `admin.discounts.fieldErrors.*` through a total `Record`, so adding a failure
 * mode without deciding what the operator is told is a compile error. It also
 * keeps the builder testable without an intl provider.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE REDESIGN CHANGED.
 *
 * The three caps-legend blocks are now one settings CARD: three
 * `<fieldset disabled>` groups (kept — one `disabled` per group is what makes
 * the whole form inert while a save is in flight, without a `disabled` prop on
 * fourteen controls), each a two-column grid of `ui/field` controls. The old
 * `Field` from the admin primitives module is gone with the rest of that file.
 *
 * THE FOOTER IS THE REAL CHANGE: the destructive action sits at the LEFT edge,
 * separated from Cancelar/Guardar by the full width of the card and from the
 * form above it by a rule. X-23's inline red "danger zone" panel is gone — a
 * destructive control that is drawn as loudly as it is placed away from the
 * save button reads as a decision, not as a trap next to the thing you meant to
 * press. The form owns the arrangement; the CALLER owns what goes in the slot,
 * because only it knows whether this record can be archived at all.
 *
 * THE DRAWN LABEL-RIGHT 130px COLUMN IS NOT REPRODUCED, deliberately.
 * `ui/field`'s row layout is the phone's grouped-inset row: it drops the box
 * around the control on purpose, and `PopupButton` and `MoneyField` have no row
 * layout at all. Getting labels into a 130px right-aligned column would mean
 * hand-rolling a boxed control shell beside the kit's — a second spelling of the
 * focus ring, the invalid ring and the hover hairline, which is precisely the
 * fork `ui/field` was written to end. Part 2 §field states the rule this follows:
 * "Desktop: label above, 28pt field, hint below."
 * ---------------------------------------------------------------------------
 */

/** Every way a field can be wrong. Closed, and each member has a translation. */
export type DiscountFormError =
  | ScaledDecimalError
  | "REQUIRED"
  | "TOO_LONG"
  | "NOT_A_WHOLE_NUMBER"
  | "NOT_POSITIVE"
  | "PERCENTAGE_TOO_HIGH"
  | "INVALID_CURRENCY"
  | "INVALID_DATE"
  | "END_BEFORE_START"
  | "INVALID";

export type DiscountFieldErrors = Readonly<Record<string, DiscountFormError>>;

/** Form-local state. Every field is a string: that is what an input holds. */
export interface DiscountFormValues {
  readonly code: string;
  readonly type: DiscountType;
  /** MAJOR units ("5.00") or PERCENT ("12.5") as typed. Converted on submit. */
  readonly value: string;
  readonly minimumSubtotal: string;
  /** "" means "any currency", which is how the API spells null here. */
  readonly currency: string;
  readonly maxRedemptions: string;
  readonly maxRedemptionsPerCustomer: string;
  readonly stackable: boolean;
  /** `datetime-local` strings, i.e. LOCAL wall-clock. Converted to UTC on submit. */
  readonly startsAt: string;
  readonly endsAt: string;
  /** "" means unassigned — the API's null. An affiliate id otherwise. */
  readonly affiliateId: string;
}

export type DiscountBuildResult =
  | { readonly ok: true; readonly mode: "create"; readonly value: CreateDiscountRequest }
  | { readonly ok: true; readonly mode: "edit"; readonly value: UpdateDiscountRequest }
  | { readonly ok: false; readonly errors: DiscountFieldErrors };

export interface DiscountFormProps {
  /** Absent when creating. Present when editing, and pins the immutable code. */
  readonly discount?: AdminDiscount;
  /** Receives a payload already parsed by the same schema the API will use. */
  readonly onSubmit: (result: {
    readonly mode: "create";
    readonly value: CreateDiscountRequest;
  } | {
    readonly mode: "edit";
    readonly value: UpdateDiscountRequest;
  }) => Promise<void>;
  /** Rendered above the actions — e.g. a translated API failure from the editor. */
  readonly formError?: string | undefined;
  /**
   * The destructive control, at the footer's LEFT edge.
   *
   * A slot rather than a prop pair, because whether a code can be archived at
   * all is the caller's question: an already-archived one offers nothing here,
   * and a code that does not exist yet has nothing to archive.
   */
  readonly dangerAction?: ReactNode;
  /**
   * Where Cancel goes. An app route.
   *
   * A LINK and not a button: cancelling this form is a navigation (back to the
   * list, or closing the inline panel), so it belongs in the middle-click,
   * open-in-new-tab, works-without-JavaScript half of the product.
   */
  readonly cancelHref?: string;
  /**
   * Every non-archived affiliate, for the "who earns this code" picker.
   *
   * Optional and absent on a failed fetch — same degrade-gracefully contract
   * `product-form.tsx`'s `categories` prop uses: a coupon can still be saved
   * with whatever affiliate it already has, it just cannot be REASSIGNED until
   * the list loads.
   */
  readonly affiliates?: readonly AdminAffiliate[];
}

/**
 * Field-error code → message key, as a TOTAL Record over the closed union.
 *
 * Total on purpose: a new `DiscountFormError` member that nobody has written
 * copy for fails to compile here, rather than rendering a raw code like
 * "NOT_POSITIVE" to an operator.
 */
const FIELD_ERROR_KEYS: Readonly<Record<DiscountFormError, string>> = {
  EMPTY: "fieldErrors.EMPTY",
  NOT_A_NUMBER: "fieldErrors.NOT_A_NUMBER",
  GROUPING_SEPARATOR: "fieldErrors.GROUPING_SEPARATOR",
  NEGATIVE: "fieldErrors.NEGATIVE",
  TOO_MANY_DECIMALS: "fieldErrors.TOO_MANY_DECIMALS",
  TOO_LARGE: "fieldErrors.TOO_LARGE",
  REQUIRED: "fieldErrors.REQUIRED",
  TOO_LONG: "fieldErrors.TOO_LONG",
  NOT_A_WHOLE_NUMBER: "fieldErrors.NOT_A_WHOLE_NUMBER",
  NOT_POSITIVE: "fieldErrors.NOT_POSITIVE",
  PERCENTAGE_TOO_HIGH: "fieldErrors.PERCENTAGE_TOO_HIGH",
  INVALID_CURRENCY: "fieldErrors.INVALID_CURRENCY",
  INVALID_DATE: "fieldErrors.INVALID_DATE",
  END_BEFORE_START: "fieldErrors.END_BEFORE_START",
  INVALID: "fieldErrors.INVALID",
};

const DISCOUNT_TYPES: readonly DiscountType[] = [
  "PERCENTAGE",
  "FIXED_AMOUNT",
  "FREE_SHIPPING",
];

/** The group heading. macOS Title 3's quieter cousin: 11/600, secondary, tracked. */
const LEGEND_CLASS =
  "mb-2 p-0 text-[11px] font-semibold tracking-[0.06em] text-[var(--label-secondary)] uppercase";

/**
 * The schedule inputs are the one control this form draws itself.
 *
 * `TextField`'s `type` union carries `date` but not `datetime-local`, and the
 * time half is the point: an operator schedules a coupon to open at 10:00 on
 * their own calendar and the API stores the UTC instant that is. Dropping to a
 * bare date would silently move every window to midnight. The classes below are
 * the kit's own control paint read off `field.tsx` — same tokens, same inset
 * ring rather than a border, so focus does not shift the box by 2px.
 */
const DATE_CONTROL =
  "h-[var(--control-h)] w-full rounded-[var(--r-control)] border-0 bg-[var(--card)] px-[var(--control-px)] text-[var(--font-body)] text-[var(--label)] shadow-[inset_0_0_0_1px_var(--separator-weak)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--separator)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--focus-ring)] focus-visible:outline-none";

/** The trailing chip inside a control's ring: "%" beside a percentage. */
const SUFFIX_CLASS =
  "flex flex-none items-center border-l border-[var(--separator-weak)] bg-[var(--bg-grouped)] px-[8px] text-[12px] text-[var(--label-secondary)]";

export function DiscountForm({
  discount,
  onSubmit,
  formError,
  dangerAction,
  cancelHref,
  affiliates,
}: DiscountFormProps) {
  const t = useTranslations("admin.discounts");
  const formId = useId();
  const mode = discount === undefined ? "create" : "edit";

  const [values, setValues] = useState<DiscountFormValues>(() =>
    toDiscountFormValues(discount),
  );
  const [errors, setErrors] = useState<DiscountFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  /** Fallback for a rejecting `onSubmit` the parent did not surface itself. */
  const [submitError, setSubmitError] = useState<string | null>(null);

  function patch(next: Partial<DiscountFormValues>): void {
    setValues((current) => ({ ...current, ...next }));
  }

  function messageFor(field: string): string | undefined {
    const code = errors[field];
    return code === undefined ? undefined : t(FIELD_ERROR_KEYS[code]);
  }

  /** Optional props are spread conditionally — `exactOptionalPropertyTypes`. */
  function errorProp(field: string): { readonly error?: string } {
    const message = messageFor(field);
    return message === undefined ? {} : { error: message };
  }

  /** The currency an amount field is entered in. Never null: "" means EUR here. */
  const amountCurrency = resolveCurrency(values.currency) ?? DEFAULT_CURRENCY;

  /**
   * "" first, because a discount with no currency is the common case and the
   * one the API stores as null. The other 84 come from the payment provider's
   * own enum — see `lib/currency` for why the code leads the label and the flag
   * does not.
   *
   * Memoised because `Intl.DisplayNames` is built once per option to make this
   * list, and the form re-renders on every keystroke in it.
   */
  const currencyOptions: readonly PopupButtonOption<string>[] = useMemo(
    () => [
      { value: "", label: t("form.currencyAny") },
      ...SUPPORTED_CURRENCIES.map((code) => ({ value: code, label: currencyLabel(code) })),
    ],
    [t],
  );

  const typeOptions: readonly PopupButtonOption<DiscountType>[] = DISCOUNT_TYPES.map(
    (type) => ({ value: type, label: t(`type.${type}`) }),
  );

  /**
   * "" first — an unassigned code is the common case, and how the API spells
   * it (`affiliateId: null`) here. `name (socialHandle)` disambiguates two
   * affiliates who happen to share a display name; nothing else on this row
   * would.
   */
  const affiliateOptions: readonly PopupButtonOption<string>[] = [
    { value: "", label: t("form.affiliateNone") },
    ...(affiliates ?? []).map((affiliate) => ({
      value: affiliate.id,
      label: `${affiliate.name} (${affiliate.socialHandle})`,
    })),
  ];

  // `formError` outranks the local fallback: the editor's message names the
  // actual failure ("that code is taken"), where this one only says something
  // went wrong.
  const formMessage = formError ?? submitError ?? undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const built = buildDiscountPayload(values, mode);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }

    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Narrowed rather than cast: the two success shapes differ in `value`, and
      // spreading `built` would carry `ok` into the callback's argument.
      await (built.mode === "create"
        ? onSubmit({ mode: "create", value: built.value })
        : onSubmit({ mode: "edit", value: built.value }));
    } catch {
      // CAUGHT, not re-thrown. `handleSubmit` is an async DOM event handler, so a
      // rejection escaping here becomes an unhandled promise rejection: no error
      // boundary sees it, the operator is shown nothing, and the form looks like
      // it saved. The CAUSE is deliberately discarded — it is an API-authored
      // English string, and rendering it is exactly what the closed-enum rule
      // forbids. The editor already showed the translated version.
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
        <legend className={LEGEND_CLASS}>{t("form.sectionCode")}</legend>

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("form.codeLabel")}
            name="code"
            id={`${formId}-code`}
            value={values.code}
            onChange={(next) => patch({ code: next })}
            // Disabled, not merely read-only, and the update schema has no `code`
            // key at all: renaming a live coupon would invalidate every printed
            // card and affiliate link already carrying the old string.
            disabled={mode === "edit"}
            hint={mode === "create" ? t("form.codeHint") : t("form.codeImmutableHint")}
            mono
            // The code is STORED upper-case, so typing "save10" and being shown
            // "save10" is a claim the save then quietly contradicts.
            inputClassName="uppercase"
            {...errorProp("code")}
          />

          <PopupButton
            label={t("form.typeLabel")}
            name="type"
            id={`${formId}-type`}
            value={values.type}
            options={typeOptions}
            // No narrowing needed at this call site: `PopupButton` resolves the
            // DOM's `string` against the options it rendered and hands back the
            // literal, which is the same technique the old `asDiscountType`
            // used and one fewer place to keep the union in step.
            onChange={(next) => patch({ type: next })}
            {...errorProp("type")}
          />

          {/*
            THREE BRANCHES, because `value` means three different things.
            FREE_SHIPPING carries none at all and its box is UNMOUNTED rather
            than disabled — a greyed-out field invites the operator to hunt for
            a value this type does not have. A fixed amount is money, so it gets
            the kit's `MoneyField` (decimal keypad, currency suffix inside the
            ring, one parser). A percentage is not money and must never touch a
            money control: `MoneyField` would read "12,5" at the currency's
            exponent and hand back 1250 CENTS, which is the right integer for
            entirely the wrong reason and the wrong one the moment the currency
            is JPY.
          */}
          {values.type === "FREE_SHIPPING" ? (
            <p className="self-end text-[11px] leading-[1.35] text-[var(--label-secondary)]">
              {t("form.valueFreeShippingHint")}
            </p>
          ) : values.type === "PERCENTAGE" ? (
            <TextField
              label={t("form.valueLabelPercentage")}
              name="value"
              id={`${formId}-value`}
              value={values.value}
              onChange={(next) => patch({ value: next })}
              // `inputMode` rather than `type="number"`: a number input's native
              // spinner and locale coercion fight the string parsing this form
              // depends on, and Safari drops a trailing separator mid-typing.
              // `numeric` and not `decimal` only because `TextFieldProps` does
              // not offer the latter; the parser accepts both separators either
              // way, so this costs a phone keypad and not a validation rule.
              inputMode="numeric"
              hint={t("form.valueHintPercentage")}
              // Inside the ring rather than beside it, so the unit reads as part
              // of the same control the figure is typed into.
              trailing={<span className={SUFFIX_CLASS}>%</span>}
              {...errorProp("value")}
            />
          ) : (
            <MoneyField
              label={t("form.valueLabelAmount", { currency: amountCurrency })}
              name="value"
              id={`${formId}-value`}
              value={values.value}
              currency={amountCurrency}
              // Only `raw` is kept. The parsed `minor` is deliberately dropped:
              // `buildDiscountPayload` is the ONE place this form converts, and
              // a second conversion here would be a second place for the
              // basis-points/minor-units overload to be got wrong.
              onChange={(next) => patch({ value: next.raw })}
              hint={t("form.valueHintAmount")}
              {...errorProp("value")}
            />
          )}
        </div>
      </fieldset>

      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={submitting}>
        <legend className={LEGEND_CLASS}>{t("form.sectionLimits")}</legend>

        <div className="grid gap-3 sm:grid-cols-2">
          {/*
            A PICKER, NOT A CODE INPUT. This was a three-character text field
            hinting "por ejemplo EUR", which asks an operator to know ISO-4217
            from memory and silently accepts "EU", "eur" or "XYZ" — a discount
            scoped to a currency the provider cannot charge in never applies,
            and nothing on this screen would have said so.

            `PopupButton` is a real `<select>`, so the 84 options keep native
            type-ahead on the desktop and the system picker wheel on a phone,
            and the value can only be one the provider accepts.
          */}
          <PopupButton<string>
            label={t("form.currencyLabel")}
            name="currency"
            id={`${formId}-currency`}
            value={values.currency}
            options={currencyOptions}
            onChange={(next) => patch({ currency: next })}
            hint={t("form.currencyHint")}
            {...errorProp("currency")}
          />

          <MoneyField
            label={t("form.minimumSubtotalLabel", { currency: amountCurrency })}
            name="minimumSubtotal"
            id={`${formId}-minimum`}
            value={values.minimumSubtotal}
            currency={amountCurrency}
            onChange={(next) => patch({ minimumSubtotal: next.raw })}
            hint={t("form.minimumSubtotalHint")}
            {...errorProp("minimumSubtotal")}
          />

          <TextField
            label={t("form.maxRedemptionsLabel")}
            name="maxRedemptions"
            id={`${formId}-max`}
            value={values.maxRedemptions}
            onChange={(next) => patch({ maxRedemptions: next })}
            inputMode="numeric"
            hint={t("form.maxRedemptionsHint")}
            {...errorProp("maxRedemptions")}
          />

          <TextField
            label={t("form.maxRedemptionsPerCustomerLabel")}
            name="maxRedemptionsPerCustomer"
            id={`${formId}-max-per-customer`}
            value={values.maxRedemptionsPerCustomer}
            onChange={(next) => patch({ maxRedemptionsPerCustomer: next })}
            inputMode="numeric"
            hint={t("form.maxRedemptionsPerCustomerHint")}
            {...errorProp("maxRedemptionsPerCustomer")}
          />

          <Checkbox
            label={t("form.stackableLabel")}
            name="stackable"
            checked={values.stackable}
            onChange={(checked) => patch({ stackable: checked })}
            className="sm:col-span-2"
          />

          {/*
            Absent, not disabled, when the list failed to load — same reasoning
            `product-form.tsx`'s category picker gives for its own identical
            branch: a save that keeps whatever affiliate the code already has is
            better than one blocked on a fetch this screen does not control.
          */}
          {affiliates === undefined ? null : (
            <PopupButton<string>
              label={t("form.affiliateLabel")}
              name="affiliateId"
              id={`${formId}-affiliate`}
              value={values.affiliateId}
              options={affiliateOptions}
              onChange={(next) => patch({ affiliateId: next })}
              hint={t("form.affiliateHint")}
              className="sm:col-span-2"
            />
          )}
        </div>
      </fieldset>

      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={submitting}>
        <legend className={LEGEND_CLASS}>{t("form.sectionSchedule")}</legend>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("form.startsAtLabel")}
            id={`${formId}-starts`}
            hint={t("form.scheduleHint")}
            {...errorProp("startsAt")}
          >
            {(control) => (
              <input
                {...control}
                name="startsAt"
                type="datetime-local"
                value={values.startsAt}
                onChange={(event) => patch({ startsAt: event.target.value })}
                className={DATE_CONTROL}
              />
            )}
          </Field>

          <Field
            label={t("form.endsAtLabel")}
            id={`${formId}-ends`}
            {...errorProp("endsAt")}
          >
            {(control) => (
              <input
                {...control}
                name="endsAt"
                type="datetime-local"
                value={values.endsAt}
                onChange={(event) => patch({ endsAt: event.target.value })}
                className={DATE_CONTROL}
              />
            )}
          </Field>
        </div>
      </fieldset>

      {/* The id exists whether or not the message does, so the form's
          `aria-describedby` never points at nothing. */}
      <div id={`${formId}-error`}>
        {formMessage === undefined ? null : (
          <Notice tone="danger" placement="inline">
            {formMessage}
          </Notice>
        )}
      </div>

      {/*
        THE DESTRUCTIVE ACTION IS AT THE OPPOSITE END OF THE ROW FROM SAVE, above
        a rule that closes the form. Distance is the affordance here: the two
        controls do irreversible and reversible things, and a misclick between
        neighbours is the failure this arrangement exists to prevent.
      */}
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
 * Money and percentages are converted FIRST, so a value the operator typed as
 * "12,5,0" produces a message about the value field rather than a NaN the schema
 * reports as "expected number, received nan" against a path nobody can map back
 * to a box on the screen. Everything structural is then left to the SAME schema
 * the action and the API parse with.
 */
export function buildDiscountPayload(
  values: DiscountFormValues,
  mode: "create" | "edit",
): DiscountBuildResult {
  const errors: Record<string, DiscountFormError> = {};

  const code = values.code.trim().toUpperCase();
  if (mode === "create") {
    if (code.length === 0) {
      errors["code"] = "REQUIRED";
    } else if (code.length > 64) {
      errors["code"] = "TOO_LONG";
    }
  }

  // "" is not an error: a discount with no currency applies in every currency,
  // which is how the API spells "unrestricted".
  const currencyRaw = values.currency.trim();
  let currency: CurrencyCode | null = null;
  if (currencyRaw.length > 0) {
    const resolved = resolveCurrency(currencyRaw);
    if (resolved === null) {
      errors["currency"] = "INVALID_CURRENCY";
    } else {
      currency = resolved;
    }
  }

  const amountCurrency = currency ?? DEFAULT_CURRENCY;

  // THE OVERLOAD. A percentage becomes basis points, a fixed amount becomes
  // minor units, and free shipping carries no value at all.
  let value = 0;
  if (values.type === "PERCENTAGE") {
    const parsed = parsePercentageInput(values.value);
    if (parsed.ok) {
      value = parsed.value;
    } else {
      // "TOO_LARGE" here always means "above 10000 basis points", so it gets the
      // message that says what the real limit is rather than a generic one.
      errors["value"] =
        parsed.error === "TOO_LARGE" ? "PERCENTAGE_TOO_HIGH" : parsed.error;
    }
  } else if (values.type === "FIXED_AMOUNT") {
    const parsed = parseMajorUnitInput(values.value, amountCurrency);
    if (parsed.ok) {
      value = parsed.value;
    } else {
      errors["value"] = parsed.error;
    }
  }

  const minimumRaw = values.minimumSubtotal.trim();
  let minimumSubtotal: number | null = null;
  if (minimumRaw.length > 0) {
    const parsed = parseMajorUnitInput(minimumRaw, amountCurrency);
    if (parsed.ok) {
      minimumSubtotal = parsed.value;
    } else {
      errors["minimumSubtotal"] = parsed.error;
    }
  }

  const maxRedemptions = readOptionalPositiveInteger(
    values.maxRedemptions,
    "maxRedemptions",
    errors,
  );
  const maxRedemptionsPerCustomer = readOptionalPositiveInteger(
    values.maxRedemptionsPerCustomer,
    "maxRedemptionsPerCustomer",
    errors,
  );

  const startsAt = readOptionalInstant(values.startsAt, "startsAt", errors);
  const endsAt = readOptionalInstant(values.endsAt, "endsAt", errors);

  // A window that closes before it opens can never be redeemed. The API accepts
  // it, so this is a UX guard rather than a mirrored rule — but a coupon nobody
  // can use is always a typo, and catching it here costs one comparison.
  if (
    startsAt !== null &&
    startsAt !== "invalid" &&
    endsAt !== null &&
    endsAt !== "invalid" &&
    endsAt <= startsAt
  ) {
    errors["endsAt"] = "END_BEFORE_START";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const shared = {
    type: values.type,
    value,
    minimumSubtotal,
    currency,
    maxRedemptions,
    maxRedemptionsPerCustomer,
    stackable: values.stackable,
    startsAt: startsAt === "invalid" ? null : startsAt,
    endsAt: endsAt === "invalid" ? null : endsAt,
    // Always sent, never omitted: this is a controlled picker with an explicit
    // "unassigned" option, so a blank selection must CLEAR the field on an
    // edit, not leave a stale affiliate in place.
    affiliateId: values.affiliateId === "" ? null : values.affiliateId,
  };

  // Two explicit branches rather than one ternary: the two schemas have
  // different output types, and a single `parsed` binding would widen `data` to
  // their union — which neither result shape accepts.
  if (mode === "create") {
    const parsed = createDiscountRequestSchema.safeParse({ code, ...shared });
    if (!parsed.success) {
      return { ok: false, errors: collectIssues(parsed.error.issues, errors) };
    }
    return { ok: true, mode: "create", value: parsed.data };
  }

  const parsed = updateDiscountRequestSchema.safeParse(shared);
  if (!parsed.success) {
    return { ok: false, errors: collectIssues(parsed.error.issues, errors) };
  }
  return { ok: true, mode: "edit", value: parsed.data };
}

/**
 * Fold zod issues onto field codes.
 *
 * Everything the operator can get wrong is already checked above, so reaching
 * here means the schema caught something the field checks did not — today only
 * the percentage cap. Each issue becomes a CODE, never zod's own message: that
 * message is English written for a developer.
 */
function collectIssues(
  issues: readonly z.ZodIssue[],
  errors: Record<string, DiscountFormError>,
): DiscountFieldErrors {
  for (const issue of issues) {
    const field = issue.path[0];
    const key = typeof field === "string" ? field : "value";
    // First error per field wins: a stack of messages under one input is noise.
    errors[key] ??= key === "value" ? "PERCENTAGE_TOO_HIGH" : "INVALID";
  }
  return errors;
}

/**
 * Seed the form from an existing discount, or from blank defaults.
 *
 * The value round-trips EXACTLY: `formatPercentageAsInput` and
 * `formatMinorAsInput` are the inverses of the parsers above, so saving an
 * untouched form cannot change a coupon's rate by a basis point.
 */
export function toDiscountFormValues(
  discount: AdminDiscount | undefined,
): DiscountFormValues {
  if (discount === undefined) {
    return {
      code: "",
      type: "PERCENTAGE",
      value: "",
      minimumSubtotal: "",
      currency: "",
      maxRedemptions: "",
      maxRedemptionsPerCustomer: "",
      stackable: false,
      startsAt: "",
      endsAt: "",
      affiliateId: "",
    };
  }

  const currency = discount.currency ?? DEFAULT_CURRENCY;

  return {
    code: discount.code,
    type: discount.type,
    value:
      discount.type === "PERCENTAGE"
        ? formatPercentageAsInput(discount.value)
        : discount.type === "FIXED_AMOUNT"
          ? formatDiscountAmount(discount.value, currency)
          : "",
    minimumSubtotal:
      discount.minimumSubtotal === null
        ? ""
        : formatMinorAsInput(discount.minimumSubtotal, currency),
    currency: discount.currency ?? "",
    maxRedemptions:
      discount.maxRedemptions === null ? "" : String(discount.maxRedemptions),
    maxRedemptionsPerCustomer:
      discount.maxRedemptionsPerCustomer === null
        ? ""
        : String(discount.maxRedemptionsPerCustomer),
    stackable: discount.stackable,
    startsAt: toDateTimeLocal(discount.startsAt),
    endsAt: toDateTimeLocal(discount.endsAt),
    affiliateId: discount.affiliateId ?? "",
  };
}

/**
 * `value` on a FIXED_AMOUNT discount IS minor units, but the column is not
 * branded `Minor` — two thirds of the rows in it hold basis points instead, and
 * branding those would be a lie the brand exists to prevent. So the display
 * conversion goes through the unbranded `formatScaledDecimal` at the currency's
 * exponent, which is the same arithmetic `formatMinorAsInput` performs.
 */
function formatDiscountAmount(amount: number, currency: CurrencyCode): string {
  return formatScaledDecimal(amount, minorUnitExponent(currency));
}

function resolveCurrency(raw: string): CurrencyCode | null {
  const parsed = currencyCodeSchema.safeParse(raw.trim().toUpperCase());
  return parsed.success ? parsed.data : null;
}

/** `null` = empty (legitimate). Records a code and returns null on a bad value. */
function readOptionalPositiveInteger(
  raw: string,
  field: string,
  errors: Record<string, DiscountFormError>,
): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    errors[field] = "NOT_A_WHOLE_NUMBER";
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    errors[field] = "NOT_A_WHOLE_NUMBER";
    return null;
  }
  if (parsed <= 0) {
    // The API's schema is `.positive()`, so 0 is a 400 rather than "unlimited".
    // "Unlimited" is the EMPTY field, and saying so beats a round trip.
    errors[field] = "NOT_POSITIVE";
    return null;
  }
  return parsed;
}

/**
 * Read a `datetime-local` value as a UTC instant.
 *
 * `new Date("2026-08-01T10:00")` is parsed in the browser's LOCAL zone, which is
 * what the operator meant: they typed a wall-clock time on their own calendar.
 * `toISOString()` then normalises it to UTC, which is the only thing the API
 * stores. Returning "invalid" rather than throwing keeps a half-typed date from
 * blowing up the submit handler.
 */
function readOptionalInstant(
  raw: string,
  field: string,
  errors: Record<string, DiscountFormError>,
): string | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    errors[field] = "INVALID_DATE";
    return "invalid";
  }
  return parsed.toISOString();
}

/** UTC instant → the local wall-clock string a `datetime-local` input holds. */
function toDateTimeLocal(iso: string | null): string {
  if (iso === null) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (part: number): string => String(part).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
