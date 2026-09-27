import type { MouseEvent, ReactNode, Ref } from "react";

import { Icon, type IconName } from "./icon";

/**
 * The push-button set.
 *
 * FIVE STYLES, AND THE COUNT IS THE POINT. `prominent` is the one thing the
 * view is for — one or two per screen, never a row of them; `standard` is
 * everything else that acts; `plain` is a control with no chrome, for the
 * "Ver todos" that sits beside a heading; and the two destructive roles are the
 * same shapes wearing the danger ramp. A sixth style is almost always a
 * `prominent` somebody did not want to spend.
 *
 * THE FOCUS RING IS ALWAYS THE ACCENT, INCLUDING ON BOTH DESTRUCTIVE ROLES. A
 * red ring on a red button is invisible, and a focus ring that changes colour
 * per control teaches a keyboard user to re-learn "where am I?" on every
 * screen. Every style therefore sets `focus-visible:outline-none` BEFORE
 * painting its own `--focus-ring` shadow: the base `:focus-visible` rule now
 * lives inside `@layer base`, so a utility wins — but only if it is actually
 * emitted, which is why the redundant-looking `outline-none` is on every
 * variant and is asserted in the test.
 *
 * WHY THERE IS NO `as` / `href` PROP. A link that looks like a button must
 * still be a link — right-click, middle-click, "open in new tab" and the
 * screen reader's link rotor all hang off the element, not the paint. But this
 * app's links must come from `@/i18n/navigation` or they drop the locale
 * prefix, and a polymorphic Button would have to import that Link and re-export
 * its whole prop surface. So the styling is exported as a plain function
 * instead: `<Link className={buttonClassName({ variant: "prominent" })}>`.
 * `role="link"` survives, and nothing here has to know about routing.
 *
 * COPY RULE (not enforceable here, so it is written down here): a button label
 * takes a trailing ellipsis when pressing it opens ANOTHER view rather than
 * doing the thing — "Eliminar…" opens a confirmation, "Eliminar" deletes.
 *
 * No `"use client"`: this file holds no state, no effects and no browser API.
 * It renders inside server components, and the `onClick` closure is attached to
 * the DOM node only when a caller actually passed one (see `Button`).
 */

export type ButtonVariant =
  | "prominent"
  | "standard"
  | "plain"
  | "destructive"
  | "destructivePlain";

/**
 * The three drawn sizes: 28 / 36 / 44.
 *
 * Deliberately NOT `--control-h`, which is the DENSITY ladder and moves 28 ↔ 44
 * with the shell's `data-density`. Height here is a call-site decision — a
 * toolbar button is 28 whatever the page density, and a sheet footer's button
 * is 44 so it clears the 44px touch minimum. The corner radius is the opposite
 * kind of property: it is shape shared with the fields and cards beside it, so
 * it DOES come from the token and DOES follow density.
 */
export type ButtonSize = "compact" | "comfortable" | "mobile";

interface VariantSpec {
  /** Fills, shadows, hover/pressed backgrounds and the focus ring. */
  readonly surface: string;
  /** Text colour, idle and pressed. */
  readonly ink: string;
  /**
   * Text colour when the glyph IS the control.
   *
   * Only `plain` differs, and it matters: a plain TEXT button is accent blue
   * ("Ver todos" reads as a place to go), but a table row of blue glyphs reads
   * as a row of links, so an icon-only plain button is drawn in secondary
   * label grey. Kept as a separate field rather than a second `text-*` utility
   * appended to `ink`, because two colour utilities at equal specificity are
   * resolved by stylesheet order, which is not something a component may bet on.
   */
  readonly iconInk: string;
  /** The complete disabled paint. Replaces `surface` + `ink`, never layered. */
  readonly disabled: string;
  /** Spinner track and its leading edge — the edge matches the label colour. */
  readonly spinner: string;
  /**
   * `tight` pulls the horizontal padding in one step. Only `plain` takes it:
   * with no fill, the label itself is the visible edge, so the drawn 12px would
   * read as a gap rather than as padding.
   */
  readonly inset: "regular" | "tight";
}

