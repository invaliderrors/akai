import type { CurrencyCode } from "@akai/contracts";

import Link from "next/link";

import { Icon } from "./icon";
import { AggregateMoney } from "./money";
import { Skeleton } from "./states";

/**
 * One headline figure: a label, the number, an optional change against the
 * previous period, and an optional line of small print saying what the number
 * actually counts.
 *
 * THERE IS NO SPARKLINE AND NO CHART, and that is a decision rather than an
 * omission. The artboard draws an eight-point sparkline in every tile, and the
 * plan carried it forward — but `metricsOverviewSchema` (lib/admin/schemas.ts)
 * is `.strict()` and holds exactly `{ revenue, ordersByStatus }`: a revenue
 * summary of scalar totals and a status histogram. There is no series, no
 * per-day bucket and no previous-period array anywhere behind it, and a strict
 * schema means one cannot arrive without the parse throwing. A sparkline here
 * could therefore only ever draw numbers the component invented, which is a
 * chart that lies at a glance and is very hard to notice — the worst failure
 * mode a data display has. When the API grows a series, the tile grows a
 * `series` prop and the drawn geometry is in `02 Primitives.dc.html` waiting.
 *
 * TILES LOAD AND FAIL INDEPENDENTLY, which is why loading is a SEPARATE export
 * rather than a `loading` flag on this one. A `loading?: boolean` prop would
 * have to make `value` optional to be usable, and every caller writes
 * `loading={isPending}` with a plain boolean, which cannot be narrowed by a
 * discriminated union under `exactOptionalPropertyTypes` — the same trap
 * `button.tsx` recorded for `pending`. Two components keep `value` genuinely
 * required where a value exists, and keep the branch at the call site, where
 * the four tiles are four independent fetches.
 *
 * No `"use client"`: props in, markup out. Nothing here holds state.
 */

// ---------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------

/**
 * A tile's figure is money or it is a count, and the difference is not
 * cosmetic.
 *
 * `money` goes through `AggregateMoney`, NEVER `Money`. Admin aggregates are
 * deliberately unbranded `z.number().int()` (schemas.ts:200-209) because a
 * lifetime revenue sum legitimately exceeds `MINOR_MAX`, and both ways of
 * forcing one down the branded path were defects in the superseded code:
 * `toMinor` THROWS above the cap (the old admin/page.tsx branded five
 * aggregates that way), and the `isMinor(x) ? formatMoney(x) : String(x)`
 * fallback at admin/metrics/page.tsx:60 — a route this redesign deleted —
 * printed a bare `2400000000` for exactly the figures it was guarding. Taking a
 * structured value rather than a `ReactNode` is what makes that unreachable
 * through this component.
 */
export type MetricValue =
  | {
      readonly kind: "money";
      /** Minor units, unbranded. Display only — an aggregate is never charged. */
      readonly amountMinor: number;
      readonly currency: CurrencyCode;
    }
  | {
      /**
       * A count, a rate, a duration — anything that is not money.
       *
       * Already formatted, because the kit has no number formatter and one is
       * out of scope here: a caller with a count runs it through
       * `Intl.NumberFormat(locale)` so 614 and 1.204 group the way the rest of
       * the page does.
       */
      readonly kind: "text";
      readonly value: string;
    };

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

/** Which arrow is drawn. Purely which way the number moved. */
export type DeltaDirection = "up" | "down";

/**
 * What the movement MEANS, which is a different question from which way it
 * went — a rising refund count is red and a falling one is green, and the tile
 * cannot work that out from the arrow. Keeping the two independent is the whole
 * reason this is not a single `positive: boolean`.
 *
 * `neutral` is for a movement that is real but carries no verdict (session
 * count, say), where a green arrow would be an unearned congratulation.
 */
export type DeltaSentiment = "positive" | "negative" | "neutral";

