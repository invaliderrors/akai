"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Button, type ButtonVariant } from "@/components/ui/button";
import { TypeToConfirmDialog } from "@/components/ui/confirm";
import type { IconName } from "@/components/ui/icon";

/**
 * A destructive admin action behind a typed confirmation.
 *
 * WHAT IS LEFT OF THIS FILE. The interaction — the modal, the focus trap, the
 * typed-phrase gate, the in-flight flag, the failure that keeps the dialog
 * open — now lives in `ui/confirm`'s `TypeToConfirmDialog`, which the customer
 * area composes as well. All this component still owns is the TRIGGER and the
 * decision that admin opens it at `compact` density. The hand-rolled inline red
 * panel it used to draw is gone; so is the second implementation of a safety
 * control, which is how the two drift until one of them stops being safe.
 *
 * EVERY ID STILL COMES FROM `useId()` — it just comes from the dialog's own
 * `useId()` now. That is the bug the original extraction existed to fix: the
 * first version hardcoded `id="delete-confirm"` and
 * `aria-labelledby="delete-product-title"`, so two of these on one page produced
 * duplicate DOM ids, the `<label>` pointed at whichever input the browser found
 * first, and a screen reader announced the wrong dialog's title. Nothing here
 * may reintroduce a literal id.
 *
 * `ConfirmActionError` IS RE-EXPORTED, NOT REDECLARED. Two classes with one name
 * are two identities and `instanceof` across them is false — a caller that threw
 * the local copy would have had its translated message silently replaced by the
 * fallback. Re-exporting the kit's class means the one the caller throws is the
 * one the dialog checks, and existing importers of this module keep working.
 */
export { ConfirmActionError } from "@/components/ui/confirm";

export interface TypeToConfirmButtonProps {
  /** The exact string the operator must type. Compared after trimming. */
  readonly phrase: string;
  /** Label of the button that opens the dialog. Ends in "…" — it opens a view. */
  readonly triggerLabel: string;
  /** Dialog heading. Wired to `aria-labelledby` by the dialog. */
  readonly title: string;
  /** What actually happens, in the operator's language. */
  readonly body: ReactNode;
  /**
   * The typed-confirmation instruction, e.g. "Escribe hoodie-kumo para confirmar".
   *
   * A ReactNode rather than a string because the phrase inside it is rendered
   * monospaced, and because a translated version needs `t.rich` to place that
   * markup — which the CALLER owns, since only it knows which namespace the copy
   * lives in. The dialog offers to render the chip itself; these callers decline
   * it, because their message catalogue already carries a `<mono>` chunk and two
   * chips in one sentence is one chip too many.
   */
  readonly prompt: ReactNode;
  readonly confirmLabel: string;
  /** Shown on the confirm button while `onConfirm` is in flight. */
  readonly busyLabel: string;
  readonly cancelLabel: string;
  /** Shown whenever `onConfirm` rejects with anything but a `ConfirmActionError`. */
  readonly fallbackError: string;
  readonly onConfirm: () => Promise<void>;
  /** The dialog's glyph. Defaults to the removal it usually is. */
  readonly icon?: IconName;
  /**
   * Defaults to the danger zone's shape: a standard button with red ink, not a
   * filled red one. A filled destructive button is the loudest control on a page
   * where nothing has happened yet, and the confirmation is what makes the
   * action safe — not the colour of the thing that opens it.
   */
  readonly triggerVariant?: ButtonVariant;
}

export function TypeToConfirmButton({
  phrase,
  triggerLabel,
  title,
  body,
  prompt,
  confirmLabel,
  busyLabel,
  cancelLabel,
  fallbackError,
  onConfirm,
  icon = "trash-2",
  triggerVariant = "destructivePlain",
}: TypeToConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  // The one string this component does not take as a prop. It is the same
  // sentence for every destructive action in the product ("Todavía no
  // coincide."), it belongs to no caller's namespace, and making it a required
  // prop would mean four call sites each free to word the mismatch hint
  // differently on the field that guards an irreversible action.
  const tui = useTranslations("ui");

  return (
    <>
      <Button variant={triggerVariant} size="compact" onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>

      <TypeToConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        consequence={body}
        icon={icon}
        phrase={phrase}
        phraseKind="identifier"
        // The chip is ignored on purpose: see `prompt` above.
        prompt={() => prompt}
        mismatchHint={tui("mismatch")}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        busyLabel={busyLabel}
        fallbackError={fallbackError}
        onConfirm={onConfirm}
        // Admin is `data-density="compact"`, and the dialog cannot read it: it
        // portals to `document.body`, outside the shell that sets the attribute,
        // so every density variable would resolve to the bare `:root` default.
        density="compact"
      />
    </>
  );
}
