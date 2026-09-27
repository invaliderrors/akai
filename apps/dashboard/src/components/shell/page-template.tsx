import type { ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { Link } from "@/i18n/navigation";

/**
 * The four regions every screen composes, in order: header, filter bar,
 * content, footer.
 *
 * WHAT THIS REPLACES. Two spellings of one idea — the admin `PageHeader` and
 * the customer `.page-head` block. They had drifted apart in every dimension
 * that matters: different title sizes, different description colours, one
 * supported a right-hand action slot and the other did not, and neither owned
 * the page's measure, so the max-width was retyped per screen (or forgotten).
 * A page now states its WIDTH and its four slots and gets the rest.
 *
 * IT IS NOT A `<main>`, deliberately. `DashboardShell` owns `<main id="content">`
 * — it is the skip-link target and there must be exactly one per document, so a
 * second one here would be invalid HTML and would give the page two "main"
 * landmarks. The gutter and the vertical rhythm still live here rather than on
 * the shell's `<main>` because the MEASURE is a per-page decision: the
 * max-width has to be applied by the same element that pays for the gutter, or
 * an 880px reading column ends up 880px of text plus 24px of air on one side
 * only when the viewport happens to be narrow.
 *
 * NO `"use client"`. Slots in, markup out — every region is a prop, nothing
 * here holds state, and the pages that compose it stay server components. The
 * interactive pieces a page drops into these slots (a filter bar's GET form, a
 * toast-driven action) bring their own boundaries.
 *
 * STICKY TABLE HEADERS ARE ALREADY HANDLED and are not re-implemented here:
 * `ui/table.tsx` sticks its header at `top: var(--toolbar-h)` inside its own
 * `overflow-x-auto` wrapper. All this region owes it is `min-width: 0`, so the
 * wrapper is free to be narrower than its content and scroll — without it the
 * grid resolves the column to the table's min-content width and the whole page
 * grows a horizontal scrollbar instead.
 */

/**
 * The measure, named by the thing it is for rather than by its number.
 *
 * `table` is not "wide reading": a table is read across, a paragraph is read
 * down, and 1240 vs 880 is that difference — a caller picking a width should be
 * answering "what is on this page" and not "how many pixels do I fancy".
 */
export type PageWidth = "admin" | "reading" | "table";

const WIDTH_CLASS: Readonly<Record<PageWidth, string>> = {
  admin: "max-w-[var(--w-admin)]",
  reading: "max-w-[var(--w-reading)]",
  table: "max-w-[var(--w-table)]",
};

/**
 * The title ramp. A PROP rather than a media query for the same reason
 * `SectionHeader`'s is: density is a `data-density` attribute driving custom
 * properties, the landed token layer declares eight of them and no title size
 * is among them, and no custom property can be interpolated into a Tailwind
 * `text-[…]` at build time anyway. The two are structurally different type
 * scales — macOS Title 1 for admin, iOS Large Title for the customer area —
 * that happen to appear in different places.
 */
export type PageDensity = "compact" | "comfortable";

/**
 * Defaulted FROM the width because the two always agree in practice:
 * `DashboardShell` sets `data-density` from the AREA, and the widths are
 * area-specific (`--w-admin` is admin, `--w-reading`/`--w-table` are the
 * customer's). Defaulted rather than derived, because measure and type scale
 * are still different decisions — an admin form that wants a reading column
 * must not silently inherit a 34px title with it.
 */
const DEFAULT_DENSITY: Readonly<Record<PageWidth, PageDensity>> = {
  admin: "compact",
  reading: "comfortable",
  table: "comfortable",
};

/**
 * Comfortable steps DOWN at `sm`, which is the opposite of the usual direction
 * and is the point: 34/41 is the iOS Large Title, drawn on the 400pt artboards,
 * and on a desktop reading column it reads as a marketing headline. The
 * breakpoint matches the one `--gutter` already steps at.
 */
const TITLE_SIZE: Readonly<Record<PageDensity, string>> = {
  compact: "text-[22px] leading-[26px]",
  comfortable: "text-[34px] leading-[41px] sm:text-[26px] sm:leading-8",
};

/**
 * Tracking is kept out of TITLE_SIZE so `mono` can replace it with a single
 * class. Two competing `tracking-*` utilities in one string do NOT resolve by
 * the order they are written — they resolve by the order Tailwind emits them,
 * which no call site controls.
 */
const TITLE_TRACKING: Readonly<Record<PageDensity, string>> = {
  compact: "tracking-[-0.26px]",
  comfortable: "tracking-[0.4px] sm:tracking-[0.2px]",
};

const DESCRIPTION_CLASS: Readonly<Record<PageDensity, string>> = {
  compact: "mt-0.5 text-[13px] leading-4",
  comfortable: "mt-1 text-[15px] leading-5",
};

export interface PageBreadcrumbLink {
  /** Already translated. This kit never reaches into a message namespace. */
  readonly label: string;
  /** Route only — `Link` adds the locale prefix. */
  readonly href: string;
}

export interface PageBreadcrumb {
  /** Accessible name of the nav landmark, e.g. "Ruta de navegación". */
  readonly label: string;
  /**
   * ANCESTORS ONLY. The current page is the `<h1>` directly beneath, so
   * repeating it here as a dead trailing crumb would put the same string in the
   * document twice and give a screen-reader user two things to land on.
   */
  readonly links: readonly PageBreadcrumbLink[];
}

export interface PageTemplateProps {
  /** The one `<h1>` on the page. */
  readonly title: string;
  /**
   * Renders the title in JetBrains Mono for a screen whose title IS an
   * identifier — an order number, a SKU. Never for a name or a money figure.
   */
  readonly mono?: boolean;
  /**
   * Rendered INSIDE the `<h1>`, after the title: the status pill on an order
   * detail screen. Inside, because a badge that qualifies the title but sits
   * outside it is either a second heading or a floating fragment whose
   * relationship to the title exists only visually.
   */
  readonly titleAdornment?: ReactNode;
  /** One line. Sentence case, no full stop is not enforced — just keep it one line. */
  readonly description?: string;
  /** Right-aligned, bottom-aligned with the title block. */
  readonly actions?: ReactNode;
  /** Shown above the title on a detail screen. */
  readonly breadcrumb?: PageBreadcrumb;
  /** Region 2 — a `FilterBar`, or nothing. */
  readonly filters?: ReactNode;
  /** Region 3. */
  readonly children: ReactNode;
  /** Region 4, left. Typically a `CursorPagination`. */
  readonly pagination?: ReactNode;
  /** Region 4, right. Already-translated result summary. */
  readonly summary?: ReactNode;
  readonly width: PageWidth;
  readonly density?: PageDensity;
  readonly className?: string;
}

/**
 * `{count > 0 && <CursorPagination …/>}` evaluates to `false`, not `undefined`,
 * and callers write that idiom constantly. Checking only for `undefined` would
 * open the footer for it — a 16px gap and an empty row on every page that has
 * nothing to paginate.
 */
function isFilled(slot: ReactNode): boolean {
  return slot !== undefined && slot !== null && slot !== false;
}

export function PageTemplate({
  title,
  mono = false,
  titleAdornment,
  description,
  actions,
  breadcrumb,
  filters,
  children,
  pagination,
  summary,
  width,
  density = DEFAULT_DENSITY[width],
  className,
}: PageTemplateProps) {
  const hasBreadcrumb = breadcrumb !== undefined && breadcrumb.links.length > 0;
  const hasPagination = isFilled(pagination);
  const hasSummary = isFilled(summary);

  return (
    <div
      className={`mx-auto grid w-full min-w-0 content-start gap-4 px-[var(--gutter)] py-5 ${
        WIDTH_CLASS[width]
      }${className === undefined ? "" : ` ${className}`}`}
    >
      {/* `items-end`, so a two-line description and a 28px button share a
          baseline edge rather than the button floating at the top of the block.
          Implicit landmark suppressed: this renders inside the shell's <main>,
          so it is a generic element and not a second `banner`. */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {hasBreadcrumb && (
            <nav aria-label={breadcrumb.label} className="mb-1.5">
              <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-[13px] leading-[18px]">
                {breadcrumb.links.map((link, index) => (
                  <li key={link.href} className="flex items-center gap-1">
                    {index > 0 && (
                      <Icon
                        name="chevron-right"
                        size={14}
                        className="shrink-0 text-[var(--chevron)]"
                      />
                    )}
                    <Link
                      href={link.href}
                      className="rounded-[var(--r-check)] text-[var(--accent)] no-underline hover:underline focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ol>
            </nav>
          )}

          <h1
            className={`m-0 font-bold text-[var(--label)] ${TITLE_SIZE[density]} ${
              mono ? "font-mono tracking-normal" : TITLE_TRACKING[density]
            }${titleAdornment === undefined ? "" : " flex flex-wrap items-center gap-3"}`}
          >
            {title}
            {titleAdornment}
          </h1>

          {description !== undefined && (
            <p className={`${DESCRIPTION_CLASS[density]} text-[var(--label-secondary)]`}>
              {description}
            </p>
          )}
        </div>

        {actions !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </header>

      {filters}

      {/* `min-w-0` is load-bearing: see the note at the top of the file. */}
      <div className="min-w-0">{children}</div>

      {(hasPagination || hasSummary) && (
        <footer className="flex flex-wrap items-center justify-between gap-3">
          {hasPagination && <div className="min-w-0">{pagination}</div>}
          {/* `ms-auto` and not just `justify-between`: a page with a summary and
              no pagination has ONE child, and a lone child in a
              space-between row sits on the left. */}
          {hasSummary && (
            <div className="ms-auto text-[13px] leading-[18px] text-[var(--label-secondary)]">
              {summary}
            </div>
          )}
        </footer>
      )}
    </div>
  );
}
