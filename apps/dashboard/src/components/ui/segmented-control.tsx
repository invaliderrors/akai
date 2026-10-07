import Link from "next/link";

/**
 * The macOS segmented control — as LINKS, not as a widget.
 *
 * WHY LINKS AND `aria-current` rather than a radiogroup, `aria-pressed`
 * toggles or a roving tabindex. Every segment here is a distinct URL: choosing
 * one navigates and the choice survives a reload, a share and the back button.
 * A radio or a pressed toggle would announce "you are changing a setting" for
 * something that is really "you are going somewhere", and both would need
 * client state — which would drag the filter row, and therefore the list it
 * filters, out of the server and into a hydration boundary for no gain.
 *
 * Links also need no key handling of their own: Tab reaches each one, Enter
 * follows it, and middle-click opens the filtered list in a new tab. A roving
 * tabindex would take two of those three away.
 */

/** The shape Next hands a server page in `searchParams`. */
export type SearchParamValue = string | readonly string[] | undefined;

export interface Segment {
  /** Written to the query param. `null` CLEARS it — the "Todos" segment. */
  readonly value: string | null;
  readonly label: string;
}

export interface SegmentHrefOptions {
  readonly pathname: string;
  readonly param: string;
  readonly value: string | null;
  /** Everything already in the URL. Unrelated params are carried across. */
  readonly searchParams?: Readonly<Record<string, SearchParamValue>>;
  /** Params dropped on every segment — see `resets` on the component. */
  readonly resets?: readonly string[];
}

/**
 * Builds one segment's href, preserving every query param the control does not
 * own.
 *
 * Exported and tested because the alternative is each filter row hand-rolling
 * `new URLSearchParams`, and the bug that produces is always the same one:
 * changing the status filter silently discards `limit`, or the sort, or the
 * search term the customer typed.
 */
export function segmentHref({
  pathname,
  param,
  value,
  searchParams = {},
  resets = [],
}: SegmentHrefOptions): string {
  const next = new URLSearchParams();

  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === param || resets.includes(key) || raw === undefined) {
      continue;
    }
    if (typeof raw === "string") {
      next.append(key, raw);
      continue;
    }
    for (const entry of raw) {
      next.append(key, entry);
    }
  }

  if (value !== null) {
    next.append(param, value);
  }

  const query = next.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

export interface SegmentedControlProps {
  /** Accessible name of the group — already translated. */
  readonly label: string;
  readonly segments: readonly Segment[];
  /** The param's current value, straight off `searchParams`. */
  readonly value: string | undefined;
  /** The route this control sits on, e.g. `/orders`. */
  readonly pathname: string;
  readonly param: string;
  readonly searchParams?: Readonly<Record<string, SearchParamValue>>;
  /**
   * Params to drop when a segment is followed. A cursor-paginated list MUST
   * pass its cursor param: a cursor is a position in one filtered result set
   * and means nothing in another, so carrying it across shows page four of a
   * list that now has one page.
   */
  readonly resets?: readonly string[];
  /** Segments share the width evenly. The phone shape; desktop hugs content. */
  readonly fullWidth?: boolean;
  readonly className?: string;
}

const SEGMENT_BASE =
  "inline-flex min-h-[var(--control-h)] items-center justify-center whitespace-nowrap rounded-[var(--r-control)] px-3 text-[13px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";

/**
 * The selected pill takes `--e-0` rather than the artboard's bespoke
 * `0 1px 2px`: the token layer declares exactly three elevations and a fourth,
 * undeclared one would be the first crack in that. Against the tertiary fill of
 * the track, the white surface plus a hairline separates just as cleanly.
 */
const SEGMENT_SELECTED =
  "bg-[var(--bg-grouped-secondary)] text-[var(--label)] shadow-[var(--e-0)]";

const SEGMENT_IDLE = "text-[var(--label-secondary)] hover:text-[var(--label)]";

export function SegmentedControl({
  label,
  segments,
  value,
  pathname,
  param,
  searchParams,
  resets,
  fullWidth = false,
  className,
}: SegmentedControlProps) {
  // An absent param and an empty one are the same thing — "no filter" — which
  // is the segment whose own value is null.
  const active = value === undefined || value === "" ? null : value;

  return (
    <nav
      aria-label={label}
      // The track's radius is the segment's plus its 2px inset: concentric
      // corners, so the pill sits in the groove instead of beside it. Both
      // follow `--r-control`, which density already moves from 6 to 10.
      className={`gap-[2px] rounded-[calc(var(--r-control)+2px)] bg-[var(--fill-tertiary)] p-[2px] ${
        fullWidth ? "flex w-full" : "inline-flex"
      }${className === undefined ? "" : ` ${className}`}`}
    >
      {segments.map((segment) => {
        const selected = segment.value === active;

        return (
          <Link
            key={segment.value ?? "*"}
            href={segmentHref({
              pathname,
              param,
              value: segment.value,
              ...(searchParams === undefined ? {} : { searchParams }),
              ...(resets === undefined ? {} : { resets }),
            })}
            className={`${SEGMENT_BASE} ${selected ? SEGMENT_SELECTED : SEGMENT_IDLE}${
              fullWidth ? " flex-1" : ""
            }`}
            {...(selected ? { "aria-current": "true" as const } : {})}
          >
            {segment.label}
          </Link>
        );
      })}
    </nav>
  );
}
