"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { IconButton } from "./button";
import { Icon, type IconName } from "./icon";

/**
 * Transient confirmation, bottom centre.
 *
 * THE ONE GLASS SURFACE IN THE CONTENT LAYER. Everything else the customer or
 * the operator reads is flat and opaque; a toast floats because it is over
 * content it does not belong to and will be gone in eight seconds. Under
 * Reduce Transparency `.nx-glass` swaps to solid white — one class, one landing
 * site, which is why the blur is not written inline here.
 *
 * A TOAST IS FOR SOMETHING THAT ALREADY HAPPENED AND CAN BE UNDONE. If the
 * reader has to act, or has to still be able to read it in a minute, it is a
 * `Notice` in the page — a toast that carries the only copy of an instruction
 * has thrown it away on a timer.
 */

/**
 * Dwell and undo window are ONE number, exported so copy can state it.
 *
 * "Imagen quitada. Se borra en 8 s." is only true if the toast and the
 * deletion it defers use the same constant. Two numbers that agree today is
 * how a message ends up promising a window that closed two seconds ago.
 */
export const TOAST_DWELL_MS = 8000;

/** Newest at the bottom; a fourth evicts the oldest. */
const MAX_VISIBLE = 3;

export type ToastTone = "success" | "warning" | "danger" | "progress";

export interface ToastAction {
  /** Already translated: "Deshacer", "Reintentar". */
  readonly label: string;
  readonly onAction: () => void;
}

export interface ToastOptions {
  readonly tone: ToastTone;
  /** Already translated, and short enough to read in one glance. */
  readonly message: string;
  /** Overrides the tone's symbol. */
  readonly icon?: IconName;
  /**
   * The undo (or retry). Pressing it runs the callback AND dismisses — the
   * toast is the acknowledgement of the thing it offered to reverse, so
   * leaving it up afterwards invites a second press against a window that has
   * already closed.
   */
  readonly action?: ToastAction;
}

