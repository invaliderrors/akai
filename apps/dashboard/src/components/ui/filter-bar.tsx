import Link from "next/link";

import { Button, buttonClassName } from "./button";
import { Icon } from "./icon";
import type { SearchParamValue } from "./segmented-control";

/**
 * The list filter bar: ONE GET form, replacing six hand-typed ones.
 *
 * FILTERS LIVE IN THE URL, and every other decision here follows from that. A
 * filtered view is linkable, survives a reload and steps back with the back
 * button — and because the state IS the URL rather than React state, the page
 * that renders it stays a server component. Nothing in this file holds state,
 * and the whole bar works with JavaScript switched off: applying is a form
 * submission, removing one filter is a link.
 *
 * THE FORM HAS NO `action`, DELIBERATELY. Omitted, a GET form submits to the
 * current URL, which is exactly the list being filtered. `pathname` is used
 * ONLY to build the remove-one-filter hrefs, which go through `Link`.
 *
 * A GET SUBMIT REPLACES THE WHOLE QUERY STRING with the form's own fields, so
 * anything already in the URL that is not a field here is carried across as a
 * hidden input — `limit` above all, since losing the operator's page size every
 * time they type an email is the sort of thing nobody files and everybody
 * notices. `cursor` and `expand` are the two deliberate exceptions; see
 * POSITION_PARAMS.
 *
 * THE CONTROLS ARE UNCONTROLLED, which is why `field.tsx`'s TextField and
 * PopupButton are not reused even though this is the same paint: every control
 * there is controlled (a required `onChange`) and that file is `"use client"`.
 * A server component has no handler to hand it, and React rejects a `value`
 * with no `onChange`. The class strings below are the same spellings as
 * field.tsx's `SHELL_TONE.default` and its `PopupButton`, so a filter input and
 * a form input stay one design rather than two that drift.
 */

/**
 * Params that name a POSITION INSIDE one result set rather than the set itself:
 * the cursor stack (`pagination.tsx`) and the expanded row (`table.tsx`).
 *
 * Changing a filter changes the set, so both are dropped by every href this
 * file builds and by the form itself. Carrying a cursor across shows page four
 * of a list that now has one page; carrying an expansion points at a row that
 * may no longer be in the results. The two spellings are shared with those two
 * files and must stay in step with them.
 */
const POSITION_PARAMS: readonly string[] = ["cursor", "expand"];

// ---------------------------------------------------------------------------
// Reading and writing the query string
// ---------------------------------------------------------------------------

/**
 * The first usable value of a possibly-repeated param.
 *
 * Empty entries are dropped, because an empty one means "no filter" rather than
 * "a filter matching the empty string" — and this bar PRODUCES them: an empty
 * text box in a GET form submits `?email=`, so without this every Apply on a
 * cleared field would leave a blank token in the row and send `email=""` to the
 * API. Same reasoning as `cursorStack()` next door.
 *
 * Replaces the four page-local copies of this helper, which differed: three
 * returned `value[0]` for a repeated param without the empty check.
 */
export function single(value: SearchParamValue): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value === "" ? undefined : value;
  }
  return value.find((entry) => entry !== "");
}

export interface BuildFilterHrefOptions {
  /** Route the list lives on, e.g. `/admin/orders`. */
  readonly pathname: string;
  /** Everything already in the URL. Unrelated params are carried across. */
  readonly searchParams?: Readonly<Record<string, SearchParamValue>>;
  /**
   * Written into the URL, replacing whatever was there. An `undefined` or empty
   * value REMOVES the param — the same thing, since "" is not a filter.
   */
  readonly set?: Readonly<Record<string, string | undefined>>;
  /** Dropped outright. */
  readonly drop?: readonly string[];
}

/**
 * Builds a list URL, preserving every param not named in `set` or `drop`.
 *
 * This is what carries the filters, `limit` and `expand` across a pagination
 * step, a row expansion or a token removal. The alternative is each surface
 * hand-rolling `new URLSearchParams`, and the bug that produces is always the
 * same one: paging forward silently discards the search term or the page size.
 *
 * Repeated params survive as repeats — the cursor stack is one — so this can be
 * composed with `pushCursor()`/`popCursor()` without collapsing their history.
 * Set values are appended after the carried ones, matching `segmentHref()`.
 */
