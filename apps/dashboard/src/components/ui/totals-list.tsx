import type { CurrencyCode, Minor } from "@akai/contracts";
import { absolute, negate } from "@akai/money";

import { Money } from "./money";

/**
 * The order-totals block. One component, two consumers: the customer order
 * detail and the admin one.
 *
 * IT DOES NO ARITHMETIC. Every figure is rendered exactly as the API computed
 * it, and the six slots are named rather than being a free-form array so a
 * consumer cannot quietly omit the grand total. This matters more here than it
 * looks: EU consumer prices are GROSS, so the VAT line is already contained in
 * the subtotal and `subtotal + shipping + tax` overstates the total. A totals
 * block that summed its own rows would therefore be both wrong on screen and a
 * second, divergent implementation of pricing sitting in the view layer.
 *
 * WHICH LINES DISAPPEAR AT ZERO IS NOT SYMMETRIC, on purpose. A zero discount
 * and a zero refund are not rendered — "−0,00 €" beside "Descuento" makes a
 * customer hunt for money they never lost. A zero SHIPPING line is rendered,
 * because "Envío 0,00 €" is the good news that free delivery applied, and its
 * absence would read as a missing line rather than a waived charge.
 *
 * It carries no padding and no surface of its own. Its home is a `Card`, which
 * already owns `--card-p`, or a flush card section under an items table where
 * the table's own `--cell-px` must line up with it; a padded primitive inside a
 * padded card indents twice with nothing to say why.
 *
 * Server component. The labels arrive already translated, so nothing here reads
 * a message catalogue and nothing here needs a client boundary.
 */

export interface TotalsLine {
  /** Already translated. Never an enum member, never a server-written message. */
  readonly label: string;
  readonly amount: Minor;
}

/** Compact is the admin summary under a bordered table, comfortable the customer card. */
export type TotalsListDensity = "compact" | "comfortable";

interface DensityMetrics {
  /** Row gap and body type size for the five secondary lines. */
  readonly rows: string;
  /** The grand total's type size. Weight is Money's business, not the row's. */
  readonly total: string;
}

/**
 * Both pairs are the drawn values: 12/13 in the admin block under the items
 * table, 15/17 in the customer card. Neither rung is `--font-body` (13/17) —
 * the totals summary sits a step below the table it follows in the admin
 * density and a step below body copy in the customer one, which is a
 * typographic relationship inside this block rather than the shell's body size.
 */
const DENSITY: Readonly<Record<TotalsListDensity, DensityMetrics>> = {
  compact: { rows: "gap-x-6 gap-y-[3px] text-[12px]", total: "text-[13px]" },
  comfortable: { rows: "gap-x-6 gap-y-1.5 text-[15px]", total: "text-[17px]" },
};

export interface TotalsListProps {
  readonly currency: CurrencyCode;
  readonly subtotal: TotalsLine;
  /** Rendered as a deduction, and omitted entirely when the amount is zero. */
  readonly discount?: TotalsLine;
  /** Rendered even at zero: a waived shipping charge is information. */
  readonly shipping: TotalsLine;
  /**
   * VAT. Named for what it is so no call site can label it as an addition: the
   * amount is already inside `subtotal` and `total`, and the label must read
   * "IVA incluido" / "VAT included" rather than "IVA" — otherwise the block
   * invites the reader to add it a second time.
   */
  readonly taxIncluded: TotalsLine;
  readonly total: TotalsLine;
  /** Rendered as a deduction beneath the total, and omitted when zero. */
  readonly refunded?: TotalsLine;
  readonly density?: TotalsListDensity;
  readonly className?: string;
}

export function TotalsList({
  currency,
  subtotal,
  discount,
  shipping,
  taxIncluded,
  total,
  refunded,
  density = "comfortable",
  className,
}: TotalsListProps) {
  const metrics = DENSITY[density];

  return (
    // `grid-cols-[1fr_auto]` rather than a flex row per line: one grid means
    // every value shares a right edge, so the figures form a single column
    // instead of six independently-aligned pairs.
    <dl
      className={`m-0 grid grid-cols-[1fr_auto] ${metrics.rows}${
        className === undefined ? "" : ` ${className}`
      }`}
    >
      <Line line={subtotal} currency={currency} />
      <Deduction line={discount} currency={currency} />
      <Line line={shipping} currency={currency} />
      <Line line={taxIncluded} currency={currency} />

      {/* The grand total. Its SIZE is set here because size belongs to the row
          an amount sits in; its WEIGHT comes from Money's `emphasis`, which is
          the one thing Money does own. Splitting them that way is what lets the
          same figure render at 13px in the admin block and 17px here without
          either surface repeating a font-weight. */}
      <dt className={`font-semibold text-[var(--label)] ${metrics.total}`}>{total.label}</dt>
      <dd className={`m-0 text-right ${metrics.total}`}>
        <Money amount={total.amount} currency={currency} emphasis />
      </dd>

      <Deduction line={refunded} currency={currency} />
    </dl>
  );
}

interface LineProps {
  readonly line: TotalsLine;
  readonly currency: CurrencyCode;
}

/**
 * `m-0` on the `<dd>` is not decoration: the user-agent stylesheet indents a
 * definition-list value by 40px, which in a two-column grid pushes every figure
 * off its right edge.
 */
function Line({ line, currency }: LineProps) {
  return (
    <>
      <dt className="text-[var(--label-secondary)]">{line.label}</dt>
      <dd className="m-0 text-right">
        <Money amount={line.amount} currency={currency} />
      </dd>
    </>
  );
}

interface DeductionProps {
  readonly line: TotalsLine | undefined;
  readonly currency: CurrencyCode;
}

/**
 * A line that takes money OFF what was charged.
 *
 * The amount is normalised to its negative rather than trusted: the API returns
 * `discountTotal` and `refundedTotal` as non-negative magnitudes, but a caller
 * that had already negated one would otherwise render a discount that ADDS to
 * the bill. `negate(absolute(...))` is total over both spellings, and the sign
 * it produces then comes from the LOCALE's own negative currency pattern rather
 * than a hyphen glued onto the front of a formatted string — which is how a
 * hand-rolled `"-" + money(x)` lands the sign on the wrong side of "€49.90".
 */
function Deduction({ line, currency }: DeductionProps) {
  if (line === undefined || line.amount === 0) {
    return null;
  }

  return (
    <Line
      line={{ label: line.label, amount: negate(absolute(line.amount)) }}
      currency={currency}
    />
  );
}
