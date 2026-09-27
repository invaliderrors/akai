"use client";

/**
 * The ONE destructive confirmation.
 *
 * It replaces four different answers to the same question that shipped side by
 * side: an inline red panel that expands in place (`admin/type-to-confirm-button`
 * and its `DeleteProductButton` wrapper), a second hand-rolled copy of that
 * panel on the discount surface, and two destructive paths — the order
 * transition and the refund — with no confirmation at all. Four spellings of
 * "are you sure?" is how one of them quietly stops asking.
 *
 * TWO COMPOSITIONS, ONE SURFACE, AND DELIBERATELY OPPOSITE FOOTERS.
 *
 *  - `ConfirmAlert` is the macOS/HIG alert: a 300 pt centred glass card, the
 *    destructive verb on the LEFT and Cancel — `prominent` — on the RIGHT.
 *    Cancel is on the right because that is where the Return default lives, and
 *    the destructive button must never be the thing Return presses. It is for
 *    actions that can be taken back, and it is ALWAYS followed by an undo toast
 *    (see `onConfirm` below for why this file does not raise that toast itself).
 *
 *  - `TypeToConfirmDialog` is the sheet: 420 pt, opaque, left-aligned, with a
 *    ledger of what is about to change and an input that must be filled with
 *    the record's own identifier — or the exact amount — before the destructive
 *    button turns on. Its footer is the OTHER way round (Cancel left, verb
 *    right) because this one is a form, and a form's submit sits at the end of
 *    the reading order. Use it ONLY when the action is irreversible or moves
 *    money.
 *
 * WHY TYPE-TO-CONFIRM AT ALL, kept verbatim from the component this supersedes:
 * a two-button dialog is dismissed by muscle memory. Requiring the record's own
 * identifier forces the operator to read WHICH record they are on, which is the
 * entire safety property — the likeliest mistake is acting on the right-looking
 * row on the wrong page. Requiring it EVERYWHERE would destroy the property by
 * making it routine, which is why the alert exists.
 *
 * `"use client"`: both hold the in-flight flag and the typed string, and both
 * manage focus. There is nothing here a server component could render.
 */

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button, type ButtonSize } from "./button";
import { Icon, type IconName } from "./icon";
import { Dialog } from "./overlay";

// ---------------------------------------------------------------------------
// The error contract
// ---------------------------------------------------------------------------

/**
 * A message the CALLER has already translated and is explicitly opting in to
 * showing a human.
 *
 * The rule it enforces: `ActionResult.message` is documented in
 * `lib/admin/actions.ts` as "Server-authored English — do NOT render it to an
 * operator", and `ProductEditor` throws exactly that (`new Error(result.message)`).
 * So an unmarked `Error` — whatever it carries — becomes the caller's own
 * translated `fallbackError`, and putting raw text in front of a human requires
 * saying so in the type.
 *
 * A NOTE FOR THE MIGRATION. `admin/type-to-confirm-button.tsx` declares a class
 * of the same name, and two classes with one name are two identities:
 * `instanceof` across them is false. That is safe rather than dangerous — the
 * mismatch degrades to `fallbackError`, never to leaked English — but it means
 * a call site must import its `ConfirmActionError` from the same module as the
 * component catching it. The admin copy goes away with its component.
 */
export class ConfirmActionError extends Error {
  constructor(translatedMessage: string) {
    super(translatedMessage);
    this.name = "ConfirmActionError";
  }
}

// ---------------------------------------------------------------------------
// Density
// ---------------------------------------------------------------------------

/**
 * Both dialogs take their size as a PROP rather than reading `--font-body` and
 * `--control-h` off the cascade, and that is a correctness matter here rather
 * than a preference: `Dialog` portals to `document.body`, so a surface that
 * escapes the shell also escapes the shell's `data-density`. Every density
 * variable would resolve to the bare `:root` fallback no matter which shell
 * opened it.
 *
 * Default `comfortable`, matching the bare-root token defaults, `Badge` and
 * `SectionHeader`: a forgotten prop then gives a customer on a phone a 44 pt
 * target, which is never a defect. The artboard draws the compact variant.
 */
export type ConfirmDensity = "compact" | "comfortable";

interface AlertSizeSpec {
  readonly title: string;
  readonly body: string;
  readonly button: ButtonSize;
}

