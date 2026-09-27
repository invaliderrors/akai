import { Fragment, type ReactNode } from "react";

import { Link } from "@/i18n/navigation";

import { Icon } from "./icon";
import { segmentHref, type SearchParamValue } from "./segmented-control";
import { SelectAllCheckbox } from "./table-selection";

/**
 * The macOS bordered table: one component behind every list in the admin area.
 *
 * WHAT IT REPLACES. Seven hand-rolled `<table>` blocks, each with its own cell
 * padding, its own idea of which column is right-aligned, and its own "Ver"
 * link. Two of them wrapped the table in the page's own scroll container, so a
 * wide order list scrolled the WHOLE PAGE sideways and the sidebar left the
 * screen. The horizontal scroll belongs to the table, never to the document.
 *
 * THERE IS NO COLUMN SORTING AND THERE ARE NO RESIZABLE COLUMNS, though the
 * artboard's own caption promises both. `paginationQuerySchema` in
 * `libs/contracts` is `{ cursor, limit }` and nothing else — no `orderBy`, no
 * `sort`, no `direction` — so a sortable heading could only ever reorder the
 * page the operator is already looking at, which is a lie about the data below
 * it. Sorting comes back when the API grows an ordering parameter, and a
 * client-side sort over one cursor page is not that.
 *
 * NO `"use client"`. Cells arrive as already-rendered nodes from render props
 * the caller evaluates during ITS render, so a server page keeps this on the
 * server; a client page that uses it pulls the module into its own graph for
 * free. Expansion is a URL parameter for the same reason — see `TableExpansion`.
 */

/** How a column reads, which decides its alignment, its face and its header. */
export type ColumnKind = "text" | "numeric" | "identifier" | "actions";

interface ColumnSpec {
  readonly header: string;
  readonly cell: string;
  /** Skeleton bar width for this kind, as a literal class. */
  readonly bar: string;
  /**
   * Headers are hidden for `actions` only, and hidden rather than absent: a
   * column with no `<th>` text is an unnamed column in the accessibility tree,
   * and "Acciones" printed over a row of ghost icons is chrome nobody reads.
   */
  readonly headerHidden: boolean;
}

/**
 * MONEY IS NOT MONO. `identifier` is the only kind that takes the mono face,
 * and it takes it because an order number, a SKU or a lot code is compared
 * character by character against something printed on a label, where B/8 and
 * 0/O must not be a coin toss. An amount is read as a magnitude, so it stays on
 * the sans face with tabular figures and right alignment, which is what
 * `numeric` is (and what `<Money>` renders).
 *
 * `no underline` is the app-wide base reset, so the identifier link is coloured
 * rather than underlined — with the underline restored on hover, because a
 * column of links distinguished from text by colour alone gives a reader no
 * affordance until they touch it.
 */
const COLUMN_KIND: Readonly<Record<ColumnKind, ColumnSpec>> = {
  text: { header: "text-start", cell: "text-start", bar: "w-[130px]", headerHidden: false },
  numeric: {
    header: "text-end",
    cell: "text-end tabular-nums",
    bar: "w-[52px] ml-auto",
    headerHidden: false,
  },
  identifier: {
    header: "text-start",
    cell: "text-start font-mono text-[12px] font-medium [&_a:hover]:underline",
    bar: "w-[100px]",
    headerHidden: false,
  },
  // `w-[1%]` is the table-layout idiom for "shrink to your content": a
  // percentage smaller than the content can occupy makes the algorithm give the
  // column its minimum and hand the slack to its neighbours.
  actions: {
    header: "text-end w-[1%]",
    cell: "text-end w-[1%] whitespace-nowrap",
    bar: "w-0",
    headerHidden: true,
  },
};

/**
 * The tone a row carries because of its DATA.
 *
 * The plan names six row treatments; three of them are not data and are derived
 * here rather than asked for: `hover` is a CSS state, `expanded` is whether the
 * row's id is in the URL, and `skeleton` is the `loading` prop. That leaves the
 * three below, which are the only ones a caller can know.
 *
 * `attention` IS RATIONED. It has exactly two sanctioned uses in the product —
 * an order in `PAYMENT_MISMATCH`, and zero-available stock on an ACTIVE product
 * — and the cap is argued in `lib/status`, not enforceable here. A third case
 * has to be re-argued there first; this component draws whatever it is handed.
 */
