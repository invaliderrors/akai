import type { HTMLInputTypeAttribute } from "react";

import { TextField as KitTextField, type TextFieldType } from "./field";

/**
 * A labelled text input — now a COMPATIBILITY ADAPTER over `ui/field.tsx`.
 *
 * WHY THIS FILE STILL EXISTS. Its five callers are the auth screens, which are
 * out of scope for the redesign: sign-in (including the second factor),
 * sign-up, forgot-password and reset-password. Re-pointing them at
 * `ui/field.tsx` would mean editing five files that nothing in this change is
 * supposed to touch — and auth is the one surface where a mistake locks
 * everybody out rather than looking wrong. So the PROP API is kept
 * byte-for-byte and the body is replaced. Zero auth files change; the fields
 * they render come from the one field implementation like everything else.
 *
 * WHAT IS DELIBERATELY PRESERVED, because a caller depends on each of them:
 *   - `id` is REQUIRED and is passed straight through, so `${id}-hint` and
 *     `${id}-error` keep the exact spelling the previous implementation shipped.
 *   - `name` is the submitted field name and the hook every password manager
 *     keys off. Dropping it would not fail a test and would quietly break
 *     autofill on all five screens.
 *   - `inputClassName` reaches the INPUT, not the wrapper — sign-in's TOTP
 *     field passes `input--code`, whose letter-spacing must not reach the label.
 *   - `autoFocus`, used only on the first field of a single-purpose auth form.
 *
 * WHAT CHANGES ON PURPOSE. `aria-invalid` is now present-or-absent rather than
 * always emitted: `aria-invalid="false"` tells a screen reader the field is
 * VALID, which is a claim we cannot make about one the user has not filled in
 * yet. And the field's error is announced (`role="alert"` inside `Field`) where
 * before it was merely shown in red, which on these screens is the difference
 * between hearing why a submission failed and not.
 *
 * NO `"use client"`. `ui/field.tsx` declares it, so the boundary is already
 * drawn one import away; this module holds no state and no browser API of its
 * own. Every caller is a client component regardless.
 */

export interface TextFieldProps {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: HTMLInputTypeAttribute;
  readonly autoComplete?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly hint?: string;
  /** Field-level message. Presence alone drives the invalid styling. */
  readonly error?: string;
  readonly inputMode?: "text" | "email" | "numeric";
  readonly maxLength?: number;
  readonly autoFocus?: boolean;
  /** Extra classes on the input, e.g. the monospaced code variant. */
  readonly inputClassName?: string;
}

/**
 * The types the kit's text control actually paints.
 *
 * Kept as data rather than as a second exported union: this list only exists to
 * narrow the WIDE `HTMLInputTypeAttribute` the old prop type promised, which
 * has to stay wide or the five call sites stop compiling.
 */
const PAINTED_TYPES: readonly TextFieldType[] = [
  "text",
  "email",
  "password",
  "tel",
  "url",
  "search",
  "date",
];

/**
 * Narrows by LOOKUP rather than by assertion — `candidate === type` compares a
 * `TextFieldType` against a `string`, which is legal, so no cast is spent.
 *
 * Anything outside the list falls back to `text`. `checkbox`, `file`, `range`
 * and friends are different controls with different affordances; rendering one
 * inside a text field's box would be a worse answer than the honest fallback.
 * No caller passes one — the auth screens use `text`, `email` and `password`.
 */
function paintedType(type: HTMLInputTypeAttribute): TextFieldType {
  return PAINTED_TYPES.find((candidate) => candidate === type) ?? "text";
}

export function TextField({
  id,
  name,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  required = false,
  disabled = false,
  hint,
  error,
  inputMode,
  maxLength,
  autoFocus = false,
  inputClassName,
}: TextFieldProps) {
  return (
    <KitTextField
      id={id}
      name={name}
      label={label}
      value={value}
      onChange={onChange}
      type={paintedType(type)}
      required={required}
      disabled={disabled}
      autoFocus={autoFocus}
      // The rhythm of the auth forms lived in `.field { margin-bottom: 16px }`,
      // and the kit's Field owns no outer spacing — a stack there is spaced by
      // its container. The auth screens have no such container: sign-up's
      // `.grid-2` sets `gap: 0 14px`, ROW gap zero, precisely because each field
      // used to bring its own. Restoring it here keeps five out-of-scope
      // screens laid out exactly as drawn.
      className="mb-4"
      {...(autoComplete === undefined ? {} : { autoComplete })}
      {...(inputMode === undefined ? {} : { inputMode })}
      {...(maxLength === undefined ? {} : { maxLength })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(inputClassName === undefined ? {} : { inputClassName })}
    />
  );
}