export interface ToastController {
  /** Returns the id, so a long-running `progress` toast can be closed early. */
  readonly show: (toast: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
  /** `TOAST_DWELL_MS`, reachable without a second import at the call site. */
  readonly dwellMs: number;
}

const ToastContext = createContext<ToastController | null>(null);

/**
 * Throws outside the provider, deliberately.
 *
 * The alternative is a silent no-op `show()`, which fails as "the save worked
 * but said nothing" — a bug that reaches production because everything looks
 * fine. This message is a developer error and is never rendered to a user.
 */
export function useToast(): ToastController {
  const controller = useContext(ToastContext);
  if (controller === null) {
    throw new Error("useToast must be called inside a <ToastProvider>.");
  }
  return controller;
}

interface ToneSpec {
  readonly symbol: IconName;
  readonly ink: string;
  readonly spin: boolean;
}

/**
 * Symbol and ink only — a toast has no tone FILL, because it is glass over
 * whatever the page happens to be showing and a tinted pane over arbitrary
 * content is a different colour every time. The tone is carried by the glyph,
 * which also means it survives greyscale. Kept in step with `notice.tsx`'s map
 * by hand: four names is not worth coupling the two files over.
 */
const TONE: Readonly<Record<ToastTone, ToneSpec>> = {
  success: { symbol: "circle-check", ink: "text-[var(--success)]", spin: false },
  warning: { symbol: "triangle-alert", ink: "text-[var(--warning)]", spin: false },
  danger: { symbol: "circle-alert", ink: "text-[var(--danger)]", spin: false },
  progress: { symbol: "loader-circle", ink: "text-[var(--progress)]", spin: true },
};

/**
 * An error never leaves on its own.
 *
 * Everything else is a receipt the reader can afford to miss; a failure is the
 * one thing they cannot, and eight seconds is not long enough to notice a
 * failure, read it and decide. That is also why the danger toast is the only
 * one that draws a close button — it is the only one that needs a way out that
 * is not "retry".
 */
function autoDismisses(tone: ToastTone): boolean {
  return tone !== "danger";
}

interface ToastItem extends ToastOptions {
  readonly id: string;
}

export interface ToastProviderProps {
  readonly children: ReactNode;
  /**
   * Accessible name for the close control on a danger toast. Already
   * translated ("Cerrar").
   *
   * It lives on the PROVIDER rather than on each `show()` call because the
   * provider is what draws the button, and it is mounted once — asking every
   * call site for the word would mean the one toast that must be closable is
   * the one most likely to ship without a name for its close button.
   */
  readonly closeLabel: string;
}

export function ToastProvider({ children, closeLabel }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const [paused, setPaused] = useState(false);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((options: ToastOptions): string => {
    const id = `nx-toast-${String(nextId.current)}`;
    nextId.current += 1;
    // `slice(-MAX_VISIBLE)` keeps the newest three. A fourth arriving while
    // three are up means the oldest has been on screen longest and is the one
    // its reader has had the best chance to see.
    setToasts((current) => [...current, { ...options, id }].slice(-MAX_VISIBLE));
    return id;
  }, []);

  // Pressing "Deshacer" unmounts the toast under the pointer, and a node that
  // is removed never fires mouseleave — so without this the stack would stay
  // paused forever and the NEXT toast would never expire. Releasing the pause
  // when nothing is up costs nothing and closes that hole.
  useEffect(() => {
    if (toasts.length === 0 && paused) setPaused(false);
  }, [toasts.length, paused]);

  const controller = useMemo<ToastController>(
    () => ({ show, dismiss, dwellMs: TOAST_DWELL_MS }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={controller}>
      {children}
      {toasts.length === 0 ? null : (
        // The outer strip is `pointer-events-none` so it never swallows a click
        // aimed at the page; the inner column takes them back and is only as
        // wide as a toast, so the blocked area is exactly the visible one.
        //
        // NOT a landmark and NOT `aria-label`led: each toast is its own live
        // region, and a named region a user could tab to would be empty almost
        // all of the time.
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
          <div
            className="pointer-events-auto flex w-full max-w-[380px] flex-col gap-2"
            // Hover AND focus pause the WHOLE stack, not the one toast under
            // the pointer: a neighbour expiring while you reach for its
            // "Deshacer" moves the button out from under the cursor. `onFocus`
            // and `onBlur` bubble in React, so tabbing into any action counts.
            onMouseEnter={() => {
              setPaused(true);
            }}
            onMouseLeave={() => {
              setPaused(false);
            }}
            onFocus={() => {
              setPaused(true);
            }}
            onBlur={() => {
              setPaused(false);
            }}
          >
            {toasts.map((toast) => (
              <Toast
                key={toast.id}
                toast={toast}
                paused={paused}
                closeLabel={closeLabel}
                onDismiss={dismiss}
              />
            ))}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

interface ToastProps {
  readonly toast: ToastItem;
  readonly paused: boolean;
  readonly closeLabel: string;
  /** Stable across renders, or the dwell restarts on every parent render. */
  readonly onDismiss: (id: string) => void;
}

/**
 * One toast.
 *
 * THE DWELL RESUMES, IT DOES NOT RESTART. The remaining time is carried in a
 * ref and the effect's cleanup subtracts however long this run lasted, so
 * moving the pointer across the stack does not hand the reader a fresh eight
 * seconds each time — which would make the undo window unbounded and the copy
 * that states it a lie.
 */
function Toast({ toast, paused, closeLabel, onDismiss }: ToastProps) {
  const { id, tone, message, icon, action } = toast;
  const spec = TONE[tone];
  const expires = autoDismisses(tone);
  const remaining = useRef(TOAST_DWELL_MS);

  useEffect(() => {
    if (!expires || paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      onDismiss(id);
    }, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [expires, paused, id, onDismiss]);

  // 8/8/8/12 with a trailing control, 8/12 without: the control brings its own
  // optical inset, so keeping the 12 would leave the row looking lopsided.
  const padding = action === undefined && expires ? "px-3 py-2" : "py-2 pr-2 pl-3";

  return (
    <div
      role={expires ? "status" : "alert"}
      className={`nx-glass flex items-center gap-2.5 rounded-[var(--r-sheet)] bg-[var(--glass-fill-strong)] text-[13px] text-[var(--label)] shadow-[var(--e-1)] ${padding}`}
    >
      <Icon
        name={icon ?? spec.symbol}
        size={16}
        className={`${spec.ink}${spec.spin ? " animate-spin" : ""}`}
      />
      <span className="flex-1">{message}</span>
      {action === undefined ? null : (
        // Written out rather than composed from `Button`: the drawn control is
        // 24px at weight 600 and the shared ladder starts at 28 at weight 500.
        // Overriding a primitive's height and weight through `className` is
        // resolved by STYLESHEET order, not by the order of the class
        // attribute, so it is a coin flip rather than an override. The focus
        // contract is the kit's, spelled out in full: `outline-none` first, so
        // the base `:focus-visible` rule in `@layer base` cannot win, then the
        // 4px accent ring every other control paints.
        <button
          type="button"
          onClick={() => {
            action.onAction();
            onDismiss(id);
          }}
          className="inline-flex h-6 shrink-0 items-center rounded-[var(--r-control)] border-0 bg-transparent px-2.5 text-[13px] font-semibold whitespace-nowrap text-[var(--accent)] transition-colors hover:bg-[var(--fill-tertiary)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)] active:text-[var(--accent-pressed)]"
        >
          {action.label}
        </button>
      )}
      {expires ? null : (
        <IconButton
          label={closeLabel}
          icon="x"
          size="mini"
          variant="plain"
          onClick={() => {
            onDismiss(id);
          }}
        />
      )}
    </div>
  );
}
