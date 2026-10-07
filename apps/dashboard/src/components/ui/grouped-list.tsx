import type { ReactNode } from "react";

import Link from "next/link";

import { SectionHeader } from "./card";
import { Icon, type IconName } from "./icon";

/**
 * The iOS inset grouped list: an uppercase section header, a white
 * `--r-card` card of rows, and a footnote under it carrying hint and error.
 *
 * It is the structural workhorse of the customer area — on a phone it IS the
 * screen, and on a desktop it is every label/value pair that would otherwise be
 * a hand-rolled `<dl>` with its own spacing. Three row kinds cover everything
 * drawn: `DisclosureRow` (a destination), `ValueRow` (a label/value pair) and
 * `ContentRow` (a two-line record — an order, a line item, a return).
 *
 * SEMANTICS ARE PER ROW, AND THEY ARE THE POINT. A row that NAVIGATES is a
 * `Link`, a row that ACTS is a `<button>`, and a row that only DISPLAYS is
 * neither. All three paint identically, so the correct one is never the
 * inconvenient one: there is no reason left to put an onClick on a div. Every
 * row takes `href` XOR `onClick` XOR nothing, enforced by the union below —
 * passing both is a compile error, because a row that is both a destination and
 * an action has no honest element.
 *
 * SEPARATORS ARE NOT BORDERS. A border sits on the box, so a full-bleed rule
 * runs under the leading icon and breaks the vertical line the text makes down
 * the list. Each row draws a 1px div inset to ITS OWN text origin, so a list
 * that mixes iconed and plain rows steps the rule in and out exactly as iOS
 * does. The inset is derived from the row's leading geometry — never a number
 * typed twice — which is why the leading slot is a fixed 28px box: one width to
 * derive from, and text origins that line up down the whole list.
 *
 * No `"use client"`: props in, markup out. `onClick` is attached only when a
 * caller passed one, so a row rendered by a SERVER component never puts a
 * function on a host element (React rejects that at render); a client parent
 * passing a handler pulls this module into its own bundle for free.
 */

/**
 * A grouped list cannot know its depth in the document outline, and guessing
 * produces a page whose heading levels skip — so the caller states it. Same
 * union as `card.tsx`'s, kept local because that one is not exported.
 */
type HeadingLevel = "h2" | "h3" | "h4";

/** Matches `SectionHeader`'s: comfortable is the iOS grouped header. */
type HeaderDensity = "comfortable" | "compact";

// ---------------------------------------------------------------------------
// Row behaviour — link XOR button XOR neither
// ---------------------------------------------------------------------------

interface RowLink {
  /** An app path. Renders the row as a `Link`, chevron and all. */
  readonly href: string;
  readonly onClick?: undefined;
}

interface RowButton {
  /** Renders the row as a `<button type="button">`. */
  readonly onClick: () => void;
  readonly href?: undefined;
}

interface RowStatic {
  readonly href?: undefined;
  readonly onClick?: undefined;
}

/**
 * The `?: undefined` arms are load-bearing, not decoration: without them
 * TypeScript's excess-property check accepts a property that exists in ANY
 * member of a union, so `{ href, onClick }` would satisfy `RowLink` and ship a
 * link with a swallowed handler.
 */
export type RowBehaviour = RowLink | RowButton | RowStatic;

/**
 * How far the row's separator is inset — the row's own text origin, computed
 * from what it puts before the text.
 *
 * Two values and not a pixel prop, because Tailwind reads class strings out of
 * the source at build time: `ml-[calc(var(--cell-px)+${n}px)]` is invisible to
 * the scanner and silently generates nothing.
 */
type RowInset = "text" | "leading";

const SEPARATOR_INSET: Readonly<Record<RowInset, string>> = {
  text: "ml-[var(--cell-px)]",
  // The 28px leading box plus the 12px gap that follows it. One arithmetic
  // site: change the box and this is the only other line that moves.
  leading: "ml-[calc(var(--cell-px)+40px)]",
};