const ALERT_SIZE: Readonly<Record<ConfirmDensity, AlertSizeSpec>> = {
  compact: {
    title: "text-[13px] leading-[16px]",
    body: "text-[11px] leading-[14px]",
    button: "compact",
  },
  comfortable: {
    title: "text-[17px] leading-[22px]",
    body: "text-[13px] leading-[18px]",
    button: "mobile",
  },
};

interface SheetSizeSpec {
  readonly title: string;
  readonly body: string;
  readonly ledger: string;
  readonly prompt: string;
  readonly hint: string;
  /** Height and type ramp of the confirmation input. */
  readonly input: string;
  readonly button: ButtonSize;
}

const SHEET_SIZE: Readonly<Record<ConfirmDensity, SheetSizeSpec>> = {
  compact: {
    title: "text-[15px] tracking-[-0.23px]",
    body: "text-[13px]",
    ledger: "text-[12px]",
    prompt: "text-[13px]",
    hint: "text-[11px]",
    input: "h-7 text-[13px]",
    button: "compact",
  },
  comfortable: {
    title: "text-[17px] tracking-[-0.43px]",
    body: "text-[15px]",
    ledger: "text-[13px]",
    prompt: "text-[15px]",
    hint: "text-[13px]",
    input: "h-11 text-[17px]",
    button: "mobile",
  },
};

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

interface ConfirmAction {
  readonly busy: boolean;
  readonly error: string | null;
  readonly run: () => Promise<void>;
  /** Dismissal that a request in flight is allowed to refuse. */
  readonly requestClose: () => void;
}

/**
 * The in-flight flag, the failure message and the two rules around them.
 *
 * FAILURE KEEPS THE DIALOG OPEN. A destructive dialog that closes on failure
 * looks exactly like one that closed on success, and the operator finds out at
 * the next page load — usually by pressing the button again.
 *
 * A REQUEST IN FLIGHT REFUSES ESCAPE AND THE SCRIM. Once the call is out there
 * is nothing to cancel, and a dialog that vanishes mid-request leaves the
 * operator unable to tell whether it happened. `requestClose` is therefore what
 * every dismissal path goes through, including `Dialog`'s own.
 */
function useConfirmAction(
  open: boolean,
  onConfirm: () => Promise<void>,
  onClose: () => void,
  fallbackError: string,
): ConfirmAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The dialog stays mounted while closed — only `Dialog` unmounts its
  // children — so a failure from the last attempt would still be sitting there
  // the next time it opens.
  useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  return {
    busy,
    error,
    run: async () => {
      if (busy) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await onConfirm();
        onClose();
      } catch (cause) {
        // ONLY a message the caller marked as translated is rendered. Anything
        // else — including a plain Error carrying the API's English — becomes
        // the caller's own translated fallback.
        setError(cause instanceof ConfirmActionError ? cause.message : fallbackError);
      } finally {
        setBusy(false);
      }
    },
    requestClose: () => {
      if (busy) {
        return;
      }
      onClose();
    },
  };
}

interface ActionErrorProps {
  readonly message: string;
  readonly className: string;
}

/**
 * `role="alert"` and nothing else: the message appears in a surface that
 * already has focus inside it, so an assertive announcement is the only thing
 * that tells a screen-reader user the press did not work.
 */
function ActionError({ message, className }: ActionErrorProps) {
  return (
    <p role="alert" className={`m-0 font-medium text-[var(--danger-text)] ${className}`}>
      {message}
    </p>
  );
}

interface DangerTileProps {
  readonly icon: IconName;
  /** Edge of the tile in px; the glyph is drawn a little under half of it. */
  readonly size: 40 | 56;
}

/**
 * The tinted glyph tile.
 *
 * Always the danger ramp, with no tone prop: both of these dialogs exist for
 * destructive actions, and a green confirmation card is a contradiction. The
 * glyph is `aria-hidden` — it repeats what the title says in words, and the
 * title is what names the dialog.
 *
 * `rounded-[14px]` on the large tile is a literal because the token layer has
 * no 14 pt corner: `--r-sheet` (12) is the nearest and reads visibly tighter at
 * 56 pt. The 40 pt tile takes `--r-card`, which IS its drawn radius.
 */
