import type { ReactNode } from "react";

/**
 * The content layer's grouping: a card, its internal rule, and the header that
 * names a group of them.
 *
 * ELEVATION IS THE POINT. A card carries `--e-0` — a 1px hairline and NO drop
 * shadow. Depth in this system comes from grouping and separators; only the
 * functional layer (popover, sheet, toolbar) floats, on `--e-1`/`--e-2`. A card
 * that reaches for a drop shadow reads as a menu somebody forgot to close.
 *
 * No `"use client"`: props in, markup out, so these render inside server
 * components. That is also why every id is a PROP rather than a `useId()` —
 * hooks do not run on the server, and the callers already own the ids they wire
 * `aria-labelledby` to (account-overview's `recent-orders-heading` and the five
 * siblings on order detail are pinned by tests).
 */

/**
 * A card cannot know its depth in the document outline, and guessing produces a
 * page whose heading levels skip — so the caller states it.
 */
type HeadingTag = "h2" | "h3" | "h4";

export interface CardProps {
  readonly children: ReactNode;
  /** Card title, set as Title 3 (15/20 semibold). */
  readonly title?: string;
  /**
   * Id placed on the title element. Supply it when something outside needs to
   * point at the title — the card itself then also names itself with it, so a
   * screen-reader user landing inside hears which group they are in.
   */
  readonly titleId?: string;
  readonly titleAs?: HeadingTag;
  /** Trailing slot of the title row. Sized for one `size="compact"` standard Button. */
  readonly action?: ReactNode;
  /**
   * Names the card when the heading lives OUTSIDE it — a `SectionHeader` above
   * a card is the iOS grouped-list shape, and the card must not repeat it.
   */
  readonly labelledBy?: string;
  /**
   * Edge-to-edge content. A table or a grouped list brings its own cell padding
   * and `--card-p` on top of it doubles the inset; taking the padding off and
   * putting `overflow-hidden` on is also what clips the first row's corners to
   * `--r-card`.
   */
  readonly flush?: boolean;
  readonly className?: string;
}

export function Card({
  children,
  title,
  titleId,
  titleAs = "h2",
  action,
  labelledBy,
  flush = false,
  className,
}: CardProps) {
  const Heading = titleAs;
  const nameId = labelledBy ?? (title === undefined ? undefined : titleId);

  return (
    <section
      className={`bg-[var(--bg-grouped-secondary)] rounded-[var(--r-card)] shadow-[var(--e-0)] ${
        flush ? "overflow-hidden" : "p-[var(--card-p)]"
      }${className === undefined ? "" : ` ${className}`}`}
      {...(nameId === undefined ? {} : { "aria-labelledby": nameId })}
    >
      {title === undefined ? null : (
        <div
          className={`flex items-center justify-between gap-3 ${
            // A flush card's content starts at the edge immediately below, so
            // the header pays for its own inset and closes with a hairline
            // rather than floating in whitespace.
            flush
              ? "border-b border-[var(--separator-weak)] px-[var(--card-p)] py-[var(--cell-py)]"
              : "mb-[var(--card-p)]"
          }`}
        >
          <Heading
            className="m-0 text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]"
            {...(titleId === undefined ? {} : { id: titleId })}
          >
            {title}
          </Heading>
          {action === undefined ? null : (
            <div className="flex shrink-0 items-center gap-2">{action}</div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A rule between two groups of rows inside one card.
 *
 * `--separator-weak`, never `--separator`: the strong separator is for the line
 * under a table head, where it has to survive against a filled header. Inside a
 * white card it reads as a border somebody drew by hand.
 *
 * `role="presentation"` because this divides content visually and announcing
 * "separator" between every pair of rows is noise a screen-reader user has to
 * skip past. A divider that carries meaning — "everything below this is
 * destructive" — belongs to a labelled group, not to this.
 */
export function CardDivider({ className }: { readonly className?: string }) {
  return (
    <hr
      role="presentation"
      className={`my-[var(--cell-py)] h-px border-0 bg-[var(--separator-weak)]${
        className === undefined ? "" : ` ${className}`
      }`}
    />
  );
}

/**
 * `comfortable` is the iOS grouped header — small, uppercase, secondary, and
 * indented by `--cell-px` so it lines up with the row text below rather than
 * with the card edge. `compact` is the macOS card title: Title 3, full ink, no
 * indent.
 *
 * This is a PROP and not a media query because the density switch is a
 * `data-density` attribute driving custom properties, and no custom property
 * can turn `text-transform` on. The two variants are structurally different
 * headers that happen to appear at different densities.
 */
export type SectionHeaderDensity = "comfortable" | "compact";

export interface SectionHeaderProps {
  /**
   * Required, and the reason this component exists: it is the id a parent
   * `<section aria-labelledby>` points at, which is how a group of cards gets
   * one accessible name instead of none.
   */
  readonly id: string;
  readonly title: string;
  readonly as?: HeadingTag;
  /** Defaults to comfortable, matching the bare-root density defaults. */
  readonly density?: SectionHeaderDensity;
  /** Trailing slot — a "view all" link or a small button. */
  readonly action?: ReactNode;
  readonly className?: string;
}

const HEADER_CLASS: Readonly<Record<SectionHeaderDensity, string>> = {
  comfortable: "ml-[var(--cell-px)] mb-1.5",
  compact: "mb-2",
};

const HEADER_TITLE_CLASS: Readonly<Record<SectionHeaderDensity, string>> = {
  comfortable: "text-[13px] leading-[18px] font-normal uppercase text-[var(--label-secondary)]",
  compact: "text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]",
};

export function SectionHeader({
  id,
  title,
  as = "h2",
  density = "comfortable",
  action,
  className,
}: SectionHeaderProps) {
  const Heading = as;

  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${HEADER_CLASS[density]}${
        className === undefined ? "" : ` ${className}`
      }`}
    >
      {/* The id sits on the HEADING, not on this row: `aria-labelledby`
          resolves to the text content of the element it names, and a row that
          also holds a "Ver todos" link would fold that link into the name. */}
      <Heading id={id} className={`m-0 ${HEADER_TITLE_CLASS[density]}`}>
        {title}
      </Heading>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}