/**
 * Exhaustive by construction. A sixth variant is a compile error until every
 * one of its six states has been decided, which is the cheapest guard against a
 * button that is unstyled in exactly one state nobody screenshotted.
 *
 * ON THE RAW `rgba()` VALUES BELOW. Every colour here is a token; the four
 * literals are all SHADOWS, and the token layer declares only `--e-0/1/2` and
 * `--ring-control`, none of which is the button's 1px lift or its inset white
 * gloss. They are neutral alphas over whatever fill is underneath — never a
 * palette value — and tokenising them would mean editing globals.css, which is
 * out of this change's bounds.
 */
const VARIANT: Readonly<Record<ButtonVariant, VariantSpec>> = {
  prominent: {
    surface:
      "bg-[var(--accent)] shadow-[inset_0_1px_0_rgba(255,255,255,.18),0_1px_1px_rgba(0,0,0,.1)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-pressed)] active:shadow-none focus-visible:outline-none focus-visible:shadow-[inset_0_1px_0_rgba(255,255,255,.18),0_0_0_4px_var(--focus-ring)]",
    ink: "text-[var(--label-on-accent)]",
    iconInk: "text-[var(--label-on-accent)]",
    disabled:
      "bg-[var(--fill-tertiary)] text-[var(--label-tertiary)] shadow-none cursor-not-allowed",
    spinner: "border-[rgba(255,255,255,.35)] border-t-[var(--label-on-accent)]",
    inset: "regular",
  },
  standard: {
    surface:
      "bg-[var(--bg-grouped-secondary)] shadow-[var(--ring-control)] hover:bg-[var(--bg-grouped)] active:bg-[var(--fill-tertiary)] focus-visible:outline-none focus-visible:shadow-[var(--ring-control),0_0_0_4px_var(--focus-ring)]",
    ink: "text-[var(--label)]",
    iconInk: "text-[var(--label)]",
    disabled:
      "bg-[var(--bg-grouped-secondary)] text-[var(--label-tertiary)] shadow-[0_0_0_1px_rgba(0,0,0,.08)] cursor-not-allowed",
    spinner: "border-[var(--fill-tertiary)] border-t-[var(--label-secondary)]",
    inset: "regular",
  },
  plain: {
    surface:
      "bg-transparent hover:bg-[var(--fill-tertiary)] active:bg-[var(--fill-quaternary)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]",
    ink: "text-[var(--accent)] active:text-[var(--accent-pressed)]",
    iconInk: "text-[var(--label-secondary)]",
    disabled: "bg-transparent text-[var(--label-tertiary)] cursor-not-allowed",
    spinner: "border-[var(--fill-tertiary)] border-t-[var(--accent)]",
    inset: "tight",
  },
  destructive: {
    // `--danger-text`, not `--danger`, is the fill. `--danger` (#ff3b30) is the
    // indicator dot's red and does not carry white text at AA; `--danger-text`
    // is the AA-passing red that `--danger-hover` and `--danger-pressed` are
    // the hover and pressed steps OF. The name reads oddly on a background;
    // the alternative was a second declaration of the same colour.
    surface:
      "bg-[var(--danger-text)] shadow-[inset_0_1px_0_rgba(255,255,255,.18),0_1px_1px_rgba(0,0,0,.1)] hover:bg-[var(--danger-hover)] active:bg-[var(--danger-pressed)] active:shadow-none focus-visible:outline-none focus-visible:shadow-[inset_0_1px_0_rgba(255,255,255,.18),0_0_0_4px_var(--focus-ring)]",
    ink: "text-[var(--label-on-accent)]",
    iconInk: "text-[var(--label-on-accent)]",
    // Identical to `prominent`: a disabled destructive button is not dangerous,
    // and keeping it red would be the loudest thing on a screen where nothing
    // is happening.
    disabled:
      "bg-[var(--fill-tertiary)] text-[var(--label-tertiary)] shadow-none cursor-not-allowed",
    spinner: "border-[rgba(255,255,255,.35)] border-t-[var(--label-on-accent)]",
    inset: "regular",
  },
  destructivePlain: {
    // Shaped like `standard` — white fill, hairline ring — and only the ink and
    // the hover/pressed tints are danger. That is what makes "Eliminar…" safe
    // to put beside "Cancelar": it is legible as destructive without competing
    // with the prominent button for the eye.
    surface:
      "bg-[var(--bg-grouped-secondary)] shadow-[var(--ring-control)] hover:bg-[var(--danger-fill)] active:bg-[var(--danger-fill-pressed)] focus-visible:outline-none focus-visible:shadow-[var(--ring-control),0_0_0_4px_var(--focus-ring)]",
    ink: "text-[var(--danger-text)] active:text-[var(--danger-pressed)]",
    iconInk: "text-[var(--danger-text)] active:text-[var(--danger-pressed)]",
    disabled:
      "bg-[var(--bg-grouped-secondary)] text-[var(--label-tertiary)] shadow-[0_0_0_1px_rgba(0,0,0,.08)] cursor-not-allowed",
    spinner: "border-[var(--danger-fill)] border-t-[var(--danger-text)]",
    inset: "regular",
  },
};

