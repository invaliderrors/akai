"use client";

import { useState, type FormEvent } from "react";

import { Button } from "./button";
import { TextField } from "./field";

/**
 * The timeline's note composer, split out of `timeline.tsx` so that file stays
 * server-renderable.
 *
 * WHY THIS IS ITS OWN MODULE. `timeline.tsx` previously held this component and
 * carried no directive, reasoning that a composer requiring an `onSubmit`
 * function is unreachable from a server tree by construction. That is true at
 * RUNTIME and irrelevant at BUILD TIME: Next's server/client check is static and
 * module-level, so a server component importing `timeline.tsx` at all was enough
 * to fail the build on the `useState` import — reachable or not. The order
 * detail page renders a read-only rail with no composer, and still could not
 * compile.
 *
 * So the split is now real rather than notional. `timeline.tsx` imports this
 * module, which puts the boundary exactly where the state is, and the rail
 * itself still renders inside a server component with no JavaScript.
 */

export interface TimelineComposer {
  /** The field's accessible name, already translated ("Nota interna"). */
  readonly label: string;
  /** Already translated ("Guardar nota"). */
  readonly submitLabel: string;
  /**
   * REQUIRED, for the reason `Switch` requires one: a write that fails
   * silently has thrown away something the operator typed and cannot get back.
   * It is a translated sentence of ours — never an `ApiError.message`, which is
   * English written for a log.
   */
  readonly errorMessage: string;
  /**
   * Resolve to clear the field, reject to keep the draft. The rejection reason
   * is deliberately not read: phrasing it is the caller's job.
   */
  readonly onSubmit: (note: string) => void | Promise<void>;
  readonly placeholder?: string;
  /** Standing text under the field — "El cliente nunca la ve", say. */
  readonly hint?: string;
  /** Already translated, and phrased as the verb in progress ("Guardando…"). */
  readonly pendingLabel?: string;
}

/**
 * Exported only because it now lives across a module boundary from its one
 * consumer. That boundary is the point: see the directive note above.
 */
export function NoteComposer({
  label,
  submitLabel,
  errorMessage,
  onSubmit,
  placeholder,
  hint,
  pendingLabel,
}: TimelineComposer) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const trimmed = note.trim();

  async function commit(): Promise<void> {
    setFailed(false);
    setPending(true);
    try {
      await onSubmit(trimmed);
      // Cleared only on success. A field that empties itself on a failed write
      // has deleted the note AND told the operator it saved.
      setNote("");
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // Guarded here as well as by the disabled button: Enter in a single-field
    // form submits it without going near the button.
    if (trimmed === "" || pending) return;
    void commit();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3 flex items-start gap-2 border-t border-[var(--separator-weak)] pt-3"
    >
      <TextField
        label={label}
        labelHidden
        name="note"
        value={note}
        onChange={setNote}
        className="min-w-0 flex-1"
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(hint === undefined ? {} : { hint })}
        {...(failed ? { error: errorMessage } : {})}
      />
      {/*
        Disabled on an empty draft rather than accepting the press and doing
        nothing — there is no validation message to give for "you have not
        written anything yet", and a control that visibly cannot act is a
        better answer than one that silently does not. It is never disabled
        WHILE pending: `Button`'s pending state deliberately keeps the element
        focusable so a screen-reader user is not dropped to `<body>` mid-write.
      */}
      <Button
        type="submit"
        disabled={trimmed === ""}
        pending={pending}
        {...(pendingLabel === undefined ? {} : { pendingLabel })}
      >
        {submitLabel}
      </Button>
    </form>
  );
}
