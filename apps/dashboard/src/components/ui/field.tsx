"use client";

import { useId, useState, type ReactNode } from "react";

import { parseMajorUnitInput, type MoneyInputError } from "@/lib/admin/money-input";
import type { CurrencyCode, Minor } from "@akai/contracts";

import { Icon } from "./icon";

/**
 * ONE labelled-field wrapper, and the four controls built on it.
 *
 * WHY THIS EXISTS AT ALL. Three near-identical field implementations were
 * shipped before it — `ui/text-field.tsx`, `account/form-field.tsx` and the
 * `Field` in the admin primitives module — and they disagreed about the two things
 * that actually matter. One always emitted `aria-invalid="false"`, one ordered
 * `aria-describedby` as error-then-hint and one as hint-then-error, and only one
 * of the three gave the error `role="alert"`. None of those differences is
 * visible on screen, and all of them change what a screen-reader user hears when
 * a form rejects their input. The wiring — `htmlFor`/`id`, `aria-describedby`
 * naming ONLY ids that were actually rendered, `aria-invalid` present only when
 * invalid — is the entire reason this is a component rather than markup repeated
 * per form.
 *
 * WHY `children` IS A RENDER PROP. `Field` cannot own the a11y contract while
 * also being handed an opaque `ReactNode`: the id it computes has to land on the
 * control, and so do `aria-describedby` and `aria-invalid`. Handing those to the
 * caller as an object they spread makes the contract mechanical — a control that
 * forgets to spread it has no id, which is loud, rather than silently losing its
 * description, which is not.
 *
 * WHY `"use client"`. Every control here holds an `onChange`, and `Field` itself
 * keeps the blur-touched flag behind dynamic validation. The directive also
 * means the render prop never has to cross the server/client boundary, where a
 * function is not serialisable.
 *
 * THE RING IS AN INSET BOX-SHADOW, NEVER A BORDER. A 1px border added on focus
 * changes the control's box by 2px and shifts every neighbour a hair; an inset
 * shadow paints inside the same box, so idle → hover → focus → invalid is four
 * paints and zero reflows.
 */

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

/**
 * Desktop stacks the label over the control; the grouped inset rows on a phone
 * put the label left and the value right in one `--row-h` row (HIG › Entering
 * data). Same wiring, same component — only the box changes.
 */
export type FieldLayout = "stacked" | "row";

/**
 * What `Field` computes and the control MUST spread onto itself.
 *
 * `aria-invalid` is `true` or ABSENT, never `false`: an explicit
 * `aria-invalid="false"` is legal but tells a screen reader to say "valid" about
 * a field the user has not filled in yet, which is a claim we cannot make.
 */
export interface FieldControlProps {
  readonly id: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: true;
}

export interface FieldProps {
  /** Already translated. Never a server-supplied string. */
  readonly label: string;
  readonly children: (control: FieldControlProps) => ReactNode;
  /**
   * Supply it when something outside has to reference the control — otherwise
   * `useId()` covers it, which is what keeps a form from inventing id schemes.
   */
  readonly id?: string;
  readonly hint?: string;
  /** Presence alone drives the invalid paint AND `aria-invalid`. */
  readonly error?: string;
  readonly required?: boolean;
  /** Right-hand side of the hint row. The textarea's character counter. */
  readonly counter?: string;
  /** Still in the a11y tree; only the pixels go away. */
  readonly labelHidden?: boolean;
  readonly disabled?: boolean;
  readonly layout?: FieldLayout;
  readonly className?: string;
}