export interface MetricDelta {
  /**
   * Already formatted, including its unit: "8,2 %", "+14". The tile does not
   * add a sign — the arrow carries the direction and the sign would repeat it.
   */
  readonly value: string;
  readonly direction: DeltaDirection;
  readonly sentiment: DeltaSentiment;
  /**
   * The arrow's accessible name, already translated: "sube" / "baja".
   *
   * REQUIRED, and required for the reason the whole delta exists. "8,2 %" read
   * aloud on its own is not a change at all — it is a number with no verb, and
   * a screen-reader user has no way to recover the direction from a red or
   * green tint. This is the one glyph in the tile that carries meaning nothing
   * else repeats, so it is the one that gets a name.
   */
  readonly directionLabel: string;
}

interface DeltaSpec {
  /** The AA-passing text colour. */
  readonly ink: string;
  /** The indicator colour, used for the arrow only — brighter, and never on text. */
  readonly glyph: string;
}

const DELTA: Readonly<Record<DeltaSentiment, DeltaSpec>> = {
  positive: { ink: "text-[var(--success-text)]", glyph: "text-[var(--success)]" },
  negative: { ink: "text-[var(--danger-text)]", glyph: "text-[var(--danger)]" },
  neutral: { ink: "text-[var(--label-secondary)]", glyph: "text-[var(--label-tertiary)]" },
};

// ---------------------------------------------------------------------------
// Tone and link
// ---------------------------------------------------------------------------

/**
 * `attention` is the tile that needs a human.
 *
 * A HAIRLINE AND RED INK, NEVER A SOLID FILL. `--attention-fill` is a solid
 * #d70015 with white text and its budget is exactly two uses in the whole
 * product (order PAYMENT_MISMATCH, zero-available on an ACTIVE product — the
 * cap is asserted in `lib/status`'s test). A tile is a summary of those, not
 * one of them, so it borrows the ring and the ink and leaves the fill alone.
 */
export type MetricTileTone = "default" | "attention";

export interface MetricLink {
  /** An app path, rendered through `next/link`. */
  readonly href: string;
  /** Already translated, and specific: "Ver los 2 pedidos", not "Ver". */
  readonly label: string;
}

export interface MetricTileProps {
  /** Already translated. */
  readonly label: string;
  readonly value: MetricValue;
  readonly delta?: MetricDelta;
  /** Small print saying what the figure counts: "Bruto menos reembolsos." */
  readonly footnote?: string;
  readonly tone?: MetricTileTone;
  /** The way to act on the figure. On `attention` it takes the delta's place. */
  readonly link?: MetricLink;
  readonly className?: string;
}

/**
 * The tile's own chrome.
 *
 * NOT `<Card>`, deliberately. `Card` pins `shadow-[var(--e-0)]`, and the
 * attention tile has to REPLACE that hairline with a red one rather than layer
 * a second shadow utility over it — two `shadow-*` classes at equal specificity
 * are resolved by stylesheet order, which is a coin flip, not an override. The
 * default tile also carries no hairline at all (the artboard draws none): a
 * tile grid sits on `--bg-grouped`, where white on grey already separates, and
 * a ring on top of that reads as a card inside a card.
 *
 * `--card-p` rather than the drawn 14: the tile densifies with the shell around
 * it (12 compact / 16 comfortable) instead of freezing at a number that is
 * correct on exactly one screen.
 */
const TILE_CLASS =
  "rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)]";

/** 22/700 at -0.26px, the drawn headline. `tabular-nums` so a row of tiles aligns. */
const VALUE_CLASS =
  "m-0 mt-[2px] text-[22px] leading-[26px] font-bold tracking-[-0.26px] tabular-nums";

function MetricFigure({ value }: { readonly value: MetricValue }) {
  if (value.kind === "money") {
    return (
      <AggregateMoney
        amountMinor={value.amountMinor}
        currency={value.currency}
      />
    );
  }
  return <>{value.value}</>;
}