export type RowTone = "default" | "selected" | "attention";

/** What a cell renderer is told about the row it is drawing into. */
export interface RowState {
  readonly tone: RowTone;
  /**
   * True on an accent-filled row. Cells that carry their own colour have to
   * react: a `Badge` takes `onAccent`, because every pale `*-fill` tint the
   * badge set uses disappears against `--accent`.
   */
  readonly selected: boolean;
  readonly expanded: boolean;
}

export interface Column<Row> {
  /** Stable React key, and the column's identity in a diff. */
  readonly key: string;
  /** Already translated. Rendered `sr-only` when the kind hides headers. */
  readonly header: string;
  readonly cell: (row: Row, state: RowState) => ReactNode;
  /** Defaults to `text`. */
  readonly kind?: ColumnKind;
  /** Forces the header out of view — for a leading checkbox or avatar column. */
  readonly headerHidden?: boolean;
}

/**
 * Expansion, as a URL parameter.
 *
 * NOT `<details>`: a `<details>` element is not permitted in a table's content
 * model, so the browser hoists it out of the row and the markup you get is not
 * the markup you wrote. NOT client state either: holding the open row in React
 * would make every list a client component and drag its whole page of rows into
 * the bundle, which is the opposite of the decision that keeps these lists on
 * the server. In the URL, an expanded row survives a reload, a share and the
 * back button, and the row that opened it is a plain link.
 *
 * The href is built with `segmentHref`, which is the segmented control's own
 * builder and is reused here on purpose: it preserves every query param the
 * control does not own — the filters, the `limit`, and critically the cursor
 * stack, so opening a row cannot move the operator to another page. One
 * implementation of "change one param, keep the rest" in this directory, not
 * four.
 */
export interface TableExpansion<Row> {
  /** The open row's id, straight off `searchParams`. */
  readonly expandedId: string | undefined;
  /** The route the table sits on. `Link` adds the locale. */
  readonly pathname: string;
  readonly searchParams?: Readonly<Record<string, SearchParamValue>>;
  /** Defaults to `expand`. */
  readonly param?: string;
  /** Accessible name of the disclosure column, already translated. */
  readonly header: string;
  /**
   * Accessible name of one row's trigger, already translated. `expanded` is
   * passed so the verb can match ("Mostrar…" / "Ocultar…"); the state itself is
   * already announced by `aria-expanded`.
   */
  readonly label: (row: Row, expanded: boolean) => string;
  /** The panel body. Rendered in a sibling row spanning every column. */
  readonly render: (row: Row) => ReactNode;
}

/**
 * Row selection — a leading checkbox column, and a "select every row on this
 * page" checkbox in its header. GENERIC: it knows nothing about what the rows
 * are or what is done with them.
 *
 * THE TABLE STAYS A SERVER COMPONENT. Each row's checkbox is a plain
 * `<input form={form} name={name} value={rowKey(row)}>`, associated through
 * the `form` attribute with a `<form id={form}>` the caller renders beside its
 * action buttons; the one control that needs JavaScript (select-all) is a
 * small client island from `./table-selection`, and the action bar reads the
 * selection with `useTableSelection({ form, name })` from the same module.
 * See that file for why selection is DOM state rather than React state.
 */
export interface TableSelection<Row> {
  /** The `id` of the `<form>` the checkboxes belong to. */
  readonly form: string;
  /** The checkboxes' `name`. Default `selected`. */
  readonly name?: string;
  /** Accessible name of the header checkbox, already translated. */
  readonly header: string;
  /** Accessible name of one row's checkbox, already translated ("Seleccionar AK-2026-000123"). */
  readonly label: (row: Row) => string;
  /** Rows that cannot be selected render a disabled box. Default: all selectable. */
  readonly isSelectable?: (row: Row) => boolean;
}

export interface TableLoading {
  /** Already translated, and specific where it can be ("Cargando pedidos…"). */
  readonly label: string;
  /** Placeholder rows. Default 5. */
  readonly rows?: number;
}