export function Field({
  label,
  children,
  id: providedId,
  hint,
  error,
  required = false,
  counter,
  labelHidden = false,
  disabled = false,
  layout = "stacked",
  className,
}: FieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;

  // `-hint` / `-error`, matching the spelling `ui/text-field.tsx` already
  // shipped, so no consumer and no test that asserts an id string has to move.
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // The counter lives inside the hint paragraph, so the paragraph — and
  // therefore the id — exists whenever either is present. A counter IS worth
  // describing the field with ("71 of 400" answers "how much room is left?"),
  // and `aria-describedby` is not a live region, so it never interrupts typing.
  const describesHint = hint !== undefined || counter !== undefined;

  // Only ids that actually exist in the DOM may be referenced: a dangling
  // `aria-describedby` is silently ignored by some screen readers and read as
  // an empty string by others.
  const describedBy = [describesHint ? hintId : null, error === undefined ? null : errorId]
    .filter((entry): entry is string => entry !== null)
    .join(" ");

  const control: FieldControlProps = {
    id,
    ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };

  const isRow = layout === "row";
  // In a grouped row the label owns column one, so everything else has to be
  // pinned to column two or the hint would slide under the label.
  const secondColumn = isRow ? " col-start-2" : "";

  return (
    <div
      className={`${
        isRow
          ? "grid min-h-[var(--row-h)] grid-cols-[minmax(88px,38%)_1fr] items-center gap-x-3 gap-y-[4px] py-[6px]"
          : "grid gap-[5px]"
      }${className === undefined ? "" : ` ${className}`}`}
    >
      <label
        htmlFor={id}
        className={
          labelHidden
            ? "sr-only"
            : `text-[var(--font-body)] font-medium ${
                disabled ? "text-[var(--label-tertiary)]" : "text-[var(--label)]"
              }`
        }
      >
        {label}
        {required ? (
          // Trailing and aria-hidden: the asterisk is a visual shorthand whose
          // meaning is stated once at the top of the form. Announcing "asterisk"
          // after every label name is noise, and `required` on the control is
          // what actually tells assistive tech the field is obligatory.
          <span aria-hidden="true" className="text-[var(--danger-text)]">
            {" *"}
          </span>
        ) : null}
      </label>

      {children(control)}

      {describesHint ? (
        <p
          id={hintId}
          // Flex with `justify-between` so the counter sits at the far edge of
          // the same row as the hint rather than needing a second line.
          className={`m-0 flex justify-between gap-3 text-[11px] leading-[1.35] text-[var(--label-secondary)]${secondColumn}`}
        >
          <span>{hint}</span>
          {counter === undefined ? null : (
            <span className="flex-none tabular-nums">{counter}</span>
          )}
        </p>
      ) : null}

      {error === undefined ? null : (
        <p
          id={errorId}
          // `role="alert"` on failures only — a confirmation would be
          // `role="status"`. The error is announced the moment it appears, which
          // is the whole point of validating on blur rather than on submit.
          role="alert"
          className={`m-0 flex gap-[5px] text-[11px] leading-[1.35] font-medium text-[var(--danger-text)]${secondColumn}`}
        >
          <Icon name="circle-alert" size={12} className="mt-[2px]" />
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The shared control shell
// ---------------------------------------------------------------------------

/**
 * The paint states of a control's box. Named rather than composed ad hoc,
 * because a `Record` over the union means adding a state forces every shell to
 * be given one.
 */
type ControlTone = "default" | "invalid" | "disabled" | "readOnly";

/**
 * Hairlines come from `--separator-weak` (idle) and `--separator` (hover). The
 * artboard draws 0.12 and 0.22 black; the token layer declares 0.12 and 0.29 of
 * the same near-black, and taking the nearest declared token over a fourth
 * bespoke alpha is the trade this kit makes everywhere.
 *
 * The invalid rest state carries `--danger-ring` as a solid 3px halo where the
 * artboard draws a 20%-alpha red — the token is the flattened equivalent over
 * white, and it means no raw colour lands in a component.
 */
const SHELL_TONE: Readonly<Record<ControlTone, string>> = {
  default:
    "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--separator-weak)] hover:shadow-[inset_0_0_0_1px_var(--separator)] has-[:focus-visible]:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--focus-ring)]",
  invalid:
    "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--danger-text),0_0_0_3px_var(--danger-ring)] has-[:focus-visible]:shadow-[inset_0_0_0_1px_var(--danger-text),0_0_0_4px_var(--focus-ring)]",
  disabled: "bg-[var(--bg-grouped)] shadow-[inset_0_0_0_1px_var(--separator-weak)]",
  // Read-only static text: a grouped fill and no ring at all, because there is
  // nothing here to operate — the ring is what says "you can type in this".
  readOnly: "bg-[var(--bg-grouped)]",
};

function shellTone(options: {
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly invalid: boolean;
}): ControlTone {
  if (options.disabled) {
    return "disabled";
  }
  if (options.readOnly) {
    return "readOnly";
  }
  return options.invalid ? "invalid" : "default";
}

interface ControlShellProps {
  readonly tone: ControlTone;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * The box that carries the ring, so a trailing chip (a currency suffix, a copy
 * button, a "Change" button) sits INSIDE the same outline as the input rather
 * than beside it. `has-[:focus-visible]` puts the focus paint on the shell
 * while the inner control keeps `focus-visible:outline-none` — one ring, drawn
 * once, around the whole control.
 */
function ControlShell({ tone, children, className }: ControlShellProps) {
  return (
    <div
      className={`flex items-stretch overflow-hidden rounded-[var(--r-control)] transition-shadow ${
        SHELL_TONE[tone]
      }${className === undefined ? "" : ` ${className}`}`}
    >
      {children}
    </div>
  );
}

/** Shared by every text-entry control: borderless, the shell owns the box. */
const BARE_INPUT =
  "min-w-0 flex-1 border-0 bg-transparent text-[var(--font-body)] text-[var(--label)] focus-visible:outline-none placeholder:text-[var(--label-tertiary)] disabled:text-[var(--label-tertiary)] read-only:text-[var(--label-secondary)]";

/**
 * Validation that appears on BLUR and clears the instant the rule passes.
 *
 * The derived error is recomputed from the current value on every render, so
 * the "clears" half needs no effect and cannot go stale: the moment `validate`
 * returns `undefined` the message is gone, mid-keystroke. Validating before the
 * first blur is the behaviour everyone hates — it tells you "too short" while
 * you are still typing the second character.
 *
 * A caller-supplied `error` always wins: that one is the server's verdict, and
 * a client rule that happens to pass must not erase it.
 */
function useBlurValidation(
  value: string,
  error: string | undefined,
  validate: ((value: string) => string | undefined) | undefined,
): { readonly error: string | undefined; readonly onBlur: () => void } {
  const [touched, setTouched] = useState(false);
  const derived = touched && validate !== undefined ? validate(value) : undefined;

  return {
    error: error ?? derived,
    onBlur: () => {
      setTouched(true);
    },
  };
}

/** Optional props are spread conditionally — `exactOptionalPropertyTypes`. */
function optionalError(error: string | undefined): { readonly error?: string } {
  return error === undefined ? {} : { error };
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

/**
 * `date` is in the union on purpose: the artboard's segment-editing date field
 * with its ISO value on the wire is exactly what the platform control already
 * does, localised to the user's own format, keyboard-operable, and free.
 */
export type TextFieldType =
  | "text"
  | "email"
  | "password"
  | "tel"
  | "url"
  | "search"
  | "date";

export interface TextFieldProps {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly id?: string;
  readonly type?: TextFieldType;
  readonly placeholder?: string;
  readonly autoComplete?: string;
  readonly inputMode?:
    | "text"
    | "email"
    // A quantity that can carry a fraction — a size of 2.5 g, the same
    // keyboard `MoneyField` already asks for below. "numeric" offers no
    // decimal separator on iOS, so it is the wrong keyboard for a number
    // that is allowed one.
    | "decimal"
    | "numeric"
    | "tel"
    | "url"
    | "search";
  readonly maxLength?: number;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly autoFocus?: boolean;
  readonly hint?: string;
  readonly error?: string;
  /** Client-side rule. Runs from the first blur onward. Returns a translated message. */
  readonly validate?: (value: string) => string | undefined;
  /** Identifiers only — order numbers, SKUs, tracking numbers, request ids. NEVER money. */
  readonly mono?: boolean;
  /** Sits inside the ring: a copy button on a read-only value, "Change" on a file. */
  readonly trailing?: ReactNode;
  readonly labelHidden?: boolean;
  readonly layout?: FieldLayout;
  readonly className?: string;
  /**
   * Extra classes on the INPUT rather than on the wrapper.
   *
   * The one escape hatch, and it exists for one drawn control: the sign-in
   * screen's TOTP field, which is `.input--code` — a 20px monospaced,
   * centred, wide-tracked box that reads as six separate digits. `mono` cannot
   * express it (that is 12px, left-aligned, for identifiers in a table), and
   * `className` lands on the Field wrapper, where a letter-spacing rule would
   * reach the label as well as the box.
   */
  readonly inputClassName?: string;
}

export function TextField({
  label,
  name,
  value,
  onChange,
  id,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
  maxLength,
  required = false,
  disabled = false,
  readOnly = false,
  autoFocus = false,
  hint,
  error,
  validate,
  mono = false,
  trailing,
  labelHidden = false,
  layout = "stacked",
  className,
  inputClassName,
}: TextFieldProps) {
  const validation = useBlurValidation(value, error, validate);
  const isRow = layout === "row";

  const input = (control: FieldControlProps) => (
    <input
      {...control}
      name={name}
      type={type}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onBlur={validation.onBlur}
      required={required}
      disabled={disabled}
      readOnly={readOnly}
      // Focusing the first field of a single-purpose form is what the user came
      // to do. Used ONLY there — autofocus partway down a content page steals
      // focus from a screen reader mid-sentence.
      autoFocus={autoFocus}
      className={`${BARE_INPUT} ${
        isRow ? "px-0 text-left" : "px-[var(--control-px)]"
      }${mono ? " font-mono text-[12px]" : ""}${
        inputClassName === undefined ? "" : ` ${inputClassName}`
      }`}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(autoComplete === undefined ? {} : { autoComplete })}
      {...(inputMode === undefined ? {} : { inputMode })}
      {...(maxLength === undefined ? {} : { maxLength })}
    />
  );

  return (
    <Field
      label={label}
      required={required}
      disabled={disabled}
      labelHidden={labelHidden}
      layout={layout}
      {...(id === undefined ? {} : { id })}
      {...(hint === undefined ? {} : { hint })}
      {...optionalError(validation.error)}
      {...(className === undefined ? {} : { className })}
    >
      {(control) =>
        // A grouped inset row draws its own hairlines and fill; a second ring
        // inside it would read as a box inside a box.
        isRow ? (
          input(control)
        ) : (
          <ControlShell
            tone={shellTone({
              disabled,
              readOnly,
              invalid: validation.error !== undefined,
            })}
            className="h-[var(--control-h)]"
          >
            {input(control)}
            {trailing === undefined ? null : (
              <span className="flex flex-none items-center pr-[4px] pl-[4px]">{trailing}</span>
            )}
          </ControlShell>
        )
      }
    </Field>
  );
}

// ---------------------------------------------------------------------------
// TextArea
// ---------------------------------------------------------------------------

export interface TextAreaProps {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly id?: string;
  readonly rows?: number;
  /** Drives the counter as well as the browser's own ceiling. */
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly validate?: (value: string) => string | undefined;
  readonly labelHidden?: boolean;
  readonly className?: string;
}

export function TextArea({
  label,
  name,
  value,
  onChange,
  id,
  rows = 3,
  maxLength,
  placeholder,
  required = false,
  disabled = false,
  readOnly = false,
  hint,
  error,
  validate,
  labelHidden = false,
  className,
}: TextAreaProps) {
  const validation = useBlurValidation(value, error, validate);

  // `value.length`, not `[...value].length`: the counter has to agree with what
  // `maxLength` actually enforces, and the browser counts UTF-16 code units. A
  // counter that reads 3/400 while the field refuses a fourth emoji is worse
  // than one that admits the platform's own arithmetic.
  const counter = maxLength === undefined ? undefined : `${value.length} / ${maxLength}`;

  return (
    <Field
      label={label}
      required={required}
      disabled={disabled}
      labelHidden={labelHidden}
      {...(id === undefined ? {} : { id })}
      {...(hint === undefined ? {} : { hint })}
      {...(counter === undefined ? {} : { counter })}
      {...optionalError(validation.error)}
      {...(className === undefined ? {} : { className })}
    >
      {(control) => (
        <ControlShell
          tone={shellTone({
            disabled,
            readOnly,
            invalid: validation.error !== undefined,
          })}
        >
          <textarea
            {...control}
            name={name}
            value={value}
            rows={rows}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onBlur={validation.onBlur}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            className={`${BARE_INPUT} resize-y px-[var(--control-px)] py-[6px] leading-[1.45]`}
            {...(placeholder === undefined ? {} : { placeholder })}
            {...(maxLength === undefined ? {} : { maxLength })}
          />
        </ControlShell>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// MoneyField
// ---------------------------------------------------------------------------

/**
 * What a money keystroke produces.
 *
 * BOTH halves, deliberately. The control is held on `raw` because a half-typed
 * amount ("29," on the way to "29,90") is not a `Minor` and a component
 * controlled on minor units cannot represent it — the caret would jump on every
 * separator. `minor` is `null` for exactly that window, so a caller can disable
 * Save without re-parsing, and there is still only ONE parser in the dashboard.
 */
export interface MoneyFieldValue {
  readonly raw: string;
  /** `null` while the text is not a complete, valid amount. */
  readonly minor: Minor | null;
}

export interface MoneyFieldProps {
  readonly label: string;
  readonly name: string;
  /** Major-unit text as typed. Seed it with `formatMinorAsInput`. */
  readonly value: string;
  readonly currency: CurrencyCode;
  readonly onChange: (next: MoneyFieldValue) => void;
  readonly id?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly hint?: string;
  readonly error?: string;
  /**
   * Translated message per failure code. A TOTAL `Record` over the closed union,
   * so a new parser failure mode is a compile error here rather than a blank
   * message beside a mispriced product.
   */
  readonly errorMessages?: Readonly<Record<MoneyInputError, string>>;
  readonly placeholder?: string;
  readonly labelHidden?: boolean;
  readonly className?: string;
}

export function MoneyField({
  label,
  name,
  value,
  currency,
  onChange,
  id,
  required = false,
  disabled = false,
  readOnly = false,
  hint,
  error,
  errorMessages,
  placeholder,
  labelHidden = false,
  className,
}: MoneyFieldProps) {
  const validate =
    errorMessages === undefined
      ? undefined
      : (raw: string): string | undefined => {
          // An optional amount left blank is not a failure. Only a REQUIRED
          // field gets to complain about emptiness, and it complains with the
          // parser's own EMPTY code so one message set covers both.
          if (raw.trim() === "" && !required) {
            return undefined;
          }
          const parsed = parseMajorUnitInput(raw, currency);
          return parsed.ok ? undefined : errorMessages[parsed.error];
        };

  const validation = useBlurValidation(value, error, validate);

  return (
    <Field
      label={label}
      required={required}
      disabled={disabled}
      labelHidden={labelHidden}
      {...(id === undefined ? {} : { id })}
      {...(hint === undefined ? {} : { hint })}
      {...optionalError(validation.error)}
      {...(className === undefined ? {} : { className })}
    >
      {(control) => (
        <ControlShell
          tone={shellTone({
            disabled,
            readOnly,
            invalid: validation.error !== undefined,
          })}
          className="h-[var(--control-h)]"
        >
          <input
            {...control}
            name={name}
            type="text"
            value={value}
            // `decimal`, not `numeric`: the phone keypad has to carry a decimal
            // separator or a Spanish operator cannot type 29,90 at all.
            inputMode="decimal"
            onChange={(event) => {
              const raw = event.target.value;
              const parsed = parseMajorUnitInput(raw, currency);
              onChange({ raw, minor: parsed.ok ? parsed.value : null });
            }}
            onBlur={validation.onBlur}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            // Right-aligned tabular figures in the SANS face. Money is never
            // mono here: mono is reserved for identifiers, and `tabular-nums`
            // already gives the column alignment that mono was standing in for.
            className={`${BARE_INPUT} px-[var(--control-px)] text-right tabular-nums`}
            {...(placeholder === undefined ? {} : { placeholder })}
          />
          <span
            // Not aria-hidden: the currency is part of what the operator is
            // being asked for, and a browse-mode reader should reach it. A field
            // whose label already names the currency can pass `labelHidden`
            // rules on the label instead.
            className="flex flex-none items-center border-l border-[var(--separator-weak)] bg-[var(--bg-grouped)] px-[8px] text-[12px] text-[var(--label-secondary)]"
          >
            {currency}
          </span>
        </ControlShell>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// PopupButton
// ---------------------------------------------------------------------------

/** 28pt in a form, 22pt inline in a toolbar or a table row. */
export type PopupButtonSize = "regular" | "small";

export interface PopupButtonOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface PopupButtonProps<T extends string> {
  readonly label: string;
  readonly name: string;
  readonly value: T;
  readonly options: readonly PopupButtonOption<T>[];
  readonly onChange: (value: T) => void;
  readonly id?: string;
  readonly size?: PopupButtonSize;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly className?: string;
}

/**
 * The macOS pop-up button: a REAL `<select>` under `appearance:none`, with the
 * accent chevron chip drawn on top.
 *
 * Not a listbox rebuilt in React. The native control brings type-ahead, the
 * platform's own keyboard model, and — on a phone — the system picker wheel,
 * none of which a div reimplements correctly. The chip is `pointer-events:none`
 * so every click still lands on the select underneath it.
 *
 * Generic over the option union, so `onChange` hands back the exact literal
 * type rather than `string` — which is what lets a caller pass the value
 * straight into a `.strict()` request schema without re-narrowing it.
 */
export function PopupButton<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  id,
  size = "regular",
  required = false,
  disabled = false,
  hint,
  error,
  labelHidden = false,
  className,
}: PopupButtonProps<T>) {
  const isSmall = size === "small";

  const box =
    error !== undefined
      ? "shadow-[0_0_0_1px_var(--danger-text),0_0_0_3px_var(--danger-ring)]"
      : disabled
        ? "bg-[var(--bg-grouped)] text-[var(--label-tertiary)] shadow-[var(--e-0)]"
        : "shadow-[var(--ring-control)] hover:shadow-[0_0_0_1px_var(--separator),0_1px_1px_var(--separator-weak)]";

  return (
    <Field
      label={label}
      required={required}
      disabled={disabled}
      labelHidden={labelHidden}
      {...(id === undefined ? {} : { id })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(className === undefined ? {} : { className })}
    >
      {(control) => (
        <div className="relative w-full">
          <select
            {...control}
            name={name}
            value={value}
            required={required}
            disabled={disabled}
            onChange={(event) => {
              // The DOM hands back `string`. Rather than cast it to `T`, look
              // the value up among the options we rendered — the only values
              // this control can actually produce.
              const selected = options.find((option) => option.value === event.target.value);
              if (selected !== undefined) {
                onChange(selected.value);
              }
            }}
            className={`w-full appearance-none rounded-[var(--r-control)] border-0 bg-[var(--card)] text-[var(--label)] transition-shadow focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--focus-ring)] ${
              isSmall
                ? "h-[22px] pr-[24px] pl-[8px] text-[12px]"
                : "h-[var(--control-h)] pr-[28px] pl-[var(--control-px)] text-[var(--font-body)]"
            } ${box}`}
          >
            {options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                {...(option.disabled === true ? { disabled: true } : {})}
              >
                {option.label}
              </option>
            ))}
          </select>
          <span
            aria-hidden="true"
            // Vertically centred rather than pinned 4px from the top: the same
            // chip has to sit correctly in a 22, a 28 and a comfortable 44.
            className={`pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center justify-center ${
              disabled ? "bg-[var(--accent-disabled)]" : "bg-[var(--accent)]"
            } ${
              isSmall
                ? "right-[3px] h-[16px] w-[16px] rounded-[4px]"
                : "right-[4px] h-[20px] w-[20px] rounded-[5px]"
            }`}
          >
            <Icon
              name="chevrons-up-down"
              size={isSmall ? 10 : 12}
              className="text-[var(--label-on-accent)]"
            />
          </span>
        </div>
      )}
    </Field>
  );
}