interface SizeSpec {
  /** Height and type ramp. Mobile steps up to semibold, as drawn. */
  readonly frame: string;
  readonly radius: string;
  readonly px: string;
  readonly pxTight: string;
  /**
   * A leading glyph is optically lighter than a letter, so the padding goes
   * asymmetric — in on the icon side, out on the label side — rather than
   * leaving the label looking crowded against the right edge.
   */
  readonly pxIcon: string;
  readonly pxTightIcon: string;
  /** Edge of a leading glyph, in px. */
  readonly glyph: number;
}

/**
 * The type ramp is literal (13 / 15 / 17) rather than `--font-body`, which only
 * has two rungs and would collapse `comfortable` onto one of its neighbours.
 *
 * `compact` and `comfortable` take `--r-control`; `mobile` takes `--r-card`.
 * The artboard draws 6 / 8 / 10, and there is no 8px token — but `--r-control`
 * resolves to 6 in a compact shell and 10 in a comfortable one, which brackets
 * the drawn 8 and, more usefully, keeps the button concentric with the field
 * standing next to it at any density. A sheet-footer button is drawn at 10
 * whatever surrounds it, so `mobile` pins `--r-card`.
 */
const SIZE: Readonly<Record<ButtonSize, SizeSpec>> = {
  compact: {
    frame: "h-7 text-[13px] font-medium",
    radius: "rounded-[var(--r-control)]",
    px: "px-3",
    pxTight: "px-2",
    pxIcon: "pl-2 pr-2.5",
    pxTightIcon: "pl-1.5 pr-2",
    glyph: 14,
  },
  comfortable: {
    frame: "h-9 text-[15px] font-medium",
    radius: "rounded-[var(--r-control)]",
    px: "px-4",
    pxTight: "px-3",
    pxIcon: "pl-3 pr-3.5",
    pxTightIcon: "pl-2.5 pr-3",
    glyph: 16,
  },
  mobile: {
    frame: "h-11 text-[17px] font-semibold",
    radius: "rounded-[var(--r-card)]",
    px: "px-5",
    pxTight: "px-4",
    pxIcon: "pl-4 pr-[18px]",
    pxTightIcon: "pl-3.5 pr-4",
    glyph: 18,
  },
};

/**
 * `gap-1.5` is the icon-to-label gap; the pending row overrides it to `gap-2`
 * on its own wrapper. `whitespace-nowrap` because a button that wraps to two
 * lines has already broken the row it is in, and the fix belongs in the copy.
 */