/**
 * The floor below which the columns stop being readable and the WRAPPER starts
 * scrolling.
 *
 * A closed set rather than a number: Tailwind finds utilities by scanning
 * source text, so `min-w-[${n}px]` computed at runtime is a class that is never
 * generated — no error, just a table with no floor. These three are the
 * artboard's own clusters.
 */
export type TableMinWidth = "none" | "narrow" | "regular" | "wide";

const MIN_WIDTH: Readonly<Record<TableMinWidth, string>> = {
  none: "",
  narrow: "min-w-[560px]",
  regular: "min-w-[760px]",
  wide: "min-w-[900px]",
};

export interface DataTableProps<Row> {
  /**
   * The table's accessible name, already translated. Rendered as an `sr-only`
   * `<caption>` — the element the table role is actually named by, and the one
   * a screen reader reads when the user lands in the grid.
   */
  readonly caption: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  /** Stable identity. Also the value written to the expansion parameter. */
  readonly rowKey: (row: Row) => string;
  readonly rowTone?: (row: Row) => RowTone;
  readonly expansion?: TableExpansion<Row>;
  readonly selection?: TableSelection<Row>;
  /** Draws skeleton rows instead of data. Ranks above `empty`, below `error`. */
  readonly loading?: TableLoading;
  /**
   * Shown when there are no rows. Compose `<EmptyState density="table">` from
   * `./states` — it is rendered INSIDE the table's frame but OUTSIDE the
   * `<table>`, so the column headings stay on screen and the reader can still
   * see what it is they have none of.
   */
  readonly empty?: ReactNode;
  /** Same placement as `empty`, and it outranks every other body state. */
  readonly error?: ReactNode;
  /** Sits inside the frame under the table. Sized for `<CursorPagination>`. */
  readonly footer?: ReactNode;
  /** Default `regular`. Pass `none` for a table inside a card. */
  readonly minWidth?: TableMinWidth;
  /** Default true. See `HEADER_STICKY` below for what it can and cannot do. */
  readonly stickyHeader?: boolean;
  /**
   * Default true: the table draws its own white, hairlined, `--r-card` surface.
   * Pass false for a table that lives INSIDE a `<Card>`, which already draws
   * one — two nested surfaces read as a mistake, and the header then takes a
   * rule above it instead of the frame's edge.
   */
  readonly frame?: boolean;
  readonly className?: string;
}

const TABLE_BASE = "w-full border-collapse text-[var(--font-body)] text-[var(--label)]";

const HEADER_BASE =
  "px-[var(--cell-px)] py-[var(--cell-py)] text-[11px] font-semibold text-[var(--label-secondary)] border-b border-[var(--separator)]";

/**
 * THE STICKY HEADER, AND WHY THE OFFSET IS ZERO.
 *
 * `overflow-x: auto` on the wrapper forces the used value of `overflow-y` to
 * `auto` as well — that is the specified behaviour, not a browser bug — so the
 * WRAPPER, not the page, is the scrollport this header sticks inside. The
 * offset is therefore measured from the wrapper's top edge, and the only
 * correct value is 0.
 *
 * `top-[var(--toolbar-h)]` shipped here first and broke every table on the
 * site. A sticky offset applies whether or not the scrollport currently
 * scrolls: the header's natural position is the wrapper's top edge, `top: 52px`
 * requires it to sit 52px lower, and a sticky table cell's containing block is
 * the TABLE — so each `<th>` slid down over the first two body rows. The result
 * was an empty header strip with the column labels overprinting row one.
 * The toolbar height would only be the right offset if the PAGE were the
 * scrollport, which this wrapper's own `overflow-x` rules out.
 *
 * Dropping `overflow-x` to make the page the scrollport is the other way to
 * reconcile the two, and it is the defect this component was written to remove:
 * a nine-column order list scrolling the entire document sideways. A header
 * that scrolls away is a smaller loss than a page that does.
 */
const HEADER_STICKY = "sticky top-0 z-10 bg-[var(--glass-fill-strong)]";

const CELL_BASE = "px-[var(--cell-px)] py-[var(--cell-py)]";

