import Link from "next/link";

import { Icon, type IconName } from "./icon";
import { SegmentedControl, type SearchParamValue, type Segment } from "./segmented-control";

/**
 * Cursor pagination, told honestly.
 *
 * THE API CANNOT COUNT. Every list endpoint returns `{ items, nextCursor,
 * hasMore }` and nothing else — cursor pagination is stable under concurrent
 * writes precisely BECAUSE it never runs the `COUNT(*)` that would let us say
 * "page 3 of 17". So this control never says it. The summary states the range
 * it can actually derive and whether anything follows; the page label is the
 * depth of the cursor stack, not a position in a total.
 *
 * WHAT THIS REPLACES. A one-way "Next page" link, repeated across seven admin
 * lists. An operator three pages into the order list had exactly one way back:
 * the browser's own back button, and if they had reloaded or arrived from a
 * link, nothing at all. The stack lives in the URL as a REPEATED `cursor`
 * param, so back, forward, reload, share and open-in-new-tab all keep working
 * and the server component stays a server component — this renders anchors,
 * holds no state, and needs no hydration boundary.
 *
 * THE TYPE IMPORTED FROM `./segmented-control` is deliberate: `SearchParamValue`
 * is the shape Next hands a page in `searchParams`, and two spellings of it in
 * one directory is how a repeated param quietly becomes a single one.
 */

/** The `cursor` spelling every admin list already uses. */
const DEFAULT_CURSOR_PARAM = "cursor";

/**
 * The offered page sizes.
 *
 * FIXED, not a prop. `paginationQuerySchema` clamps `limit` to 1..100, so a
 * fourth, larger option would not be a bigger page — it would be a 400 from the
 * API with the operator's filters lost. 100 is the ceiling the contract allows.
 */
export const PAGE_SIZES: readonly number[] = [25, 50, 100];

const PAGE_SIZE_SEGMENTS: readonly Segment[] = PAGE_SIZES.map((size) => ({
  value: String(size),
  label: String(size),
}));

// ---------------------------------------------------------------------------
// The cursor stack
// ---------------------------------------------------------------------------

/**
 * Reads the cursor stack out of one `searchParams` value.
 *
 * Empty strings are dropped: `?cursor=` is what a stripped-down link or a
 * hand-edited URL leaves behind, and it means "no cursor", not "a cursor that
 * matches nothing".
 */
export function cursorStack(value: SearchParamValue): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return value === "" ? [] : [value];
  }
  return value.filter((entry) => entry !== "");
}

/**
 * The cursor the CURRENT page must be fetched with — the TOP of the stack.
 *
 * Exported because getting this wrong is silent and total. Every admin page
 * currently reads its cursor through a `single()` helper that returns the FIRST
 * element of a repeated param; against a stack that is always the cursor for
 * page two, so the operator walks forward and the list never changes.
 */
export function activeCursor(value: SearchParamValue): string | undefined {
  return cursorStack(value).at(-1);
}

export interface CursorStackOptions {
  /** Route the list lives on, e.g. `/admin/orders`. */
  readonly pathname: string;
  /** Everything already in the URL. Unrelated params are carried across. */
  readonly searchParams?: Readonly<Record<string, SearchParamValue>>;
  /** Defaults to `cursor`. */
  readonly param?: string;
}

export interface PushCursorOptions extends CursorStackOptions {
  /** `nextCursor` from the paginated envelope. */
  readonly cursor: string;
}

/**
 * These three build HREFS rather than mutating a stack, matching
 * `segmentHref()` next door. A caller that wants "next" outside this control —
 * an infinite-scroll sentinel, a keyboard shortcut — gets the same URL the
 * button would have produced instead of re-deriving it.
 */
export function pushCursor({
  pathname,
  searchParams = {},
  param = DEFAULT_CURSOR_PARAM,
  cursor,
}: PushCursorOptions): string {
  return hrefWithStack(pathname, searchParams, param, [
    ...cursorStack(searchParams[param]),
    cursor,
  ]);
}

export function popCursor({
  pathname,
  searchParams = {},
  param = DEFAULT_CURSOR_PARAM,
}: CursorStackOptions): string {
  return hrefWithStack(pathname, searchParams, param, cursorStack(searchParams[param]).slice(0, -1));
}

export function clearCursors({
  pathname,
  searchParams = {},
  param = DEFAULT_CURSOR_PARAM,
}: CursorStackOptions): string {
  return hrefWithStack(pathname, searchParams, param, []);
}