/**
 * Padding, type and ink shared by all three rows.
 *
 * `--cell-px` rather than the drawn literal 16 so the horizontal padding and
 * the separator inset above cannot drift apart, and so a grouped list dropped
 * into the compact admin shell densifies with everything around it.
 */
const ROW_BASE = "w-full px-[var(--cell-px)] text-[var(--font-body)] text-[var(--label)]";

/**
 * THE FOCUS RING IS INSET HERE, AND ONLY HERE.
 *
 * The card is `overflow-hidden` — that is what clips the first and last rows to
 * `--r-card` — so the standard outer `0 0 0 4px` ring would be sliced off at
 * both edges of every row. An inset shadow paints inside the row's own box, so
 * the ring survives the clip at full weight. `focus-visible:outline-none` still
 * comes first: `globals.css` declares `:focus-visible` inside `@layer base`
 * precisely so this utility can win, and without it the platform outline paints
 * on top of the ring.
 *
 * Hover is `--bg-grouped`, the grey the card itself sits on: the row lifts off
 * the card by borrowing the page behind it, which is the only neutral wash in
 * the token set that is guaranteed to read against white.
 */
const ROW_INTERACTIVE =
  "hover:bg-[var(--bg-grouped)] active:bg-[var(--fill-tertiary)] focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_4px_var(--focus-ring)]";

interface RowShellProps {
  readonly children: ReactNode;
  /** Layout classes for the row's own box: the grid or flex it lays out with. */
  readonly layout: string;
  readonly inset: RowInset;
  readonly href?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly className?: string | undefined;
}

/**
 * The `<li>`, the correct element inside it, and the row's own separator.
 *
 * The separator is the LAST child of the `<li>` — see `LIST_CLASS` for the one
 * selector that hides it on the final row.
 */
function RowShell({ children, layout, inset, href, onClick, className }: RowShellProps) {
  const box = `${ROW_BASE} ${layout}${className === undefined ? "" : ` ${className}`}`;

  return (
    <li>
      {href !== undefined ? (
        <Link href={href} className={`${box} ${ROW_INTERACTIVE}`}>
          {children}
        </Link>
      ) : onClick === undefined ? (
        <div className={box}>{children}</div>
      ) : (
        // `text-left` because a <button> centres its text and these rows are
        // read as a column of labels, not as a stack of buttons.
        <button type="button" onClick={onClick} className={`${box} ${ROW_INTERACTIVE} text-left`}>
          {children}
        </button>
      )}
      <div aria-hidden="true" className={`h-px bg-[var(--separator)] ${SEPARATOR_INSET[inset]}`} />
    </li>
  );
}

/**
 * The chevron a disclosure row ends with. 18px in `--chevron`, which is a
 * lighter grey than any text tone — it is an affordance, not information, and
 * it must never compete with the value beside it.
 *
 * Decorative by default (`Icon` is `aria-hidden` unless titled), so the row's
 * accessible name stays exactly its label.
 */
function Chevron() {
  return <Icon name="chevron-right" size={18} className="text-[var(--chevron)]" />;
}

// ---------------------------------------------------------------------------
// GroupedList
// ---------------------------------------------------------------------------

/**
 * `role="list"` is NOT redundant here. Tailwind's preflight sets
 * `list-style: none` on every `ul`, and Safari + VoiceOver drop the list role
 * from an unstyled list — the fix is to say it out loud. `order-detail.test.tsx`
 * counts `listitem`s, and that count is the thing a screen-reader user hears as
 * "list, 3 items".
 *
 * No `--e-0` hairline, unlike `Card`: every grouped list in the artboards is
 * plain white on `--bg-grouped`, where the contrast IS the edge. A hairline on
 * top of that reads as a second, tighter card inside the first.
 *
 * The last selector is the one piece of cleverness in this file: each row draws
 * its own bottom separator, and the final row's is hidden from here rather than
 * from the row, because a row cannot know whether it is last. It targets the
 * separator by position — last div of the last item — which is exactly what it
 * is; the alternative, threading an `isLast` prop through `Children.map`, would
 * clone every child and break the moment a caller wraps one.
 */
const LIST_CLASS =
  "m-0 list-none overflow-hidden rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-0 [&>li:last-child>div:last-child]:hidden";