/**
 * The attention rail.
 *
 * ON THE FIRST CELL, NOT ON THE ROW, though the artboard draws it on the `<tr>`.
 * Under `border-collapse: collapse` a row box does not paint a box-shadow in
 * Chrome or Safari — the declaration is simply dropped, silently, with the fill
 * still showing — so the artboard's own spelling would ship an attention row
 * with no rail on it. An inset shadow on the leading cell paints everywhere and
 * shifts nothing, where a 3px left border would push that column's text out of
 * line with every other row.
 */
const ATTENTION_RAIL = "shadow-[inset_3px_0_0_var(--attention-fill)]";

/**
 * Row actions: ALWAYS IN THE DOM, revealed by hover AND by focus-within.
 *
 * `display: none` until hover is the version of this that ships broken — a
 * hidden element is not in the tab order, so every row action in the product
 * becomes unreachable by keyboard, and no test that queries a hovered row will
 * ever notice.
 *
 * The base state is VISIBLE and the hiding is gated on `@media (hover: hover)`,
 * which is the inverse of the obvious spelling and the only one that works on a
 * touch screen: Tailwind wraps `group-hover` in that same media query, so a
 * base `opacity-0` would leave the actions permanently invisible on a tablet
 * with no way to reveal them. Both reveal rules also outrank the hide rule on
 * specificity, so their order in the sheet cannot matter.
 */
const ACTIONS_REVEAL =
  "opacity-100 [@media(hover:hover)]:opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 motion-safe:transition-opacity";

/**
 * The selection checkbox: native, so keyboard, screen-reader and forced-colour
 * behaviour come from the platform; tinted with the accent, and sized to the
 * 22px disclosure control so both leading columns line up.
 */
const CHECKBOX =
  "h-4 w-4 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

/** A checked row reads as chosen, from CSS alone — no client state behind it. */
const ROW_CHECKED = "has-[:checked]:bg-[var(--progress-fill)]";

/** The kit's focus contract: opt out of the layered base outline, then paint. */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]";

const TONE_CLASS: Readonly<Record<RowTone, string>> = {
  // Hover and zebra are appended for `default` only — see `rowClass`.
  default: "",
  selected: "bg-[var(--accent)] text-[var(--label-on-accent)]",
  attention: "bg-[var(--danger-fill)]",
};

/**
 * ZEBRA IS COMPUTED FROM THE DATA INDEX, NOT FROM `even:`.
 *
 * `nth-child` counts every sibling in the `<tbody>`, and an expansion panel IS
 * a sibling row — so a CSS-driven stripe inverts for every row after an opened
 * one. The index into `rows` is the only counter that means "second order",
 * and it is already in hand.
 *
 * Hover and zebra are both skipped on a toned row: `--fill-tertiary` over
 * `--accent` would erase a selection on mouseover, and a stripe under the
 * attention fill would make the same state two different reds.
 */
function rowClass(tone: RowTone, expanded: boolean, index: number): string {
  const base = "group/row h-[var(--row-h)]";
  // A tone outranks the open-row fill: an order in PAYMENT_MISMATCH is still in
  // PAYMENT_MISMATCH while its panel is open, and the chevron already says the
  // row is open. Only the fill is decided here; the chevron is decided by
  // `expanded` regardless.
  if (tone !== "default") {
    return `${base} ${TONE_CLASS[tone]}`;
  }
  if (expanded) {
    // An open row is quieter than a hovered one: it is a state the operator
    // chose, not one the pointer is passing through.
    return `${base} bg-[var(--bg-grouped)]`;
  }
  return `${base} ${index % 2 === 1 ? "bg-[var(--zebra)] " : ""}hover:bg-[var(--fill-tertiary)]`;
}

/**
 * The identifier column is accent-coloured — except on an accent-filled row,
 * where blue on blue is nothing at all.
 *
 * Branched in JS rather than through a `group-data-[…]` variant because the
 * tone is already known at render time; a variant would be a second source of
 * truth for the same fact, resolved by stylesheet order.
 */