const BASE =
  "inline-flex select-none items-center justify-center gap-1.5 border-0 align-middle whitespace-nowrap transition-colors";

export interface ButtonClassNameOptions {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Paints the disabled state. On a `<Link>`, do not render the link instead. */
  readonly disabled?: boolean;
  /**
   * Fills the container. For a sheet footer or an auth card — the mobile button
   * is drawn full-width there and NOWHERE else. Stretched across a wide layout
   * it stops reading as a button at all.
   */
  readonly block?: boolean;
  /** Only adjusts padding; the caller still renders the glyph itself. */
  readonly leadingIcon?: boolean;
  readonly className?: string;
}

/**
 * The button paint as a plain class string.
 *
 * Exists so a `<Link>` from `@/i18n/navigation` can look like a button while
 * staying a link — `reset-password-form` and `verify-email-panel` are exactly
 * that shape, and today they reach for the legacy `.btn .btn--primary` classes.
 * Also the seam any future host element uses; `Button` itself is a thin caller.
 */
export function buttonClassName(options: ButtonClassNameOptions = {}): string {
  const {
    variant = "standard",
    size = "compact",
    disabled = false,
    block = false,
    leadingIcon = false,
    className,
  } = options;

  const spec = VARIANT[variant];
  const sizing = SIZE[size];
  const tight = spec.inset === "tight";
  const padding = leadingIcon
    ? tight
      ? sizing.pxTightIcon
      : sizing.pxIcon
    : tight
      ? sizing.pxTight
      : sizing.px;

  return [
    BASE,
    sizing.frame,
    sizing.radius,
    padding,
    // Width comes from content or from the container — never from a literal.
    // A fixed width is how a translated label ends up clipped in one locale.
    block ? "w-full" : "",
    disabled ? spec.disabled : `${spec.surface} ${spec.ink}`,
    className ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  /**
   * Defaults to `compact` (28): it is what the admin surface is drawn at, and
   * it is the majority of every artboard. Phone-facing surfaces MUST pass
   * `mobile` — 28px is well under the 44px touch minimum.
   */
  readonly size?: ButtonSize;
  /**
   * Defaults to `"button"`, not the HTML default of `"submit"`. A button placed
   * in a form to open a dialog and silently submitting it instead is a bug that
   * only shows up on the one screen that has a form.
   */
  readonly type?: "button" | "submit" | "reset";
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly disabled?: boolean;
  /**
   * The action is in flight. Sets `aria-busy`, swaps the label for
   * `pendingLabel`, and swallows further clicks — see `Button` for why it does
   * NOT disable the element.
   */
  readonly pending?: boolean;
  /** Already translated, and phrased as the verb in progress ("Guardando…"). */
  readonly pendingLabel?: string;
  readonly icon?: IconName;
  readonly block?: boolean;
  readonly className?: string;
  readonly id?: string;
  /** Submits a form this button sits outside of. */
  readonly form?: string;
  readonly name?: string;
  readonly value?: string;
  readonly ref?: Ref<HTMLButtonElement>;
  readonly "aria-expanded"?: boolean;
  readonly "aria-haspopup"?: boolean | "menu" | "listbox" | "tree" | "grid" | "dialog";
  readonly "aria-controls"?: string;
  readonly "aria-describedby"?: string;
}

/**
 * A push button.
 *
 * PENDING DOES NOT DISABLE. Disabling the element the user just pressed drops
 * focus to `<body>`, and a screen-reader user loses their place in the form at
 * the exact moment the app has something to tell them. So the button stays
 * enabled and focusable, announces itself with `aria-busy`, and blocks the
 * second press by calling `preventDefault()` — which is also what actually
 * stops a `type="submit"` button from submitting twice; returning early from
 * the handler alone would not.
 *
 * PENDING ALSO HOLDS ITS WIDTH. "Guardar Cambios" → "Guardando…" is narrower,
 * and a toolbar that reflows the moment you press it moves every button beside
 * the one you are looking at. The resting content is therefore kept in the DOM
 * as an invisible, `aria-hidden` layer stacked in the same grid cell, so the
 * intrinsic width is max(resting, pending). That is a floor, not a fixed width
 * — nothing here ever writes a px width.
 */
export function Button({
  children,
  variant = "standard",
  size = "compact",
  type = "button",
  onClick,
  disabled = false,
  pending = false,
  pendingLabel,
  icon,
  block = false,
  className,
  id,
  form,
  name,
  value,
  ref,
  "aria-expanded": ariaExpanded,
  "aria-haspopup": ariaHasPopup,
  "aria-controls": ariaControls,
  "aria-describedby": ariaDescribedBy,
}: ButtonProps) {
  const spec = VARIANT[variant];
  const sizing = SIZE[size];

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  const resting = (
    <>
      {icon === undefined ? null : <Icon name={icon} size={sizing.glyph} />}
      {children}
    </>
  );

  return (
    <button
      type={type}
      disabled={disabled}
      className={buttonClassName({
        variant,
        size,
        disabled,
        block,
        leadingIcon: icon !== undefined,
        ...(className === undefined ? {} : { className }),
      })}
      // Attached only when there is something to attach. A Button rendered by a
      // SERVER component with no handler must not put a function on a host
      // element — React rejects that at render, and a decorative or
      // form-submitting button in a server-rendered page is a real case.
      {...(onClick === undefined && !pending ? {} : { onClick: handleClick })}
      {...(pending ? { "aria-busy": true } : {})}
      {...(id === undefined ? {} : { id })}
      {...(form === undefined ? {} : { form })}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...(ref === undefined ? {} : { ref })}
      {...(ariaExpanded === undefined ? {} : { "aria-expanded": ariaExpanded })}
      {...(ariaHasPopup === undefined ? {} : { "aria-haspopup": ariaHasPopup })}
      {...(ariaControls === undefined ? {} : { "aria-controls": ariaControls })}
      {...(ariaDescribedBy === undefined ? {} : { "aria-describedby": ariaDescribedBy })}
    >
      {pending ? (
        <span className="grid items-center">
          <span aria-hidden className="invisible col-start-1 row-start-1 flex items-center gap-1.5">
            {resting}
          </span>
          <span className="col-start-1 row-start-1 flex items-center justify-center gap-2">
            <Spinner className={spec.spinner} />
            {/* Falls back to the resting label rather than going blank when a
                caller wires `pending` without a `pendingLabel`. The spinner and
                `aria-busy` still carry the state. */}
            {pendingLabel === undefined ? children : pendingLabel}
          </span>
        </span>
      ) : (
        resting
      )}
    </button>
  );
}

