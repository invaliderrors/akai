"use client";

import type { ReactNode } from "react";
import type { FieldError } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { Field, PopupButton } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/toggle";

/**
 * The account area's form controls — now thin adapters over the shared kit.
 *
 * WHY THIS FILE STILL EXISTS RATHER THAN BEING DELETED. Its five consumers
 * (profile, password, address create/edit, return request) each spell the prop
 * names this file invented, and two of them differ from the kit's in ways that
 * are not cosmetic: `error` and `hint` are declared `string | undefined`, not
 * `string?`. Under `exactOptionalPropertyTypes` those are different types, and
 * every call site passes `error={fieldErrors.city}` — an index read, therefore
 * legitimately `string | undefined` under `noUncheckedIndexedAccess`. A plain
 * `export { TextField } from "@/components/ui/field"` would fail to compile at
 * a dozen call sites. So the seam stays and the bodies delegate.
 *
 * WHY THE ERROR PARAGRAPH IS NOT `Field`'s. The kit's `Field` gives its error
 * `role="alert"`, which is right for a control validated on blur, one message
 * at a time. These forms validate on SUBMIT and report every failing field at
 * once — five simultaneous assertive announcements, which is not five times as
 * useful. The wiring a screen-reader user actually needs is here and unchanged:
 * `aria-invalid` on the control and `aria-describedby` naming the message, so
 * the error is read when focus arrives on the field it belongs to. It is also
 * what `profile-form.test.tsx` pins — `queryByRole("alert")` must stay null
 * when a validation failure is rendered on the field rather than in a banner.
 *
 * `.btn` IS GONE FROM THIS FILE. It was one of the ten consumers blocking the
 * globals.css cleanup; the submit button is now the kit's.
 */

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

/**
 * The control box, mirroring `ui/field.tsx`'s own paint.
 *
 * Written out here rather than imported because the kit's shell is private to
 * that module and exists to host a trailing chip these fields never have. Three
 * class strings is the honest price of keeping the error semantics above; the
 * fields in this file are superseded outright when the account screens move
 * onto grouped rows.
 */
const INPUT_BOX =
  "h-[var(--control-h)] w-full rounded-[var(--r-control)] border-0 bg-[var(--card)] px-[var(--control-px)] text-[var(--font-body)] text-[var(--label)] transition-shadow placeholder:text-[var(--label-tertiary)] focus-visible:outline-none disabled:text-[var(--label-tertiary)]";

type InputTone = "default" | "invalid" | "disabled";

/** The ring is an inset shadow, never a border: a border would shift the box. */
const INPUT_TONE: Readonly<Record<InputTone, string>> = {
  default:
    "shadow-[inset_0_0_0_1px_var(--separator-weak)] hover:shadow-[inset_0_0_0_1px_var(--separator)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--focus-ring)]",
  invalid:
    "shadow-[inset_0_0_0_1px_var(--danger-text),0_0_0_3px_var(--danger-ring)] focus-visible:shadow-[inset_0_0_0_1px_var(--danger-text),0_0_0_4px_var(--focus-ring)]",
  disabled: "bg-[var(--bg-grouped)] shadow-[inset_0_0_0_1px_var(--separator-weak)]",
};

export interface TextFieldProps {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "email" | "tel" | "password";
  readonly autoComplete?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  /**
   * `| undefined` is deliberate and load-bearing. Every consumer passes an
   * index read off the indexed field errors, which is `string | undefined`
   * under `noUncheckedIndexedAccess`; `error?: string` would reject all of them
   * under `exactOptionalPropertyTypes`.
   */
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly maxLength?: number;
}