interface GroupedListBase {
  /** The rows. `DisclosureRow`, `ValueRow`, `ContentRow` — each renders its own `<li>`. */
  readonly children: ReactNode;
  /**
   * Required, and the anchor for everything this component names: the list is
   * `id`, its header `${id}-title`, its footnote `${id}-hint` and its error
   * `${id}-error`. The `-hint` / `-error` spelling is `field.tsx`'s, so a form
   * that mixes fields and grouped lists has one id scheme, not two.
   */
  readonly id: string;
  readonly headingAs?: HeadingLevel;
  readonly headerDensity?: HeaderDensity;
  /** Trailing slot of the header row. Ignored when there is no `label` to hang it on. */
  readonly action?: ReactNode;
  /**
   * Standing explanatory text under the card. Already translated; a node
   * because the drawn footnotes carry links ("Reenviar verificación").
   */
  readonly hint?: ReactNode;
  /**
   * A problem with the group as a whole — not with one row.
   *
   * Announced on appearance via `role="alert"`, and drawn ABOVE the hint
   * because that is the order the artboard draws it in: the error is what just
   * changed, the hint is standing text. `aria-describedby` then follows DOM
   * order, which is the same invariant `field.tsx` holds (there the hint is
   * drawn first, so there it is named first).
   */
  readonly error?: ReactNode;
  readonly className?: string;
}

/**
 * Exactly one of `label` (render the header) or `labelledBy` (point at a
 * heading the caller already rendered — a `<legend>`, say), or neither for an
 * unnamed group. Enforced as a union so both cannot be passed at once, which
 * would give the list two names and announce whichever the browser preferred.
 */
export type GroupedListProps = GroupedListBase &
  (
    | { readonly label: string; readonly labelledBy?: undefined }
    | { readonly labelledBy: string; readonly label?: undefined }
    | { readonly label?: undefined; readonly labelledBy?: undefined }
  );