export function MetricTile({
  label,
  value,
  delta,
  footnote,
  tone = "default",
  link,
  className,
}: MetricTileProps) {
  const isAttention = tone === "attention";

  /*
   * ATTENTION DROPS THE DELTA even when one is passed, and the suppression is
   * here rather than at the call site so it cannot be forgotten on one of four
   * tiles. A tile that says "a decision is waiting" and then reports that the
   * backlog is down 3,1 % is answering a question nobody asked; the only useful
   * thing on it is the way in, which is why the link takes that row.
   */
  const showDelta = delta !== undefined && !isAttention;

  return (
    <div
      className={`${TILE_CLASS}${
        // The 1px ring geometry of `--e-0`, retinted. There is no
        // `--e-danger` token and globals.css is owned elsewhere, so the shape
        // is written out; the COLOUR is still a token, which is the rule that
        // matters.
        isAttention ? " shadow-[0_0_0_1px_var(--danger-ring)]" : ""
      }${className === undefined ? "" : ` ${className}`}`}
    >
      <p className="m-0 text-[12px] leading-4 font-semibold text-[var(--label-secondary)]">
        {label}
      </p>

      {/*
        The attention ink is applied to the paragraph AND, by a descendant
        selector, to the span `AggregateMoney` paints inside it. That is a
        specificity win (0,1,1 over 0,1,0), not a source-order one: passing a
        second bare `text-*` utility down through `className` would leave two
        colour utilities at equal weight and let the stylesheet's emit order
        decide which euro figure is red.
      */}
      <p
        className={`${VALUE_CLASS} ${
          isAttention
            ? "text-[var(--danger-text)] [&>span]:text-[var(--danger-text)]"
            : "text-[var(--label)]"
        }`}
      >
        <MetricFigure value={value} />
      </p>

      {showDelta || link !== undefined ? (
        <div className="mt-1.5 flex items-end justify-between gap-2">
          {showDelta ? (
            <span
              className={`inline-flex items-center gap-0.5 text-[12px] font-semibold tabular-nums ${
                DELTA[delta.sentiment].ink
              }`}
            >
              <Icon
                name={delta.direction === "up" ? "arrow-up-right" : "arrow-down-right"}
                size={13}
                title={delta.directionLabel}
                className={DELTA[delta.sentiment].glyph}
              />
              {delta.value}
            </span>
          ) : null}

          {link === undefined ? null : (
            <Link
              href={link.href}
              className="inline-flex items-center gap-0.5 rounded-[var(--r-check)] text-[12px] font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
            >
              {link.label}
              {/* Decorative: the link's own text already says where it goes. */}
              <Icon name="chevron-right" size={13} />
            </Link>
          )}
        </div>
      ) : null}

      {footnote === undefined ? null : (
        <p className="m-0 mt-1.5 text-[11px] leading-[15px] text-[var(--label-secondary)]">
          {footnote}
        </p>
      )}
    </div>
  );
}

export interface MetricTileSkeletonProps {
  /**
   * Already translated, and specific where it can be ("Cargando ingresos…").
   * Falls back to `common.loading` inside `Skeleton`, so a tile always says
   * something rather than reading as an empty box.
   */
  readonly label?: string;
  readonly className?: string;
}

/**
 * A tile that has not arrived yet.
 *
 * The bars, the `aria-busy` container and the single `role="status"` all come
 * from `Skeleton` rather than being redrawn here — a second set of shimmering
 * bars with its own opinion about how many live regions to open is exactly what
 * `states.tsx` was built to prevent. Only the chrome is this file's, so a
 * loading tile and a loaded one occupy the same box and the grid does not jump
 * when the fetch lands.
 */
export function MetricTileSkeleton({ label, className }: MetricTileSkeletonProps) {
  return (
    <div className={`${TILE_CLASS}${className === undefined ? "" : ` ${className}`}`}>
      <Skeleton variant="text" rows={3} {...(label === undefined ? {} : { label })} />
    </div>
  );
}