function identifierInk(selected: boolean): string {
  return selected ? "text-[var(--label-on-accent)]" : "text-[var(--accent)]";
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowTone,
  expansion,
  selection,
  loading,
  empty,
  error,
  footer,
  minWidth = "regular",
  stickyHeader = true,
  frame = true,
  className,
}: DataTableProps<Row>) {
  const expandParam = expansion?.param ?? "expand";
  const selectionName = selection?.name ?? "selected";
  const leadingCount = (expansion === undefined ? 0 : 1) + (selection === undefined ? 0 : 1);
  const columnCount = columns.length + leadingCount;

  // Precedence, stated once, because getting it wrong is silent: a failure
  // outranks everything (rows fetched before it broke are not evidence of
  // anything), and LOADING OUTRANKS EMPTINESS — a loading table has no rows yet,
  // so testing `rows.length === 0` first would answer "you have no orders" to a
  // question nobody has finished asking.
  const state =
    error !== undefined ? error : loading === undefined && rows.length === 0 ? empty : undefined;
  const showBody = state === undefined;

  const headerClass = `${HEADER_BASE}${stickyHeader ? ` ${HEADER_STICKY}` : ""}${
    frame ? "" : " border-t border-[var(--separator-weak)]"
  }`;

  return (
    <div
      className={`${
        frame
          ? "overflow-hidden rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] shadow-[var(--e-0)]"
          : ""
      }${className === undefined ? "" : ` ${className}`}`}
    >
      {/* One announcement for the whole skeleton, and it lives OUTSIDE the
          table: a live region buried in a `<td>` is read in table-navigation
          mode as a cell, and five of them is five interruptions. */}
      {loading === undefined || !showBody ? null : (
        <span role="status" className="sr-only">
          {loading.label}
        </span>
      )}
      <div className="overflow-x-auto">
        <table className={`${TABLE_BASE}${MIN_WIDTH[minWidth] === "" ? "" : ` ${MIN_WIDTH[minWidth]}`}`}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {selection === undefined ? null : (
                <th scope="col" className={`${headerClass} text-start w-[1%] border-r border-[var(--separator-weak)]`}>
                  <SelectAllCheckbox
                    form={selection.form}
                    name={selectionName}
                    label={selection.header}
                    className={CHECKBOX}
                  />
                </th>
              )}
              {expansion === undefined ? null : (
                <th scope="col" className={`${headerClass} text-start w-[1%] border-r border-[var(--separator-weak)]`}>
                  <span className="sr-only">{expansion.header}</span>
                </th>
              )}
              {columns.map((column, index) => {
                const spec = COLUMN_KIND[column.kind ?? "text"];
                const hidden = column.headerHidden ?? spec.headerHidden;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={`${headerClass} ${spec.header}${
                      index === columns.length - 1 ? "" : " border-r border-[var(--separator-weak)]"
                    }`}
                  >
                    {hidden ? <span className="sr-only">{column.header}</span> : column.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          {!showBody ? null : (
            <tbody>
              {loading !== undefined
                ? Array.from({ length: Math.max(1, loading.rows ?? 5) }, (_unused, rowIndex) => (
                    <SkeletonRow
                      key={rowIndex}
                      columns={columns}
                      leading={leadingCount}
                      animate={rowIndex === 0}
                    />
                  ))
                : rows.map((row, index) => {
                    const id = rowKey(row);
                    const tone = rowTone === undefined ? "default" : rowTone(row);
                    const expanded = expansion !== undefined && expansion.expandedId === id;
                    const cellState: RowState = { tone, selected: tone === "selected", expanded };
                    const panelId = `${id}-detail`;
                    const rail = tone === "attention" ? ` ${ATTENTION_RAIL}` : "";

                    return (
                      <Fragment key={id}>
                        <tr
                          className={`${rowClass(tone, expanded, index)}${
                            selection === undefined ? "" : ` ${ROW_CHECKED}`
                          }`}
                        >
                          {selection === undefined ? null : (
                            <td className={`${CELL_BASE} w-[1%]${rail}`}>
                              <input
                                type="checkbox"
                                form={selection.form}
                                name={selectionName}
                                value={id}
                                aria-label={selection.label(row)}
                                disabled={
                                  selection.isSelectable === undefined
                                    ? false
                                    : !selection.isSelectable(row)
                                }
                                className={`${CHECKBOX} align-middle`}
                              />
                            </td>
                          )}
                          {expansion === undefined ? null : (
                            <td className={`${CELL_BASE} w-[1%]${selection === undefined ? rail : ""}`}>
                              <Link
                                href={segmentHref({
                                  pathname: expansion.pathname,
                                  param: expandParam,
                                  // `null` clears the param — the same value the
                                  // "Todos" segment uses — so one link both opens
                                  // and closes, and a second click is a collapse
                                  // rather than a no-op that reopens the row.
                                  value: expanded ? null : id,
                                  ...(expansion.searchParams === undefined
                                    ? {}
                                    : { searchParams: expansion.searchParams }),
                                })}
                                aria-expanded={expanded}
                                aria-label={expansion.label(row, expanded)}
                                {...(expanded ? { "aria-controls": panelId } : {})}
                                className={`inline-flex h-[22px] w-[22px] items-center justify-center rounded-[var(--r-check)] text-[var(--label-secondary)] ${FOCUS_RING}`}
                              >
                                <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
                              </Link>
                            </td>
                          )}
                          {columns.map((column, columnIndex) => {
                            const kind = column.kind ?? "text";
                            const spec = COLUMN_KIND[kind];
                            const leading =
                              expansion === undefined && selection === undefined && columnIndex === 0;
                            const ink =
                              kind === "identifier" ? ` ${identifierInk(cellState.selected)}` : "";
                            return (
                              <td
                                key={column.key}
                                className={`${CELL_BASE} ${spec.cell}${ink}${leading ? rail : ""}`}
                              >
                                {kind === "actions" ? (
                                  <span className={`inline-flex items-center gap-1 ${ACTIONS_REVEAL}`}>
                                    {column.cell(row, cellState)}
                                  </span>
                                ) : (
                                  column.cell(row, cellState)
                                )}
                              </td>
                            );
                          })}
                        </tr>
                        {!expanded || expansion === undefined ? null : (
                          <tr id={panelId} className="bg-[var(--bg-grouped)]">
                            {/* Indented past the disclosure column so the panel
                                starts where the row's own content does. */}
                            <td
                              colSpan={columnCount}
                              className="pl-[calc(var(--cell-px)*2+22px)] pr-[var(--cell-px)] pt-0 pb-[var(--cell-px)] text-[13px]"
                            >
                              {expansion.render(row)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
            </tbody>
          )}
        </table>
      </div>
      {/* The empty and error states sit outside the `<table>` and outside the
          horizontal scroller: a centred message inside a 900px-wide scrolling
          table is centred on the TABLE, so on a narrow screen the reader scrolls
          sideways to find out that there is nothing there. The headings stay
          above it either way, which is the whole point of not replacing the
          table with a bare panel. */}
      {state}
      {footer}
    </div>
  );
}

interface SkeletonRowProps<Row> {
  readonly columns: readonly Column<Row>[];
  /** How many leading (selection / disclosure) cells to leave blank. */
  readonly leading: number;
  readonly animate: boolean;
}

/**
 * A placeholder row.
 *
 * Drawn as real `<tr>`/`<td>` rather than reusing `<Skeleton variant="rows">`,
 * which renders a grid of `<div>`s — valid nowhere inside a `<tbody>`, and it
 * would lose the column widths, so the page would jump the moment the data
 * arrived. The bars are `aria-hidden` and the row is `aria-busy`; the single
 * announcement lives outside the table, in `DataTable`.
 *
 * ONLY THE FIRST ROW'S BARS ANIMATE, following `states.tsx`: one moving element
 * is a heartbeat, forty is a strobe.
 */
function SkeletonRow<Row>({ columns, leading, animate }: SkeletonRowProps<Row>) {
  return (
    <tr aria-busy="true" className="h-[var(--row-h)]">
      {Array.from({ length: leading }, (_unused, index) => (
        <td key={`leading-${String(index)}`} className={CELL_BASE} />
      ))}
      {columns.map((column) => {
        const spec = COLUMN_KIND[column.kind ?? "text"];
        return (
          <td key={column.key} className={`${CELL_BASE} ${spec.cell}`}>
            {spec.bar === "w-0" ? null : (
              <span
                aria-hidden
                className={`block h-[10px] rounded-[3px] bg-[var(--fill-tertiary)] ${spec.bar}${
                  animate ? " animate-pulse" : ""
                }`}
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}
