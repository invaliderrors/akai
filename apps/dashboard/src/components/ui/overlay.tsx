"use client";

/**
 * The floating layer: an anchored Popover and a modal Dialog, over ONE piece of
 * focus management.
 *
 * `"use client"` is unavoidable and is the point of the file — focus, Escape,
 * outside clicks and the scroll lock are all browser APIs that only exist after
 * hydration. Everything the kit floats (the account menu, the operator nav
 * sheet, both confirm dialogs) composes these two, so the hand-rolled focus
 * trap lives here exactly once. A second copy is how one of them quietly stops
 * trapping.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref, RefObject } from "react";

/**
 * Deliberately no visibility test. jsdom gives every element a zero-sized box,
 * so an `offsetParent`/`getClientRects` filter would empty the trap in every
 * test while looking correct in a browser — and a panel only ever contains the
 * subtree its caller rendered, so a hidden control in it is the caller's bug.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
]
  .map((selector) => `${selector}:not([hidden]):not([aria-hidden="true"])`)
  .join(",");

function tabbableWithin(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

interface FocusLayerOptions {
  readonly panelRef: RefObject<HTMLElement | null>;
  /** True for a modal surface: Tab wraps instead of walking out of it. */
  readonly trap: boolean;
  readonly onDismiss: () => void;
  /** Overrides "first tabbable" — a confirm alert focuses Cancel, not the verb. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
}

interface FocusLayer {
  /**
   * Escape, and Tab wrapping when trapped. Goes on the PANEL for a dialog and
   * on the wrapper for a popover, so nesting resolves innermost-first through
   * normal bubbling — a document-level listener would fire the outer surface's
   * handler first and close the wrong thing.
   */
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

function useFocusLayer(
  open: boolean,
  { panelRef, trap, onDismiss, initialFocus }: FocusLayerOptions,
): FocusLayer {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel !== null) {
      const target = initialFocus?.current ?? tabbableWithin(panel)[0] ?? panel;
      target.focus();
    }

    return () => {
      if (invoker === null || !invoker.isConnected) {
        return;
      }
      // Restore ONLY if focus came loose — which is what happens when the
      // focused element is unmounted with the layer. After an outside click the
      // browser has already focused whatever was clicked, and dragging focus
      // back to the trigger is worse than not restoring at all.
      const active = document.activeElement;
      if (active === null || active === document.body) {
        invoker.focus();
      }
    };
  }, [open, panelRef, initialFocus]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      // Stopped so an Escape meant for a popover inside a dialog does not also
      // close the dialog underneath it.
      event.stopPropagation();
      onDismiss();
      return;
    }

    if (!trap || event.key !== "Tab") {
      return;
    }

    const panel = panelRef.current;
    if (panel === null) {
      return;
    }

    const items = tabbableWithin(panel);
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      // Nothing to move to: hold focus on the panel rather than let it walk out
      // into a page the scrim says is unavailable.
      event.preventDefault();
      panel.focus();
      return;
    }

    const active = document.activeElement;
    const inside = active !== null && panel.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  return { onKeyDown };
}

/**
 * Motion: 150 ms ease-out on entry, and `prefers-reduced-motion` keeps the end
 * state rather than replacing it with a different one.
 *
 * The start state is scoped to `motion-safe:`, so a reduced-motion viewer is
 * never at `opacity-0` even for the frame before this runs. Written straight to
 * the DOM instead of held in state: a transition needs one painted frame in the
 * start state, and a state flip on a frame timer would drag every consumer's
 * test into `act()` warnings over something no assertion will ever read.
 */
function useEnterTransition(open: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (!open || node === null) {
      return undefined;
    }

    const frame = requestAnimationFrame(() => {
      node.dataset.entered = "true";
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open, ref]);
}

const ENTER_CLASS =
  "motion-safe:opacity-0 motion-safe:transition-opacity motion-safe:duration-150 motion-safe:ease-out motion-safe:data-[entered=true]:opacity-100";

export type PopoverRole = "menu" | "dialog" | "listbox";

export interface PopoverTriggerProps {
  readonly ref: Ref<HTMLButtonElement>;
  readonly type: "button";
  readonly onClick: () => void;
  readonly "aria-expanded": boolean;
  readonly "aria-haspopup": PopoverRole;
}

export interface PopoverProps {
  /** Accessible name of the surface itself — already translated. */
  readonly label: string;
  /**
   * Two render props rather than plain children, and both earn their keep: the
   * trigger is an avatar here and an icon button there, so the component cannot
   * draw it; and a menu item has to be able to close the surface it lives in.
   */
  readonly trigger: (props: PopoverTriggerProps) => ReactNode;
  readonly children: (close: () => void) => ReactNode;
  readonly role?: PopoverRole;
  /** Which edge the panel lines up with. `end` for a right-hand toolbar control. */
  readonly align?: "start" | "end";
  /** Extra classes on the PANEL — width, padding, max-height. */
  readonly className?: string;
}

/**
 * An anchored, non-modal surface on `--e-1`.
 *
 * Not trapped and not scrimmed on purpose: a popover is a place you can leave.
 * It closes on Escape, on an outside pointer-down, and on the trigger being
 * pressed again — and the trigger carries `aria-expanded`, which is the only
 * thing telling a screen-reader user the surface exists at all.
 */