/** 24px joins the ladder for a table row's action column. */
export type IconButtonSize = ButtonSize | "mini";

interface IconSizeSpec {
  readonly frame: string;
  readonly radius: string;
  readonly glyph: number;
}

/**
 * Square, so the frame is one utility. `mini` (24) and `compact` (28) are the
 * two the kit draws; `comfortable` and `mobile` come free off the shared ladder
 * and the customer screens do use a 44px share control, so restricting the
 * union would only have forced a fork.
 */
const ICON_SIZE: Readonly<Record<IconButtonSize, IconSizeSpec>> = {
  mini: { frame: "size-6", radius: "rounded-[var(--r-control)]", glyph: 14 },
  compact: { frame: "size-7", radius: "rounded-[var(--r-control)]", glyph: 16 },
  comfortable: { frame: "size-9", radius: "rounded-[var(--r-control)]", glyph: 18 },
  mobile: { frame: "size-11", radius: "rounded-[var(--r-card)]", glyph: 20 },
};

export interface IconButtonProps {
  /**
   * REQUIRED, and the whole reason this is a separate component: an icon-only
   * control has no accessible name unless someone gives it one, and "unlabelled
   * button" is what a screen reader reads out otherwise. It becomes both the
   * `aria-label` and the visible tooltip, so the two can never disagree.
   * Already translated.
   */
  readonly label: string;
  readonly icon: IconName;
  /**
   * Defaults to `plain` — unlike `Button`. The dominant icon-only control in
   * this product is a row action, and thirty white ringed squares down the
   * right edge of a table is chrome, not affordance.
   */
  readonly variant?: ButtonVariant;
  readonly size?: IconButtonSize;
  readonly type?: "button" | "submit" | "reset";
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly className?: string;
  readonly id?: string;
  readonly ref?: Ref<HTMLButtonElement>;
  readonly "aria-expanded"?: boolean;
  readonly "aria-haspopup"?: boolean | "menu" | "listbox" | "tree" | "grid" | "dialog";
  readonly "aria-controls"?: string;
}