export function buildFilterHref({
  pathname,
  searchParams = {},
  set = {},
  drop = [],
}: BuildFilterHrefOptions): string {
  const next = new URLSearchParams();

  for (const [key, raw] of Object.entries(searchParams)) {
    // `Object.hasOwn`, not `key in set`: the keys here come from a URL a
    // stranger can write, and `"constructor" in set` is true for every object.
    if (raw === undefined || drop.includes(key) || Object.hasOwn(set, key)) {
      continue;
    }
    if (typeof raw === "string") {
      if (raw !== "") {
        next.append(key, raw);
      }
      continue;
    }
    for (const entry of raw) {
      if (entry !== "") {
        next.append(key, entry);
      }
    }
  }

  for (const [key, value] of Object.entries(set)) {
    if (value !== undefined && value !== "") {
      next.append(key, value);
    }
  }

  const query = next.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

/**
 * The three drawn control widths — 110 / 150 / 170.
 *
 * A closed set rather than a number, because Tailwind finds utilities by
 * scanning source TEXT: `w-[${width}px]` is a class that is never generated, so
 * the field would silently render at content width with no error anywhere.
 */
export type FilterFieldWidth = "sm" | "md" | "lg";

const WIDTH: Readonly<Record<FilterFieldWidth, string>> = {
  sm: "w-[110px]",
  md: "w-[150px]",
  lg: "w-[170px]",
};

interface FilterFieldBase {
  /** The query param this field writes. Unique within the bar. */
  readonly name: string;
  /** Already translated. Labels the control AND prefixes its token. */
  readonly label: string;
}

export interface FilterTextField extends FilterFieldBase {
  readonly kind: "text";
  /** Straight off `searchParams`, already reduced through `single()`. */
  readonly value: string | undefined;
  /**
   * There is no `email` type on purpose. Every email filter in this product is
   * a CONTAINS match, and `type="email"` makes the browser refuse to submit
   * "acme" — a validation failure on a substring that was never meant to be an
   * address. `search` gets the platform's clear affordance; `text` is the rest.
   */
  readonly type?: "text" | "search";
  readonly placeholder?: string;
  /** Identifiers only — order numbers, SKUs, tracking numbers. Never money. */
  readonly mono?: boolean;
  readonly width?: FilterFieldWidth;
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterSelectField extends FilterFieldBase {
  readonly kind: "select";
  readonly value: string | undefined;
  /** The "no filter" option, rendered first and submitting an empty value. */
  readonly anyLabel: string;
  readonly options: readonly FilterOption[];
  readonly width?: FilterFieldWidth;
}

export interface FilterCheckboxField extends FilterFieldBase {
  readonly kind: "checkbox";
  readonly checked: boolean;
  /**
   * Submitted when checked; defaults to `"true"`. Left as a literal string
   * because the API parses these with `z.coerce.boolean()`, under which the
   * string `"false"` is TRUTHY — a "helpful" conversion inverts the filter.
   */
  readonly value?: string;
}

export type FilterField = FilterTextField | FilterSelectField | FilterCheckboxField;

export interface FilterBarLabels {
  /** Submit. "Aplicar". */
  readonly apply: string;
  /** Clears every filter. "Limpiar". */
  readonly clear: string;
  /** Prefixes the token row. "Filtros:". */
  readonly active: string;
  /** Names one token's remove control: `(f) => \`Quitar filtro ${f}\``. */
  readonly remove: (filter: string) => string;
}

export interface FilterBarProps {
  /** Accessible name of the search landmark — already translated. */
  readonly label: string;
  readonly fields: readonly FilterField[];
  /** Route the list lives on, for the token and clear links. */
  readonly pathname: string;
  /** Everything already in the URL. */
  readonly searchParams?: Readonly<Record<string, SearchParamValue>>;
  readonly labels: FilterBarLabels;
  readonly className?: string;
}

/**
 * One applied filter, as the token row says it.
 *
 * Derived from the same `fields` the controls are drawn from, so the row and
 * the controls cannot disagree about what is applied — which is the whole
 * reason this component takes a declarative field list instead of children.
 */
interface ActiveFilter {
  readonly name: string;
  /** The field's own label — what the remove control names. */
  readonly label: string;
  /** What the token reads: "Estado: Necesitan decisión". */
  readonly text: string;
}

function activeFilters(field: FilterField): readonly ActiveFilter[] {
  switch (field.kind) {
    case "text": {
      const value = field.value ?? "";
      return value === ""
        ? []
        : [{ name: field.name, label: field.label, text: `${field.label}: ${value}` }];
    }
    case "select": {
      // A value with no matching option gets NO token, and the control below
      // falls back to "any" for the same reason: the page narrows this value
      // through the contract's own enum before it queries, so a value we cannot
      // name is a value the list was not filtered by. A token for it would be a
      // lie, and a lie in the one row an operator reads to know what they are
      // looking at.
      const chosen = field.options.find((option) => option.value === field.value);
      return chosen === undefined
        ? []
        : [{ name: field.name, label: field.label, text: `${field.label}: ${chosen.label}` }];
    }
    case "checkbox":
      // No "Incluir eliminados: Sí" — a boolean filter has no value to name,
      // and the label already is the whole statement.
      return field.checked ? [{ name: field.name, label: field.label, text: field.label }] : [];
  }
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/**
 * Every control is a fixed 28, not `--control-h`.
 *
 * The same call `Button` makes for its own size ladder and for the same reason:
 * a toolbar is a toolbar at any page density. `--control-h` is the DENSITY
 * ladder, and a filter row that grew to 44 inside a comfortable shell while the
 * Apply button beside it stayed 28 would be two heights in one row — `Button`'s
 * size cannot read the cascade, so the two would have to be decided apart. A
 * phone-facing filter surface wants a sheet, not a taller version of this row.
 */
const CONTROL_BOX =
  "h-[28px] rounded-[var(--r-control)] border-0 bg-[var(--card)] text-[var(--label)] transition-shadow focus-visible:outline-none";

const TEXT_INPUT = `${CONTROL_BOX} px-[8px] shadow-[inset_0_0_0_1px_var(--separator-weak)] placeholder:text-[var(--label-tertiary)] hover:shadow-[inset_0_0_0_1px_var(--separator)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--focus-ring)]`;

const SELECT_BOX = `${CONTROL_BOX} w-full appearance-none pl-[8px] pr-[28px] text-[13px] shadow-[var(--ring-control)] hover:shadow-[0_0_0_1px_var(--separator),0_1px_1px_var(--separator-weak)] focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--focus-ring)]`;

const FIELD_LABEL = "text-[11px] font-semibold text-[var(--label-secondary)]";

const TOKEN =
  "inline-flex h-[22px] items-center gap-[4px] rounded-[var(--r-control)] bg-[var(--accent-tint)] pl-[9px] pr-[4px] text-[12px] font-medium text-[var(--accent-ink)]";

/**
 * The remove control is 18px, under the 24px of WCAG 2.5.8 — which its spacing
 * exception covers: the nearest other target is the next token's remove, a
 * whole token's text away, so no two 24px circles centred on these intersect.
 */
const TOKEN_REMOVE =
  "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[var(--r-check)] hover:bg-[var(--accent-tint-strong)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";

/** Ids are derived from the param name, which is unique within one bar. */
function controlId(name: string): string {
  return `filter-${name}`;
}

interface FilterControlProps {
  readonly field: FilterField;
}

function FilterControl({ field }: FilterControlProps) {
  const id = controlId(field.name);

  if (field.kind === "checkbox") {
    return (
      // Boxed to the control height so it sits on the same baseline as the
      // fields beside it under `items-end`.
      <div className="flex h-[28px] items-center gap-[6px]">
        <input
          id={id}
          type="checkbox"
          name={field.name}
          value={field.value ?? "true"}
          defaultChecked={field.checked}
          className="h-[14px] w-[14px] shrink-0 accent-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
        />
        {/* Not a wrapping label: htmlFor/id everywhere makes the pairing the
            same one mechanism across all three kinds. Clicking the words still
            toggles the box, which is what keeps the target size honest. */}
        <label htmlFor={id} className="text-[13px] text-[var(--label)]">
          {field.label}
        </label>
      </div>
    );
  }

  return (
    <div className="grid gap-[4px]">
      <label htmlFor={id} className={FIELD_LABEL}>
        {field.label}
      </label>
      {field.kind === "text" ? (
        <input
          id={id}
          type={field.type ?? "text"}
          name={field.name}
          defaultValue={field.value ?? ""}
          className={`${TEXT_INPUT} ${
            field.mono === true ? "font-mono text-[12px]" : "text-[13px]"
          } ${WIDTH[field.width ?? "md"]}`}
          {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
        />
      ) : (
        <div className={`relative ${WIDTH[field.width ?? "lg"]}`}>
          <select
            id={id}
            name={field.name}
            defaultValue={
              field.options.find((option) => option.value === field.value)?.value ?? ""
            }
            className={SELECT_BOX}
          >
            <option value="">{field.anyLabel}</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {/* The accent chip, spelled exactly as `PopupButton` draws it so the
              two pop-ups are one control wearing two densities. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-[4px] top-1/2 flex h-[20px] w-[20px] -translate-y-1/2 items-center justify-center rounded-[5px] bg-[var(--accent)]"
          >
            <Icon name="chevrons-up-down" size={12} className="text-[var(--label-on-accent)]" />
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

export function FilterBar({
  label,
  fields,
  pathname,
  searchParams = {},
  labels,
  className,
}: FilterBarProps) {
  const owned = new Set(fields.map((field) => field.name));
  const active = fields.flatMap(activeFilters);

  /**
   * Params the form must re-submit by hand. A GET submit sends only the form's
   * own fields, so everything else in the URL — `limit`, and anything a future
   * surface adds — would be lost on Apply unless it rides along hidden.
   */
  const carried = Object.entries(searchParams).flatMap(([key, raw]) => {
    if (raw === undefined || owned.has(key) || POSITION_PARAMS.includes(key)) {
      return [];
    }
    const values = typeof raw === "string" ? [raw] : raw;
    return values
      .filter((value) => value !== "")
      .map((value, index) => (
        <input key={`${key}-${index}`} type="hidden" name={key} value={value} />
      ));
  });

  return (
    <form
      method="get"
      // A landmark, and `search` rather than the implicit `form`: this IS the
      // page's search facility, and on a dense operator list it is the one
      // region a keyboard user wants to jump straight to.
      role="search"
      aria-label={label}
      className={`flex flex-wrap items-end gap-[10px]${
        className === undefined ? "" : ` ${className}`
      }`}
    >
      {carried}

      {fields.map((field) => (
        <FilterControl key={field.name} field={field} />
      ))}

      <Button type="submit" variant="prominent" size="compact">
        {labels.apply}
      </Button>

      {active.length > 0 && (
        // A LINK, not `<button type="reset">`: reset restores the controls to
        // what the server rendered and never submits, so the list would go on
        // showing the filters the operator just cleared.
        <Link
          href={buildFilterHref({
            pathname,
            searchParams,
            drop: [...owned, ...POSITION_PARAMS],
          })}
          className={buttonClassName({ variant: "plain", size: "compact" })}
        >
          {labels.clear}
        </Link>
      )}

      {active.length > 0 && (
        <div className="flex w-full flex-wrap items-center gap-[6px] text-[12px] text-[var(--label-secondary)]">
          <span>{labels.active}</span>
          {/* `role="list"` is not redundant: preflight sets list-style:none,
              and Safari drops the role from an unstyled list. */}
          <ul role="list" className="flex flex-wrap items-center gap-[6px]">
            {active.map((filter) => (
              <li key={filter.name} className={TOKEN}>
                {filter.text}
                {/* Removing a filter is a navigation, so it is a link — which
                    is also what makes it work with JavaScript off, and what
                    makes it survive as a middle-click. */}
                <Link
                  href={buildFilterHref({
                    pathname,
                    searchParams,
                    drop: [filter.name, ...POSITION_PARAMS],
                  })}
                  aria-label={labels.remove(filter.label)}
                  className={TOKEN_REMOVE}
                >
                  <Icon name="x" size={11} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
