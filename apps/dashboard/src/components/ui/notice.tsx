import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { IconButton } from "./button";
import { Icon, type IconName } from "./icon";

/**
 * An inline notice — the pale bar that sits under a page header or at the top
 * of a form and says what just happened.
 *
 * FEEDBACK BELONGS IN THE INTERFACE, NOT IN A DIALOG. Everything this replaces
 * was a one-off: an amber `<div>` hand-rolled on the account overview, a red
 * panel in the sign-in form, a banner on the admin order page. Four tones, one
 * shape, one role split.
 *
 * THE BODY TEXT IS `--label` IN EVERY TONE. Tinting the words to match the fill
 * is the single most common way these turn illegible — `--danger-text` on
 * `--danger-fill` is a red-on-pink that passes AA on paper and fails on a
 * laptop at an angle. The tone lives in the fill and in the symbol, which is
 * also what keeps colour from being the only signal (WCAG 1.4.1): the glyph
 * differs per tone, so the notice survives greyscale.
 *
 * NO `"use client"`. There is no state and no browser API here; `dismiss`
 * carries a callback, which only a client component can supply, and React
 * pulls this module into that component's graph when it does. A
 * server-rendered page gets the far more common non-dismissible notice with no
 * JavaScript at all — the same arrangement `button.tsx` uses.
 */

export type NoticeTone = "success" | "warning" | "danger" | "progress";

/**
 * `page` sits under a header and owns the width; `inline` sits inside a form,
 * usually as a validation summary above the first field. Only the symbol
 * changes size — the fill, the type and the padding are shared, because a
 * notice that shrinks when it moves inside a card reads as a different
 * component rather than the same one in a smaller room.
 */
export type NoticePlacement = "page" | "inline";

interface ToneSpec {
  readonly fill: string;
  readonly symbol: IconName;
  readonly symbolInk: string;
  /** `loader-circle` is only honest while it is turning. */
  readonly spin: boolean;
  /**
   * `role="alert"` on failures ONLY.
   *
   * An assertive live region interrupts a screen reader mid-sentence. That is
   * right for "we could not sign you in" and wrong for "changes saved" — and
   * an assertive region that keeps arriving with good news is one people learn
   * to tune out, which costs exactly the failure it was reserved for.
   */
  readonly role: "alert" | "status";
}

const TONE: Readonly<Record<NoticeTone, ToneSpec>> = {
  success: {
    fill: "bg-[var(--success-fill)]",
    symbol: "circle-check",
    symbolInk: "text-[var(--success)]",
    spin: false,
    role: "status",
  },
  warning: {
    // `triangle-alert` is the default, but the drawn "your email is not
    // verified" notice uses `mail-warning` — the caution symbol carrying the
    // subject of the caution. That is what `icon` is for.
    fill: "bg-[var(--warning-fill)]",
    symbol: "triangle-alert",
    symbolInk: "text-[var(--warning)]",
    spin: false,
    role: "status",
  },
  danger: {
    fill: "bg-[var(--danger-fill)]",
    symbol: "circle-alert",
    symbolInk: "text-[var(--danger)]",
    spin: false,
    role: "alert",
  },
  progress: {
    fill: "bg-[var(--progress-fill)]",
    symbol: "loader-circle",
    symbolInk: "text-[var(--progress)]",
    spin: true,
    role: "status",
  },
};

const SYMBOL_SIZE: Readonly<Record<NoticePlacement, number>> = { page: 18, inline: 16 };

export interface NoticeDismiss {
  /** Accessible name for the close control, already translated ("Cerrar"). */
  readonly label: string;
  readonly onDismiss: () => void;
}

/**
 * Dismissal is ONE prop carrying both halves, not two optional ones.
 *
 * A close button with no accessible name is announced as "button", which is the
 * exact failure the whole kit is careful about; making the label a sibling
 * optional prop would let a caller ship that by omission. Bundling them means
 * the invariant is structural — there is no way to spell "dismissible without a
 * name" — without resorting to a discriminated union, which breaks the moment
 * somebody passes a handler that is conditionally `undefined`.
 */
export interface NoticeProps {
  readonly tone: NoticeTone;
  /** The body, already translated. */
  readonly children: ReactNode;
  /** A bold lead sentence, rendered inline ahead of the body, as drawn. */
  readonly title?: string;
  readonly placement?: NoticePlacement;
  /** Overrides the tone's symbol. Never changes the role or the fill. */
  readonly icon?: IconName;
  /**
   * An affordance inside the sentence — C1's "Reenviar el enlace". Rendered
   * INLINE after the body rather than on its own row, because in this shape it
   * is part of the sentence and a button on a second line reads as a different
   * decision.
   */
  readonly action?: ReactNode;
  /** Quotable to support. Rendered as a mono reference line under the body. */
  readonly requestId?: string;
  readonly dismiss?: NoticeDismiss;
  readonly className?: string;
}

export function Notice({
  tone,
  children,
  title,
  placement = "page",
  icon,
  action,
  requestId,
  dismiss,
  className,
}: NoticeProps) {
  const t = useTranslations("errors");
  const spec = TONE[tone];

  return (
    <div
      role={spec.role}
      className={`flex items-start gap-2.5 rounded-[var(--r-card)] px-3 py-2.5 text-[13px] text-[var(--label)] ${spec.fill}${
        className === undefined ? "" : ` ${className}`
      }`}
    >
      <Icon
        name={icon ?? spec.symbol}
        size={SYMBOL_SIZE[placement]}
        // The 16px symbol needs a pixel of lead to sit on the 13px text's
        // cap-height; the 18px one already does.
        className={`${spec.symbolInk}${spec.spin ? " animate-spin" : ""}${
          placement === "inline" ? " mt-px" : ""
        }`}
      />
      <div className="flex-1">
        {title === undefined ? null : <b className="font-semibold">{title}</b>}
        {title === undefined ? null : " "}
        {children}
        {action === undefined ? null : " "}
        {action}
        {requestId === undefined || requestId === "" ? null : (
          <span className="mt-[3px] block font-mono text-[11px] text-[var(--label-secondary)]">
            {t("requestId", { id: requestId })}
          </span>
        )}
      </div>
      {dismiss === undefined ? null : (
        // 24px against the drawn 22: the kit's smallest square, so the close on
        // a notice is the same target as the close everywhere else. The
        // negative margins pull it back onto the drawn optical alignment
        // without shrinking the hit area.
        <IconButton
          label={dismiss.label}
          icon="x"
          size="mini"
          variant="plain"
          onClick={dismiss.onDismiss}
          className="-mt-0.5 -mr-1"
        />
      )}
    </div>
  );
}