function DangerTile({ icon, size }: DangerTileProps) {
  const large = size === 56;

  return (
    <span
      className={`grid flex-none place-items-center bg-[var(--danger-fill)] text-[var(--danger)] ${
        large ? "h-14 w-14 rounded-[14px]" : "h-10 w-10 rounded-[var(--r-card)]"
      }`}
    >
      <Icon name={icon} size={large ? 26 : 20} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// ConfirmAlert
// ---------------------------------------------------------------------------

export interface ConfirmAlertProps {
  readonly open: boolean;
  /** Every dismissal path — Cancel, Escape, the scrim — and success. */
  readonly onClose: () => void;
  /** Already translated, and phrased as a question: "¿Eliminar esta dirección?" */
  readonly title: string;
  /**
   * The affected record, named the way the customer or operator sees it
   * elsewhere ("Casa · Carrer de Mallorca 214, Barcelona").
   *
   * REQUIRED, and its own line rather than a bold span the caller interpolates
   * into `consequence`. Two reasons: a required prop is the only way "the item
   * is named" cannot be forgotten, and a record's name substituted into a
   * translated sentence is exactly the interpolation that goes wrong first in a
   * language whose word order is not Spanish's. The artboard draws it inline;
   * this is the one place the drawing is not followed, and it scans better at
   * 300 pt besides.
   */
  readonly item: string;
  /** What happens, in plain language, INCLUDING what does not change. */
  readonly consequence: ReactNode;
  /**
   * Defaults to the drawn `trash-2`: this dialog's whole reason to exist is a
   * reversible removal. `TypeToConfirmDialog` requires its glyph instead,
   * because that one serves several different kinds of harm.
   */
  readonly icon?: IconName;
  /** The verb alone — "Eliminar", never "Sí" or "Aceptar". */
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** Shown on the confirm button while `onConfirm` is in flight. */
  readonly busyLabel: string;
  /** Rendered when `onConfirm` rejects with anything but a `ConfirmActionError`. */
  readonly fallbackError: string;
  /**
   * Resolve to close the dialog; reject to keep it open with a message.
   *
   * The UNDO TOAST IS THE CALLER'S. This component cannot know how to reverse
   * the action, and reaching for `useToast` here would make every consumer —
   * and every test of one — need a `ToastProvider` to render a card with two
   * buttons on it. Raise it when this promise resolves.
   */
  readonly onConfirm: () => Promise<void>;
  readonly density?: ConfirmDensity;
  readonly className?: string;
}

/**
 * The reversible confirmation: a title, the item, the consequence, two buttons.
 *
 * WHY THE ACCESSIBLE NAME IS THREE IDS. The APG alertdialog pattern puts the
 * warning in `aria-describedby`, and `Dialog` does not expose one — that file
 * belongs to another change. Left at the title alone, a screen-reader user
 * hears "¿Eliminar esta dirección?" and then "Cancelar, botón", and never finds
 * out WHICH address: the entire safety property of the dialog, gone for exactly
 * the people who cannot see the card. An `aria-labelledby` ID reference LIST is
 * valid ARIA and guarantees all three are spoken, so that is what ships. Move
 * the last two to `aria-describedby` the day `Dialog` grows the prop.
 */
export function ConfirmAlert({
  open,
  onClose,
  title,
  item,
  consequence,
  icon = "trash-2",
  confirmLabel,
  cancelLabel,
  busyLabel,
  fallbackError,
  onConfirm,
  density = "comfortable",
  className,
}: ConfirmAlertProps) {
  const domId = useId();
  const titleId = `${domId}-title`;
  const itemId = `${domId}-item`;
  const consequenceId = `${domId}-consequence`;

  const cancelRef = useRef<HTMLButtonElement>(null);
  const action = useConfirmAction(open, onConfirm, onClose, fallbackError);
  const size = ALERT_SIZE[density];

  return (
    <Dialog
      open={open}
      onClose={action.requestClose}
      role="alertdialog"
      surface="glass"
      labelledBy={`${titleId} ${itemId} ${consequenceId}`}
      initialFocus={cancelRef}
      // `!` because the panel already carries `max-w-[420px]` and Tailwind
      // emits `max-w-[300px]` BEFORE it — same specificity, so without the
      // important flag which one wins is stylesheet order, i.e. a coin flip.
      className={`max-w-[300px]!${className === undefined ? "" : ` ${className}`}`}
    >
      <div className="grid justify-items-center gap-[6px] p-5 text-center">
        <span className="mb-[6px]">
          <DangerTile icon={icon} size={56} />
        </span>

        <h2 id={titleId} className={`m-0 font-bold text-[var(--label)] ${size.title}`}>
          {title}
        </h2>

        <p id={itemId} className={`m-0 font-semibold text-[var(--label)] ${size.body}`}>
          {item}
        </p>

        {/* Full `--label`, as drawn: the consequence is the sentence the whole
            dialog exists to make someone read, and greying it out is the one
            thing that stops that happening. */}
        <p id={consequenceId} className={`m-0 text-[var(--label)] ${size.body}`}>
          {consequence}
        </p>

        {action.error === null ? null : (
          <ActionError message={action.error} className={size.body} />
        )}

        {/* Equal columns so neither verb is the wider, more inviting target,
            and the destructive one first because Cancel holds the right-hand
            default position. */}
        <div className="mt-3 grid w-full grid-cols-2 gap-2">
          <Button
            variant="destructivePlain"
            size={size.button}
            block
            pending={action.busy}
            pendingLabel={busyLabel}
            onClick={() => {
              void action.run();
            }}
          >
            {confirmLabel}
          </Button>
          <Button
            variant="prominent"
            size={size.button}
            block
            ref={cancelRef}
            // Safe to disable, unlike the confirm button: focus is on the
            // element that started the request, never on this one.
            disabled={action.busy}
            onClick={action.requestClose}
          >
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// TypeToConfirmDialog
// ---------------------------------------------------------------------------

/**
 * What the operator has to retype, and therefore how it is set.
 *
 * `identifier` is a slug, an order number or a lot code — mono, because that is
 * what mono is for in this product. `amount` is money, which the repo rule says
 * is NEVER mono: it takes the sans face with tabular figures so the digits line
 * up against the ledger row directly above them.
 */
export type ConfirmPhraseKind = "identifier" | "amount";

const PHRASE_FONT: Readonly<Record<ConfirmPhraseKind, string>> = {
  identifier: "font-mono",
  amount: "tabular-nums",
};

export interface ConfirmLedgerEntry {
  /** Already translated. */
  readonly label: string;
  /**
   * A `ReactNode` because the ledger is deliberately mixed: three money rows
   * and a reason, in the drawn refund. Money goes in as `<Money …>` so this
   * file never formats a currency and never sees a `Minor`.
   */
  readonly value: ReactNode;
  /** The one row that IS the action — the amount being refunded. */
  readonly emphasis?: boolean;
}

export interface TypeToConfirmDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Already translated, and it states the action AND its object. */
  readonly title: string;
  /** What happens, in plain language, ending in what cannot be undone. */
  readonly consequence: ReactNode;
  /** Required: this dialog serves deletion, refunds and shipping alike. */
  readonly icon: IconName;
  /** The exact string that must be typed. Compared after trimming, case-sensitively. */
  readonly phrase: string;
  readonly phraseKind?: ConfirmPhraseKind;
  /**
   * The instruction, with the rendered phrase chip handed back to be placed
   * inside it: `(chip) => t.rich("typePrompt", { phrase: () => chip })`.
   *
   * A function rather than a `ReactNode` so `phrase` stays the single source of
   * that string — a caller that builds the chip itself has to repeat the phrase
   * and its kind, and the copy that says "type X" is then free to disagree with
   * the value being compared. The sentence itself is still the caller's,
   * because only the caller knows which namespace it lives in.
   */
  readonly prompt: (phrase: ReactNode) => ReactNode;
  /**
   * Why the button is off, in neutral secondary text — NOT an error.
   *
   * Nothing has gone wrong: the operator has not finished typing. A red
   * message here would train them to read "invalid" as "keep going", which is
   * exactly the wrong lesson on the field guarding an irreversible action.
   */
  readonly mismatchHint: string;
  readonly ledger?: readonly ConfirmLedgerEntry[];
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly busyLabel: string;
  readonly fallbackError: string;
  readonly onConfirm: () => Promise<void>;
  readonly density?: ConfirmDensity;
  readonly className?: string;
}

/**
 * The irreversible confirmation: a ledger of what changes, and a phrase to type.
 *
 * It is a real `<form>`, so Return submits once the phrase matches — and only
 * then, because HTML skips implicit submission when the default button is
 * disabled. The submit is `disabled` rather than merely ignored, so the reason
 * the action is unavailable is carried by the control itself.
 */
export function TypeToConfirmDialog({
  open,
  onClose,
  title,
  consequence,
  icon,
  phrase,
  phraseKind = "identifier",
  prompt,
  mismatchHint,
  ledger,
  confirmLabel,
  cancelLabel,
  busyLabel,
  fallbackError,
  onConfirm,
  density = "comfortable",
  className,
}: TypeToConfirmDialogProps) {
  const domId = useId();
  const titleId = `${domId}-title`;
  const inputId = `${domId}-input`;
  const hintId = `${domId}-hint`;

  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const action = useConfirmAction(open, onConfirm, onClose, fallbackError);
  const size = SHEET_SIZE[density];

  // Trimmed because a pasted identifier routinely carries a trailing space, and
  // case-sensitive because the phrase IS the record's identifier.
  const matched = typed.trim() === phrase;

  useEffect(() => {
    if (!open) {
      setTyped("");
    }
  }, [open]);

  const chip = (
    <span
      className={`rounded-[var(--r-check)] bg-[var(--fill-tertiary)] px-[5px] py-[1px] ${PHRASE_FONT[phraseKind]}`}
    >
      {phrase}
    </span>
  );

  return (
    <Dialog
      open={open}
      onClose={action.requestClose}
      role="dialog"
      surface="opaque"
      labelledBy={titleId}
      initialFocus={inputRef}
      {...(className === undefined ? {} : { className })}
    >
      <form
        className="grid gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!matched) {
            return;
          }
          void action.run();
        }}
      >
        <div className="flex items-start gap-3">
          <DangerTile icon={icon} size={40} />
          <div>
            <h2 id={titleId} className={`m-0 font-semibold text-[var(--label)] ${size.title}`}>
              {title}
            </h2>
            {/* Secondary here where the alert's is full `--label`: this dialog
                has a title, this prose AND a ledger, so the prose needs a rung
                below the title to sit on. The artboard's #48484a is
                `--neutral-text`, a STATUS token — borrowing it for body copy is
                how a status colour ends up meaning nothing. */}
            <p className={`mt-1 mb-0 text-[var(--label-secondary)] ${size.body}`}>{consequence}</p>
          </div>
        </div>

        {ledger === undefined || ledger.length === 0 ? null : (
          <dl
            className={`m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] rounded-[var(--r-card)] bg-[var(--bg-grouped)] px-3 py-[10px] ${size.ledger}`}
          >
            {ledger.map((entry) => (
              <Fragment key={entry.label}>
                <dt className="text-[var(--label-secondary)]">{entry.label}</dt>
                {/* Right-aligned and tabular so the figures form one column
                    the eye can compare down. Alignment belongs to the column,
                    not to `Money`, which sets neither. */}
                <dd
                  className={`m-0 text-right tabular-nums text-[var(--label)]${
                    entry.emphasis === true ? " font-semibold" : ""
                  }`}
                >
                  {entry.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        )}

        <div className="grid gap-[5px]">
          <label htmlFor={inputId} className={`font-medium text-[var(--label)] ${size.prompt}`}>
            {prompt(chip)}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            name="confirmPhrase"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
            // Off across the board: this is a transcription of something on the
            // screen, and a browser filling it in defeats the entire control.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            {...(matched ? {} : { "aria-describedby": hintId })}
            // The focus ring is painted here rather than on a wrapper because
            // there is no trailing chip to keep inside it. `outline-none` first
            // and explicitly: the base `:focus-visible` rule lives in
            // `@layer base`, so a utility wins — but only if it is emitted.
            className={`w-full rounded-[var(--r-control)] border-0 bg-[var(--card)] px-2 text-[var(--label)] shadow-[inset_0_0_0_1px_var(--separator-weak)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--separator)] focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--focus-ring)] ${
              size.input
            } ${PHRASE_FONT[phraseKind]}`}
          />
          {matched ? null : (
            <p id={hintId} className={`m-0 text-[var(--label-secondary)] ${size.hint}`}>
              {mismatchHint}
            </p>
          )}
        </div>

        {action.error === null ? null : (
          <ActionError message={action.error} className={size.hint} />
        )}

        {/* Cancel first, submit last: this one is a form, and its submit sits
            at the end of the reading order. The alert's footer is the mirror of
            this on purpose — see the file header. */}
        <div className="flex justify-end gap-2">
          <Button
            variant="standard"
            size={size.button}
            disabled={action.busy}
            onClick={action.requestClose}
          >
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            size={size.button}
            type="submit"
            disabled={!matched}
            pending={action.busy}
            pendingLabel={busyLabel}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