export function TextField({
  label,
  name,
  value,
  onChange,
  type = "text",
  autoComplete,
  required = false,
  disabled = false,
  error,
  hint,
  maxLength,
}: TextFieldProps) {
  const tone: InputTone = disabled ? "disabled" : error === undefined ? "default" : "invalid";

  return (
    <Field
      label={label}
      required={required}
      disabled={disabled}
      {...(hint === undefined ? {} : { hint })}
    >
      {(control) => {
        // The id is `Field`'s — generated when the caller supplies none, which
        // is every caller here — so the error id has to be derived inside the
        // render prop rather than alongside it.
        const errorId = `${control.id}-error`;
        const hintId = control["aria-describedby"];

        // Error first, then hint: the message that explains a rejection is what
        // the user needs before the advice that would have avoided it. This is
        // the order this file has always used.
        const describedBy = [error === undefined ? null : errorId, hintId ?? null]
          .filter((part): part is string => part !== null)
          .join(" ");

        return (
          <>
            <input
              {...control}
              name={name}
              type={type}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              required={required}
              disabled={disabled}
              className={`${INPUT_BOX} ${INPUT_TONE[tone]}`}
              // Present or absent, never "false": `aria-invalid="false"` claims
              // a field nobody has filled in yet is valid.
              {...(error === undefined ? {} : { "aria-invalid": true as const })}
              {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
              {...(autoComplete === undefined ? {} : { autoComplete })}
              {...(maxLength === undefined ? {} : { maxLength })}
            />
            {error === undefined ? null : (
              <p
                id={errorId}
                className="m-0 text-[11px] leading-[1.35] font-medium text-[var(--danger-text)]"
              >
                {error}
              </p>
            )}
          </>
        );
      }}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// SelectField
// ---------------------------------------------------------------------------

export interface SelectFieldProps<T extends string> {
  readonly label: string;
  readonly name: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly disabled?: boolean;
}

/**
 * Generic over the option union, so `onChange` hands back the exact literal
 * type rather than `string`. That is what lets a caller pass the value straight
 * into a `.strict()` request schema without re-narrowing it — and it is why the
 * generic parameter is threaded through to `PopupButton` rather than the
 * component being re-exported: `<SelectField<Locale> …>` is spelled that way at
 * two call sites.
 */
export function SelectField<T extends string>({
  label,
  name,
  value,
  onChange,
  options,
  disabled = false,
}: SelectFieldProps<T>) {
  return (
    <PopupButton<T>
      label={label}
      name={name}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------
// CheckboxField
// ---------------------------------------------------------------------------

export interface CheckboxFieldProps {
  readonly label: string;
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

export function CheckboxField({
  label,
  name,
  checked,
  onChange,
  disabled = false,
}: CheckboxFieldProps) {
  return (
    <Checkbox
      label={label}
      name={name}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface SubmitButtonProps {
  readonly label: string;
  readonly pendingLabel: string;
  readonly isPending: boolean;
}

/**
 * The one prominent action a customer form gets.
 *
 * `mobile` (44) rather than the kit's `compact` default: this is a
 * customer-facing surface that is read on a phone more often than not, and 28
 * or 36 is under the touch minimum.
 *
 * IT DISABLES WHILE PENDING, unlike the rest of the kit. The kit's argument —
 * disabling the element you just pressed drops focus to `<body>` — is right,
 * and the account screens will take it when they are rebuilt. Changing it here
 * would change the BEHAVIOUR of three forms that this pass is only supposed to
 * restyle, and it is pinned by an existing test. `pending` still supplies the
 * spinner, `aria-busy` and the label swap.
 */
export function SubmitButton({ label, pendingLabel, isPending }: SubmitButtonProps) {
  return (
    <Button
      type="submit"
      variant="prominent"
      size="mobile"
      pending={isPending}
      pendingLabel={pendingLabel}
      disabled={isPending}
    >
      {label}
    </Button>
  );
}

export interface FormActionsProps {
  readonly children: ReactNode;
}

export function FormActions({ children }: FormActionsProps) {
  return <div className="flex flex-wrap items-center gap-3 pt-1">{children}</div>;
}

// ---------------------------------------------------------------------------
// indexFieldErrors
// ---------------------------------------------------------------------------

/**
 * Index the API's field errors by path.
 *
 * The API returns `[{ path, message }]`; a form needs `errors[name]`. Doing the
 * lookup with `.find()` at each of a dozen call sites is O(n) per field and,
 * more importantly, easy to get subtly wrong.
 */
export function indexFieldErrors(
  fields: readonly FieldError[] | null,
): Readonly<Record<string, string>> {
  const indexed: Record<string, string> = {};
  for (const field of fields ?? []) {
    // First error per path wins — later duplicates are usually the same
    // constraint reported again by a nested schema.
    if (!(field.path in indexed)) {
      indexed[field.path] = field.message;
    }
  }
  return indexed;
}
