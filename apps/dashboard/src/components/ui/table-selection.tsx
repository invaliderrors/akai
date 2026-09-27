"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Row selection for `DataTable`, WITHOUT turning the table into a client
 * component.
 *
 * THE CHECKBOXES ARE PLAIN FORM CONTROLS. Each row renders
 * `<input type="checkbox" form={form} name={name} value={rowKey}>` on the
 * server; the `form` attribute associates it with a `<form id={form}>` that
 * lives wherever the actions are (a toolbar above the table), so selection is
 * DOM state — keyboard-operable, announced as a checkbox, surviving a
 * `router.refresh()` because React keeps the same `<input>` for the same row
 * key — and the table's rows stay server-rendered. Only the two things that
 * need JavaScript live here:
 *
 *  - `SelectAllCheckbox`, the header control ("select every row on this
 *    page"), which also shows the mixed state when some are selected, and
 *  - `useTableSelection`, which lets the action bar read the selected keys,
 *    in ROW ORDER (the order staff see is the order a bulk action receives).
 *
 * Everything talks through `change` events on the document, so the header,
 * the rows and any number of action bars stay in step without a context.
 */

export interface TableSelectionGroup {
  /** The `id` of the `<form>` the row checkboxes belong to. */
  readonly form: string;
  /** The checkboxes' `name`. */
  readonly name: string;
}

function rowBoxes({ form, name }: TableSelectionGroup): HTMLInputElement[] {
  if (typeof document === "undefined") {
    return [];
  }
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(
    (input) =>
      input.getAttribute("form") === form &&
      input.name === name &&
      input.dataset["selectAll"] === undefined,
  );
}

/** The selected row keys, in document (= row) order. */
export function readTableSelection(group: TableSelectionGroup): readonly string[] {
  return rowBoxes(group)
    .filter((input) => input.checked && !input.disabled)
    .map((input) => input.value);
}

/** Tell every listener the selection moved. One event, bubbling from the document. */
function announce(): void {
  document.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Clear the selection — after an action whose rows are about to change. */
export function clearTableSelection(group: TableSelectionGroup): void {
  for (const input of rowBoxes(group)) {
    input.checked = false;
  }
  announce();
}

/**
 * The live selection. Re-read on every `change` anywhere in the document —
 * cheap (one query over one page of rows) and immune to missing a path that
 * changed a box.
 */
export function useTableSelection(group: TableSelectionGroup): readonly string[] {
  const { form, name } = group;
  const [selected, setSelected] = useState<readonly string[]>([]);

  useEffect(() => {
    const update = (): void => {
      const next = readTableSelection({ form, name });
      setSelected((current) =>
        current.length === next.length && current.every((key, index) => key === next[index])
          ? current
          : next,
      );
    };
    update();
    document.addEventListener("change", update);
    return () => {
      document.removeEventListener("change", update);
    };
  }, [form, name]);

  return selected;
}

export interface SelectAllCheckboxProps extends TableSelectionGroup {
  /** Accessible name, already translated: "Seleccionar todos los pedidos de esta página". */
  readonly label: string;
  readonly className?: string;
}

/**
 * The header checkbox. Checked when every row is, MIXED (`indeterminate`,
 * announced as "mixed") when some are, and toggling it selects or clears the
 * whole page — never rows on other pages, which this table has not loaded.
 */
export function SelectAllCheckbox({ form, name, label, className }: SelectAllCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  const sync = useCallback(() => {
    const input = ref.current;
    if (input === null) return;
    const boxes = rowBoxes({ form, name }).filter((box) => !box.disabled);
    const checked = boxes.filter((box) => box.checked).length;
    input.checked = boxes.length > 0 && checked === boxes.length;
    input.indeterminate = checked > 0 && checked < boxes.length;
    input.disabled = boxes.length === 0;
  }, [form, name]);

  useEffect(() => {
    sync();
    document.addEventListener("change", sync);
    return () => {
      document.removeEventListener("change", sync);
    };
  }, [sync]);

  return (
    <input
      ref={ref}
      type="checkbox"
      // Deliberately NOT associated with the form: it is a control over the
      // selection, not a member of it, and must never submit a value.
      data-select-all=""
      aria-label={label}
      className={className}
      onChange={(event) => {
        const value = event.currentTarget.checked;
        for (const box of rowBoxes({ form, name })) {
          if (!box.disabled) box.checked = value;
        }
        announce();
      }}
    />
  );
}