export function Popover({
  label,
  trigger,
  children,
  role = "dialog",
  align = "start",
  className,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const { onKeyDown } = useFocusLayer(open, {
    panelRef,
    trap: false,
    onDismiss: () => setOpen(false),
  });
  useEnterTransition(open, panelRef);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function onPointerDown(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      // The trigger toggles itself; closing here as well would make a second
      // press reopen it in the same tick.
      if (panelRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) {
        return;
      }
      setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [open]);

  return (
    // The wrapper carries the key handler so Escape works while focus is still
    // on the trigger, and `relative` is what the panel anchors against.
    <div className="relative inline-block" onKeyDown={onKeyDown}>
      {trigger({
        ref: triggerRef,
        type: "button",
        onClick: () => setOpen((current) => !current),
        "aria-expanded": open,
        "aria-haspopup": role,
      })}
      {!open ? null : (
        <div
          ref={panelRef}
          role={role}
          aria-label={label}
          tabIndex={-1}
          className={`absolute z-50 mt-1.5 min-w-[220px] rounded-[var(--r-card)] p-1 shadow-[var(--e-1)] nx-glass bg-[var(--glass-fill-strong)] focus:outline-none ${
            align === "end" ? "right-0" : "left-0"
          } ${ENTER_CLASS}${className === undefined ? "" : ` ${className}`}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export type DialogSurface = "opaque" | "glass";
export type DialogPlacement = "center" | "start";
/**
 * How wide a CENTRED dialog may grow.
 *
 * A width and not a `className`: the panel's `max-w` is set here, and a caller
 * passing a competing one would leave two arbitrary utilities in the same
 * layer to be resolved by source order — which is a coin toss, not a decision.
 */
export type DialogWidth = "regular" | "wide";

interface DialogBaseProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** `alertdialog` for a destructive confirmation; plain `dialog` otherwise. */
  readonly role?: "dialog" | "alertdialog";
  readonly surface?: DialogSurface;
  readonly placement?: DialogPlacement;
  /** Ignored for `start`: a side sheet's width is its placement. */
  readonly width?: DialogWidth;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** Extra classes on the PANEL. It carries no padding of its own by design. */
  readonly className?: string;
}

/**
 * Exactly one of `label` and `labelledBy`, enforced by the type: a modal
 * surface with no accessible name is announced as "dialog" and nothing else,
 * and the failure is invisible to everyone who can see the title.
 */
export type DialogProps = DialogBaseProps &
  (
    | { readonly label: string; readonly labelledBy?: undefined }
    | { readonly label?: undefined; readonly labelledBy: string }
  );

const DIALOG_CONTAINER_CLASS: Readonly<Record<DialogPlacement, string>> = {
  center: "items-center justify-center p-4",
  start: "items-stretch justify-start",
};

const DIALOG_PANEL_CLASS: Readonly<
  Record<DialogPlacement, Readonly<Record<DialogWidth, string>>>
> = {
  center: {
    regular: "max-h-full w-full max-w-[420px] overflow-y-auto rounded-[var(--r-sheet)]",
    // Wide enough to re-render a product page's two columns without pretending
    // to be the page. Still `w-full` below the cap, so a phone is unaffected.
    //
    // 1120 AND NOT 760, because Tailwind's `lg:` keys off the VIEWPORT, not the
    // container: a two-column storefront layout inside a 760px panel still
    // resolves to two columns on any desktop, and gives each of them 360px.
    wide: "max-h-full w-full max-w-[1120px] overflow-y-auto rounded-[var(--r-sheet)]",
  },
  start: {
    regular: "h-full w-[300px] max-w-[86vw] overflow-y-auto rounded-e-[var(--r-sheet)]",
    wide: "h-full w-[300px] max-w-[86vw] overflow-y-auto rounded-e-[var(--r-sheet)]",
  },
};

const DIALOG_SURFACE_CLASS: Readonly<Record<DialogSurface, string>> = {
  opaque: "bg-[var(--bg-grouped-secondary)]",
  // `.nx-glass` is the kit's one bespoke class and the single place the Reduce
  // Transparency swap lands. The utility raises its fill to the strong variant
  // — Tailwind's utilities layer beats the components layer — and both custom
  // properties are still swapped together under that media query.
  glass: "nx-glass bg-[var(--glass-fill-strong)]",
};

/**
 * A modal surface on `--e-2`, over a scrim.
 *
 * `aria-modal` is set here rather than taken from the caller: focus is trapped
 * and a scrim is painted, so any other value would be a lie told to the
 * accessibility tree. `role` IS the caller's, because "dialog" and
 * "alertdialog" differ in how urgently a screen reader interrupts, and only the
 * caller knows whether this is a form or a warning.
 *
 * Portalled to `document.body`: a fixed-position scrim rendered inside a
 * transformed or `overflow:hidden` ancestor is clipped to it, and the sidebar
 * and toolbar both establish exactly that kind of containing block.
 */
export function Dialog({
  open,
  onClose,
  children,
  role = "dialog",
  surface = "opaque",
  placement = "center",
  width = "regular",
  initialFocus,
  className,
  label,
  labelledBy,
}: DialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const { onKeyDown } = useFocusLayer(open, {
    panelRef,
    trap: true,
    onDismiss: onClose,
    ...(initialFocus === undefined ? {} : { initialFocus }),
  });
  useEnterTransition(open, containerRef);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    // The page behind a modal must not scroll: on a phone the sheet is the only
    // thing on screen, and a background that moves under it reads as a bug.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={containerRef}
      className={`fixed inset-0 z-50 flex bg-black/30 ${DIALOG_CONTAINER_CLASS[placement]} ${ENTER_CLASS}`}
      onMouseDown={(event) => {
        // Only a press that STARTS on the scrim dismisses. Reacting to the click
        // instead closes the dialog when a selection drag that began inside it
        // happens to end out here.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`shadow-[var(--e-2)] focus:outline-none ${DIALOG_PANEL_CLASS[placement][width]} ${
          DIALOG_SURFACE_CLASS[surface]
        }${className === undefined ? "" : ` ${className}`}`}
        {...(label === undefined ? {} : { "aria-label": label })}
        {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