function hrefWithStack(
  pathname: string,
  searchParams: Readonly<Record<string, SearchParamValue>>,
  param: string,
  stack: readonly string[],
): string {
  const next = new URLSearchParams();

  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === param || raw === undefined) {
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

  // Appended last, and one entry per level: the stack IS the history, so
  // collapsing it to `set()` would strand the operator exactly where the old
  // one-way link did.
  for (const cursor of stack) {
    next.append(param, cursor);
  }

  const query = next.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

export interface PaginationRange {
  /** 1-based index of the first row on this page. */
  readonly from: number;
  /** 1-based index of the last row on this page. */
  readonly to: number;
  readonly hasMore: boolean;
}

/**
 * Already-translated copy.
 *
 * Props, not `useTranslations`, for the same reason the rest of the kit takes
 * them: these primitives are used by both areas and by server components, and a
 * primitive that reaches into a namespace makes that namespace a dependency of
 * every screen. `page` and `showing` are functions because their strings are
 * interpolated — the caller owns the ICU message and we hand it the numbers.
 */
export interface PaginationLabels {
  /** Accessible name of the back/forward group, e.g. "Paginación". */
  readonly nav: string;
  readonly first: string;
  readonly previous: string;
  readonly next: string;
  /** e.g. `(3) => "Página 3"`. */
  readonly page: (page: number) => string;
  /** Names the page-size group, e.g. "Por página". */
  readonly perPage: string;
  /** e.g. `({from,to,hasMore}) => "Mostrando 51–75 · hay más"`. */
  readonly showing: (range: PaginationRange) => string;
}

export interface CursorPaginationProps {
  readonly labels: PaginationLabels;
  /** Route the list lives on. */
  readonly pathname: string;
  readonly searchParams?: Readonly<Record<string, SearchParamValue>>;
  /** Rows on THIS page. `items.length` — the only count the API gives us. */
  readonly itemCount: number;
  /** The `limit` in force. Marks the page-size group and sizes the range. */
  readonly pageSize: number;
  readonly hasMore: boolean;
  /** From the paginated envelope. `null` means there is no next page. */
  readonly nextCursor: string | null;
  readonly cursorParam?: string;
  readonly limitParam?: string;
  readonly className?: string;
}

const CELL =
  "inline-flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center border-r border-[var(--separator-weak)] last:border-r-0 first:rounded-l-[var(--r-control)] last:rounded-r-[var(--r-control)] transition-colors motion-reduce:transition-none";

// The ring has to sit OUTSIDE the capsule, so the capsule cannot clip it: no
// `overflow-hidden` anywhere here, and the focused cell is lifted a layer so
// its ring paints over its neighbour's border rather than under it.
const CELL_IDLE =
  "text-[var(--label)] hover:bg-[var(--fill-tertiary)] focus-visible:outline-none focus-visible:relative focus-visible:z-10 focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";

const CELL_DISABLED = "text-[var(--label-tertiary)] cursor-default";

export function CursorPagination({
  labels,
  pathname,
  searchParams = {},
  itemCount,
  pageSize,
  hasMore,
  nextCursor,
  cursorParam = DEFAULT_CURSOR_PARAM,
  limitParam = "limit",
  className,
}: CursorPaginationProps) {
  const stack = cursorStack(searchParams[cursorParam]);
  const depth = stack.length;

  const options: CursorStackOptions = { pathname, searchParams, param: cursorParam };

  // The range is only honest because a page-size change RESETS the stack — see
  // `resets` below. Every page below this one was exactly `pageSize` long, so
  // the offset is arithmetic rather than a guess.
  const from = depth * pageSize + 1;
  const to = depth * pageSize + itemCount;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-[var(--separator-weak)] bg-[var(--bg-grouped)] px-[var(--cell-px)] py-2 text-[13px]${
        className === undefined ? "" : ` ${className}`
      }`}
    >
      <nav aria-label={labels.nav} className="flex items-center">
        <div className="inline-flex bg-[var(--bg-grouped-secondary)] rounded-[var(--r-control)] shadow-[var(--ring-control)]">
          <Step
            label={labels.first}
            icon="chevrons-left"
            href={depth === 0 ? null : clearCursors(options)}
          />
          <Step
            label={labels.previous}
            icon="chevron-left"
            href={depth === 0 ? null : popCursor(options)}
          />
          {/* Next is ABSENT rather than disabled, and the asymmetry is
              structural: "first" and "previous" can always be built from the
              stack we are holding, so at depth 0 they are real controls that
              happen to be unavailable. A next link cannot be built at all
              without a `nextCursor` — there is no URL to put on it. */}
          {hasMore && nextCursor !== null && (
            <Step
              label={labels.next}
              icon="chevron-right"
              href={pushCursor({ ...options, cursor: nextCursor })}
            />
          )}
        </div>
        <span className="px-2.5 text-[var(--label-secondary)] tabular-nums">
          {labels.page(depth + 1)}
        </span>
      </nav>

      <div className="flex flex-wrap items-center gap-2 text-[var(--label-secondary)]">
        {/* The visible text and the group's accessible name are the same
            string, so the visible copy is hidden from assistive tech: without
            this it is announced twice, once as static text and once as the
            name of the group right after it. */}
        <span aria-hidden="true">{labels.perPage}</span>
        <SegmentedControl
          label={labels.perPage}
          segments={PAGE_SIZE_SEGMENTS}
          value={String(pageSize)}
          pathname={pathname}
          param={limitParam}
          searchParams={searchParams}
          // A cursor is a position in a result set sliced at ONE page size.
          // Carried across a size change it lands the operator in the middle of
          // nowhere and makes the "Showing 51–75" arithmetic above a lie.
          resets={[cursorParam]}
        />
        {itemCount > 0 && (
          <span className="tabular-nums">{labels.showing({ from, to, hasMore })}</span>
        )}
      </div>
    </div>
  );
}

interface StepProps {
  readonly label: string;
  readonly icon: IconName;
  /** `null` renders the slot inert, keeping the capsule's geometry. */
  readonly href: string | null;
}

function Step({ label, icon, href }: StepProps) {
  if (href === null) {
    // `role="link"` + `aria-disabled`, not a bare span: the slot keeps its
    // name, so a screen-reader user who lands on it is told what it is AND
    // that it is unavailable, instead of meeting an unlabelled box. It is
    // deliberately not focusable — a disabled control that swallows a Tab is
    // the behaviour `<button disabled>` was given for a reason.
    return (
      <span role="link" aria-disabled="true" aria-label={label} className={`${CELL} ${CELL_DISABLED}`}>
        <Icon name={icon} size={16} />
      </span>
    );
  }

  return (
    <Link href={href} aria-label={label} className={`${CELL} ${CELL_IDLE}`}>
      <Icon name={icon} size={16} />
    </Link>
  );
}