export function GroupedList({
  children,
  id,
  label,
  labelledBy,
  headingAs,
  headerDensity,
  action,
  hint,
  error,
  className,
}: GroupedListProps) {
  const titleId = `${id}-title`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const nameId = label === undefined ? labelledBy : titleId;

  // Only ids that actually exist in the DOM may be referenced: a dangling
  // `aria-describedby` is silently ignored by some screen readers and read out
  // as nothing by others.
  const describedBy = [error === undefined ? null : errorId, hint === undefined ? null : hintId]
    .filter((entry): entry is string => entry !== null)
    .join(" ");

  return (
    <div className={className}>
      {label === undefined ? null : (
        <SectionHeader
          id={titleId}
          title={label}
          {...(headingAs === undefined ? {} : { as: headingAs })}
          {...(headerDensity === undefined ? {} : { density: headerDensity })}
          {...(action === undefined ? {} : { action })}
        />
      )}

      <ul
        id={id}
        role="list"
        className={LIST_CLASS}
        {...(nameId === undefined ? {} : { "aria-labelledby": nameId })}
        {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
      >
        {children}
      </ul>

      {error === undefined ? null : (
        <p
          id={errorId}
          role="alert"
          className="m-0 mt-1.5 flex gap-1.5 px-[var(--cell-px)] text-[13px] leading-[1.35] text-[var(--danger-text)]"
        >
          {/* Optically centred on the first line rather than the box: at 13px
              the glyph's own cap height sits a pixel high without it. */}
          <Icon name="circle-alert" size={14} className="mt-[2px]" />
          <span>{error}</span>
        </p>
      )}

      {hint === undefined ? null : (
        <p
          id={hintId}
          className="m-0 mt-1 px-[var(--cell-px)] text-[13px] leading-[1.35] text-[var(--label-secondary)]"
        >
          {hint}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DisclosureRow
// ---------------------------------------------------------------------------

/**
 * The tile's fill. White glyph on a saturated role colour — these are the
 * INDICATOR tones (`--accent`, `--success`, …), not the pale `*-fill` tints a
 * badge uses, because a 28px tile is a shape you recognise at a glance and a
 * wash would make it disappear into the card.
 */
export type TileTone = "accent" | "success" | "warning" | "danger" | "neutral";

const TILE_TONE: Readonly<Record<TileTone, string>> = {
  accent: "bg-[var(--accent)]",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
  neutral: "bg-[var(--neutral)]",
};

interface DisclosureRowBase {
  /** Already translated. Never an enum member, never a server-written message. */
  readonly label: string;
  /** Renders the 28px leading tile, and steps this row's separator in behind it. */
  readonly icon?: IconName;
  readonly iconTone?: TileTone;
  /**
   * Trailing detail: a count, a current value, a `Badge`. Secondary ink, so the
   * label stays the thing the eye lands on.
   */
  readonly value?: ReactNode;
  /**
   * Suppresses the chevron on an interactive row — for a row that toggles
   * something in place rather than disclosing a destination.
   *
   * A static row never draws one whatever this says: a chevron on a row that
   * goes nowhere is a promise the row cannot keep.
   */
  readonly chevron?: boolean;
  readonly className?: string;
}

export type DisclosureRowProps = DisclosureRowBase & RowBehaviour;

/**
 * A row that discloses something: a destination, a sheet, a picker.
 *
 * Label left, optional value right, chevron last — `min-h-[var(--row-h)]`, so
 * 44pt on the phone and touch-safe by construction.
 */
export function DisclosureRow({
  label,
  icon,
  iconTone = "accent",
  value,
  chevron = true,
  href,
  onClick,
  className,
}: DisclosureRowProps) {
  const interactive = href !== undefined || onClick !== undefined;

  return (
    <RowShell
      layout="flex min-h-[var(--row-h)] items-center gap-3 py-1.5"
      inset={icon === undefined ? "text" : "leading"}
      {...(href === undefined ? {} : { href })}
      {...(onClick === undefined ? {} : { onClick })}
      {...(className === undefined ? {} : { className })}
    >
      {icon === undefined ? null : (
        // The 7px radius is a literal: `--r-check` (4) is too tight for a 28px
        // square, and `--r-control` swings 6 → 10 with density while the tile
        // itself does not move.
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--label-on-accent)] ${TILE_TONE[iconTone]}`}
        >
          <Icon name={icon} size={16} />
        </span>
      )}

      <span className="min-w-0 flex-1">{label}</span>

      {value === undefined ? null : (
        // Same size as the label, distinguished by ink alone. The artboard
        // steps the phone value down 17 → 15, but the token layer has one body
        // rung and a hand-picked second size would be wrong in the compact
        // shell in the other direction. Recorded divergence.
        <span className="min-w-0 text-right tabular-nums text-[var(--label-secondary)]">{value}</span>
      )}

      {interactive && chevron ? <Chevron /> : null}
    </RowShell>
  );
}

// ---------------------------------------------------------------------------
// ValueRow
// ---------------------------------------------------------------------------

/**
 * Desktop and phone are two different label/value layouts, not one layout at
 * two sizes — which is why this is a prop and not a media query.
 *
 * `compact` is the desktop pair: a wide 140px label column with the value
 * pushed to the far edge, so a column of values right-aligns into one clean
 * edge down the card. `comfortable` is the phone pair: a tight 110px column
 * with the value LEFT-aligned right behind the label, because at 375px a
 * right-aligned value and its label are separated by half a screen of nothing.
 * The flip is part of the density definition, not a detail of it.
 */
export type RowDensity = "compact" | "comfortable";

interface ValueRowMetrics {
  readonly grid: string;
  readonly value: string;
}

const VALUE_DENSITY: Readonly<Record<RowDensity, ValueRowMetrics>> = {
  compact: { grid: "grid-cols-[140px_minmax(0,1fr)]", value: "justify-end text-right" },
  comfortable: { grid: "grid-cols-[110px_minmax(0,1fr)]", value: "justify-start text-left" },
};

interface ValueRowBase {
  /** Already translated. */
  readonly label: string;
  /**
   * A string, a `Badge`, a mono identifier, a money figure.
   *
   * `tabular-nums` is applied here rather than left to callers: this column is
   * where money and dates line up, and money in this system is the SANS face
   * with tabular figures — mono is for identifiers only.
   */
  readonly value: ReactNode;
  readonly density?: RowDensity;
  readonly className?: string;
}

export type ValueRowProps = ValueRowBase & RowBehaviour;

/**
 * A label/value pair.
 *
 * It accepts `href`/`onClick` like every other row — but a value row that
 * navigates is usually better said as a `DisclosureRow` with a `value`, which
 * gets the chevron that tells the customer it is a destination.
 */
export function ValueRow({ label, value, density = "comfortable", href, onClick, className }: ValueRowProps) {
  const metrics = VALUE_DENSITY[density];

  return (
    <RowShell
      layout={`grid min-h-[var(--row-h)] items-center gap-3 py-1.5 ${metrics.grid}`}
      // A value row has no leading slot: its label column IS the text origin,
      // so the rule always starts under the label.
      inset="text"
      {...(href === undefined ? {} : { href })}
      {...(onClick === undefined ? {} : { onClick })}
      {...(className === undefined ? {} : { className })}
    >
      <span className="min-w-0">{label}</span>
      <span className={`flex min-w-0 items-center gap-2 tabular-nums ${metrics.value}`}>{value}</span>
    </RowShell>
  );
}

// ---------------------------------------------------------------------------
// ContentRow
// ---------------------------------------------------------------------------

interface ContentRowBase {
  /**
   * The line that identifies the record — an order number, a product name.
   * Pass a `<span className="font-mono">` for an identifier; money and counts
   * are sans with tabular figures.
   */
  readonly title: ReactNode;
  /** The second line: a date, a summary, a SKU. Caption-sized and secondary. */
  readonly meta?: ReactNode;
  /**
   * A checkbox, a radio, a thumbnail. Centred in a fixed 28px box so every row
   * in the list shares one text origin — and so the separator has one number to
   * derive from whatever the caller puts here.
   */
  readonly leading?: ReactNode;
  /** The middle column: a `Badge`, a `Counter`. Third column when `trailing` is present too. */
  readonly aside?: ReactNode;
  /** The right-hand column: money, a quantity, an action. */
  readonly trailing?: ReactNode;
  /** See `DisclosureRow.chevron` — drawn only on an interactive row. */
  readonly chevron?: boolean;
  readonly className?: string;
}

export type ContentRowProps = ContentRowBase & RowBehaviour;

/**
 * A two-line record: an order in a list, a line item, a return.
 *
 * Taller than the other two — `--row-h` plus 12px, so 56pt on the phone exactly
 * as drawn and 42 in a compact shell, and one relationship rather than two
 * unrelated numbers.
 *
 * NOTHING IS TRUNCATED. The row's height is a MINIMUM, so a long address or a
 * three-item summary makes the row taller instead of losing its tail to an
 * ellipsis — which on a customer's own address is data loss dressed up as
 * layout. `min-w-0` keeps a long unbroken token from blowing the grid out
 * instead.
 */
export function ContentRow({
  title,
  meta,
  leading,
  aside,
  trailing,
  chevron = true,
  href,
  onClick,
  className,
}: ContentRowProps) {
  const interactive = href !== undefined || onClick !== undefined;

  return (
    <RowShell
      layout="flex min-h-[calc(var(--row-h)+12px)] items-center gap-4 py-2.5"
      inset={leading === undefined ? "text" : "leading"}
      {...(href === undefined ? {} : { href })}
      {...(onClick === undefined ? {} : { onClick })}
      {...(className === undefined ? {} : { className })}
    >
      {leading === undefined ? null : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">{leading}</span>
      )}

      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {meta === undefined ? null : (
          <span className="block text-[13px] leading-[1.35] text-[var(--label-secondary)]">{meta}</span>
        )}
      </span>

      {aside === undefined ? null : <span className="shrink-0">{aside}</span>}
      {trailing === undefined ? null : (
        <span className="shrink-0 tabular-nums text-[var(--label-secondary)]">{trailing}</span>
      )}

      {interactive && chevron ? <Chevron /> : null}
    </RowShell>
  );
}