/**
 * A square, icon-only button with a tooltip.
 *
 * The tooltip is CSS-only — a sibling revealed by `group-hover` and
 * `group-focus-within` — which is what keeps this a server component and keeps
 * a fifty-row table from mounting fifty pieces of hover state. It is
 * `aria-hidden`: the button's own `aria-label` already says the same words, and
 * an exposed tooltip would have every one of those rows announce twice.
 */
export function IconButton({
  label,
  icon,
  variant = "plain",
  size = "compact",
  type = "button",
  onClick,
  disabled = false,
  pending = false,
  className,
  id,
  ref,
  "aria-expanded": ariaExpanded,
  "aria-haspopup": ariaHasPopup,
  "aria-controls": ariaControls,
}: IconButtonProps) {
  const spec = VARIANT[variant];
  const sizing = ICON_SIZE[size];

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  const paint = disabled ? spec.disabled : `${spec.surface} ${spec.iconInk}`;

  return (
    <span className="group relative inline-flex">
      <button
        type={type}
        aria-label={label}
        disabled={disabled}
        className={`${BASE} ${sizing.frame} ${sizing.radius} ${paint}${
          className === undefined ? "" : ` ${className}`
        }`}
        {...(onClick === undefined && !pending ? {} : { onClick: handleClick })}
        {...(pending ? { "aria-busy": true } : {})}
        {...(id === undefined ? {} : { id })}
        {...(ref === undefined ? {} : { ref })}
        {...(ariaExpanded === undefined ? {} : { "aria-expanded": ariaExpanded })}
        {...(ariaHasPopup === undefined ? {} : { "aria-haspopup": ariaHasPopup })}
        {...(ariaControls === undefined ? {} : { "aria-controls": ariaControls })}
      >
        {pending ? <Spinner className={spec.spinner} /> : <Icon name={icon} size={sizing.glyph} />}
      </button>
      <span
        role="tooltip"
        aria-hidden
        className="pointer-events-none absolute top-[calc(100%+6px)] left-1/2 z-10 -translate-x-1/2 rounded-[var(--r-check)] bg-[var(--bg-grouped-secondary)] px-[7px] py-[3px] text-[11px] whitespace-nowrap text-[var(--label)] opacity-0 shadow-[var(--e-1)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

interface SpinnerProps {
  /** Track and leading-edge border colours, from the variant. */
  readonly className: string;
}

/**
 * 12px, and drawn as a circle with one coloured quadrant rather than as the
 * `loader-circle` glyph: a border can take two colours, so the leading edge
 * matches the label while the track sits back — the drawn behaviour — which a
 * single-stroke `currentColor` glyph cannot do.
 *
 * The reduced-motion blanket in globals.css clamps the animation to 0.01ms, so
 * this holds still for anyone who asked for that; `aria-busy` is what carries
 * the state either way.
 */
function Spinner({ className }: SpinnerProps) {
  return (
    <span
      aria-hidden
      className={`size-3 shrink-0 animate-spin rounded-full border-2 ${className}`}
    />
  );
}
