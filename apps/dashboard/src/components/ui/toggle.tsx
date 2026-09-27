"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Icon } from "./icon";

/**
 * The three binary controls: checkbox, radio group, switch.
 *
 * WHY ONE FILE. They are the same 14–15pt glyph, the same accent fill and the
 * same 3px focus ring drawn three ways, and the failure mode when they drift is
 * that a checked checkbox and a selected radio are two subtly different blues on
 * the same screen. Splitting them into three files splits that one decision into
 * three places.
 *
 * WHY A HIDDEN NATIVE INPUT PLUS A PAINTED SPAN, and not `appearance:none` on
 * the input itself. The paint has to carry a check glyph, a mixed bar and a
 * sliding knob; the platform gives no hook for any of them beyond a background
 * image. The input stays real — real role, real `:checked`, real keyboard model,
 * real form participation — and `sr-only` keeps it focusable, so `:focus-visible`
 * on it still drives the ring on the span beside it through `peer-`.
 *
 * WHY THE GLYPHS BRANCH IN JSX RATHER THAN IN CSS. `peer-checked:` compiles to a
 * SIBLING combinator, so it cannot reach a child of the painted span. These
 * controls are all controlled components, so the state is already in hand at
 * render time — branching in JSX is both simpler and the only thing that works.
 * Only `:focus-visible` and `:disabled`, which CSS alone knows, stay as variants.
 */

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

/**
 * A row that stays operable with a thumb.
 *
 * The glyph is 14pt at both densities — it is a mark you read, not a target you
 * aim at — but the whole label is the hit area, so `--row-h` gives it 28pt on a
 * desktop list and 44pt on a phone without changing the drawn control.
 */
const TOGGLE_ROW =
  "inline-flex min-h-[var(--row-h)] items-center gap-[8px] text-[var(--font-body)]";

/**
 * Idle, marked and disabled, each carrying its own focus paint.
 *
 * The focus ring is written per state rather than as one `peer-focus-visible:`
 * utility because a single shadow utility REPLACES the hairline it overrides —
 * a focused empty checkbox would lose its outline and show only the halo.
 */
const CHECKBOX_BOX: Readonly<Record<"idle" | "marked" | "disabled", string>> = {
  idle: "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--separator),0_1px_1px_var(--separator-weak)] peer-focus-visible:shadow-[inset_0_0_0_1px_var(--separator),0_0_0_3px_var(--focus-ring)]",
  marked:
    "bg-[var(--accent)] shadow-[inset_0_1px_0_var(--glass-fill)] peer-focus-visible:shadow-[inset_0_1px_0_var(--glass-fill),0_0_0_3px_var(--focus-ring)]",
  disabled: "bg-[var(--bg-grouped)] shadow-[inset_0_0_0_1px_var(--separator-weak)]",
};

export interface CheckboxProps {
  /** Already translated. Never a server-supplied string. */
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly name?: string;
  readonly id?: string;
  /**
   * The select-all state: some children checked, some not. Overrides the drawn
   * glyph but NOT `checked`, which still says what clicking will now do.
   */
  readonly indeterminate?: boolean;
  readonly disabled?: boolean;
  /** Still in the a11y tree; only the pixels go away. */
  readonly labelHidden?: boolean;
  readonly className?: string;
}

export function Checkbox({
  label,
  checked,
  onChange,
  name,
  id: providedId,
  indeterminate = false,
  disabled = false,
  labelHidden = false,
  className,
}: CheckboxProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const inputRef = useRef<HTMLInputElement | null>(null);

  // `indeterminate` is an IDL property with NO matching HTML attribute, so React
  // cannot set it declaratively and it has to be written to the node after every
  // render that changes it. Forgetting this is why half-checked select-alls so
  // often render as plain unchecked boxes.
  useEffect(() => {
    const node = inputRef.current;
    if (node !== null) {
      node.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const state = disabled ? "disabled" : indeterminate || checked ? "marked" : "idle";

  return (
    <label
      htmlFor={id}
      className={`${TOGGLE_ROW} ${
        disabled ? "text-[var(--label-tertiary)]" : "text-[var(--label)]"
      }${className === undefined ? "" : ` ${className}`}`}
    >
      <input
        ref={inputRef}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="peer sr-only"
        // Stated explicitly as well as set on the node: the IDL property maps to
        // "mixed" in a real browser's accessibility tree, but nothing outside a
        // browser computes that, so the attribute is what makes the state
        // assertable — and it is the documented way to say "mixed" regardless.
        {...(indeterminate ? { "aria-checked": "mixed" as const } : {})}
        {...(name === undefined ? {} : { name })}
      />
      <span
        aria-hidden="true"
        className={`flex h-[14px] w-[14px] flex-none items-center justify-center rounded-[var(--r-check)] transition-shadow ${CHECKBOX_BOX[state]}`}
      >
        {indeterminate ? (
          // The mixed glyph is a bar, not a dash character — the same 8×1.5 mark
          // the table's select-all draws, so one state has one shape.
          <span className="block h-[1.5px] w-[8px] rounded-full bg-[var(--label-on-accent)]" />
        ) : checked ? (
          <Icon name="check" size={11} className="text-[var(--label-on-accent)]" />
        ) : null}
      </span>
      <span className={labelHidden ? "sr-only" : undefined}>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// RadioGroup
// ---------------------------------------------------------------------------

const RADIO_BOX: Readonly<Record<"idle" | "marked" | "disabled", string>> = {
  idle: "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--separator)] peer-focus-visible:shadow-[inset_0_0_0_1px_var(--separator),0_0_0_3px_var(--focus-ring)]",
  marked:
    "bg-[var(--accent)] peer-focus-visible:shadow-[0_0_0_3px_var(--focus-ring)]",
  disabled: "bg-[var(--bg-grouped)] shadow-[inset_0_0_0_1px_var(--separator-weak)]",
};

export interface RadioOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface RadioGroupProps<T extends string> {
  /** The group's accessible name, rendered as a real `<legend>`. */
  readonly legend: string;
  readonly name: string;
  /** `null` until the customer picks — a radio group with no answer yet. */
  readonly value: T | null;
  readonly options: readonly RadioOption<T>[];
  readonly onChange: (value: T) => void;
  readonly hint?: string;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly legendHidden?: boolean;
  readonly className?: string;
}

/**
 * A real `<fieldset>` with a real `<legend>`.
 *
 * The legend is what names the group, and nothing else does it as well: an
 * `aria-label` on a div is invisible to a sighted user, and a heading above a
 * bare list of radios is not associated with them at all — a screen-reader user
 * arriving at the third option hears "Wrong order, radio, 2 of 3" and never
 * learns the question was "Reason for return".
 *
 * `aria-invalid` is deliberately NOT set on the fieldset: it is not a global
 * attribute and `role="group"` does not support it, so it would be ignored at
 * best. The error carries `role="alert"`, which announces on appearance, and
 * `aria-describedby` keeps it reachable afterwards.
 */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  hint,
  error,
  disabled = false,
  legendHidden = false,
  className,
}: RadioGroupProps<T>) {
  const groupId = useId();
  const hintId = `${groupId}-hint`;
  const errorId = `${groupId}-error`;

  // Same rule as `Field`: name only ids that were actually rendered. Written out
  // here rather than shared, because a fieldset is named by its legend and has
  // no `htmlFor`/`id` pair for `Field` to own.
  const describedBy = [
    hint === undefined ? null : hintId,
    error === undefined ? null : errorId,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" ");

  return (
    <fieldset
      className={`m-0 grid gap-[8px] border-0 p-0${
        className === undefined ? "" : ` ${className}`
      }`}
      disabled={disabled}
      {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
    >
      <legend
        className={
          legendHidden
            ? "sr-only"
            : `p-0 text-[var(--font-body)] font-medium ${
                disabled ? "text-[var(--label-tertiary)]" : "text-[var(--label)]"
              }`
        }
      >
        {legend}
      </legend>

      {options.map((option) => {
        const optionDisabled = disabled || option.disabled === true;
        const selected = option.value === value;
        const state = optionDisabled ? "disabled" : selected ? "marked" : "idle";

        return (
          <label
            key={option.value}
            className={`${TOGGLE_ROW} ${
              optionDisabled ? "text-[var(--label-tertiary)]" : "text-[var(--label)]"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              disabled={optionDisabled}
              onChange={() => {
                onChange(option.value);
              }}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className={`flex h-[14px] w-[14px] flex-none items-center justify-center rounded-[var(--r-pill)] transition-shadow ${RADIO_BOX[state]}`}
            >
              {selected ? (
                <span className="block h-[5px] w-[5px] rounded-[var(--r-pill)] bg-[var(--label-on-accent)]" />
              ) : null}
            </span>
            {option.label}
          </label>
        );
      })}

      {hint === undefined ? null : (
        <p id={hintId} className="m-0 text-[11px] leading-[1.35] text-[var(--label-secondary)]">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p
          id={errorId}
          role="alert"
          className="m-0 flex gap-[5px] text-[11px] leading-[1.35] font-medium text-[var(--danger-text)]"
        >
          <Icon name="circle-alert" size={12} className="mt-[2px]" />
          {error}
        </p>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export interface SwitchProps {
  /** Already translated. Never a server-supplied string. */
  readonly label: string;
  readonly checked: boolean;
  /**
   * Commits immediately. Resolve when the change is DURABLE; reject and the
   * control reverts and says so.
   */
  readonly onChange: (checked: boolean) => Promise<void>;
  /**
   * Shown, translated, when `onChange` rejects. REQUIRED, and that is the point:
   * a switch that fails to save and says nothing has silently thrown away the
   * operator's decision, and they will not find out until the consequence does
   * it for them.
   */
  readonly errorMessage: string;
  readonly name?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly labelHidden?: boolean;
  readonly className?: string;
  /** Trailing slot on the row — a badge, a count. */
  readonly children?: ReactNode;
}

/**
 * A switch commits on flip. There is no Save button behind it, which is exactly
 * what makes it dangerous.
 *
 * Three consequences fall out of that, and all three are the component's job
 * rather than every caller's:
 *
 *   - it shows the new position IMMEDIATELY, because a control that waits for a
 *     round trip before moving feels broken;
 *   - it refuses a second flip while the first is in the air, or a fast double
 *     tap races two writes and the last one to land wins arbitrarily;
 *   - it REVERTS on rejection and announces the failure, because the alternative
 *     is a switch that reads "on" over a server that says "off".
 *
 * `aria-disabled` rather than `disabled` for the in-flight lock: a real
 * `disabled` attribute makes the browser blur the element, so a keyboard user
 * who just pressed Space is dumped back to the top of the document for the
 * 200ms the request takes. `aria-disabled` keeps focus and the announcement,
 * and the handler guards the actual write.
 */
export function Switch({
  label,
  checked,
  onChange,
  errorMessage,
  name,
  id: providedId,
  disabled = false,
  hint,
  labelHidden = false,
  className,
  children,
}: SwitchProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  const shown = optimistic ?? checked;
  const locked = disabled || pending;

  const describedBy = [
    hint === undefined ? null : hintId,
    failed ? errorId : null,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" ");

  async function commit(next: boolean): Promise<void> {
    setFailed(false);
    setOptimistic(next);
    setPending(true);
    try {
      await onChange(next);
    } catch {
      // The reason is the caller's to phrase — an `ApiError.message` is English
      // written for a log, and rendering it to an operator is the thing the
      // house rules forbid.
      setFailed(true);
    } finally {
      // The optimistic value is dropped either way, so the switch falls back to
      // the value its caller holds. On success the caller has already updated
      // it and nothing moves; if it has NOT, the switch snapping back is the
      // correct, loud outcome rather than a lie about saved state.
      setOptimistic(null);
      setPending(false);
    }
  }

  return (
    <div className={`grid gap-[4px]${className === undefined ? "" : ` ${className}`}`}>
      <label
        htmlFor={id}
        className={`${TOGGLE_ROW} ${
          disabled ? "text-[var(--label-tertiary)]" : "text-[var(--label)]"
        }${pending ? " cursor-progress" : ""}`}
      >
        <input
          id={id}
          type="checkbox"
          // `role="switch"` is what turns "checkbox, checked" into "switch, on".
          // The control is a checkbox underneath because that is the element
          // that carries checkedness, form participation and Space-to-toggle.
          role="switch"
          checked={shown}
          disabled={disabled}
          aria-disabled={locked}
          aria-busy={pending}
          onChange={(event) => {
            if (locked) {
              return;
            }
            void commit(event.target.checked);
          }}
          className="peer sr-only"
          {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
          {...(name === undefined ? {} : { name })}
        />
        <span
          aria-hidden="true"
          className={`relative h-[15px] w-[26px] flex-none rounded-[var(--r-pill)] transition-[background-color,box-shadow] peer-focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] ${
            disabled
              ? "bg-[var(--fill-tertiary)]"
              : shown
                ? "bg-[var(--accent)]"
                : "bg-[var(--fill-quaternary)]"
          }${pending ? " opacity-60" : ""}`}
        >
          <span
            // `--e-0`'s hairline rather than the artboard's bespoke knob shadow:
            // the token layer declares exactly three elevations and a fourth
            // undeclared one is the first crack in that. The hairline separates
            // the knob from the grey track, and on the accent track the contrast
            // already does.
            className={`absolute top-[1px] left-[1px] h-[13px] w-[13px] rounded-[var(--r-pill)] bg-[var(--card)] shadow-[var(--e-0)] transition-transform ${
              shown ? "translate-x-[11px]" : "translate-x-0"
            }`}
          />
        </span>
        <span className={labelHidden ? "sr-only" : undefined}>{label}</span>
        {children}
      </label>

      {hint === undefined ? null : (
        <p id={hintId} className="m-0 text-[11px] leading-[1.35] text-[var(--label-secondary)]">
          {hint}
        </p>
      )}
      {failed ? (
        <p
          id={errorId}
          role="alert"
          className="m-0 flex gap-[5px] text-[11px] leading-[1.35] font-medium text-[var(--danger-text)]"
        >
          <Icon name="circle-alert" size={12} className="mt-[2px]" />
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
